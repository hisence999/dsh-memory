/**
 * 多文件写入的 intent 记录与崩溃收敛。
 *
 * 设计依据：§12.1「实现契约」（R1.4 写死的唯一允许实现方式）：
 *  1. 多文件操作先在 `.state/` 落一份 `intent.json`：操作类型、目标文件清单、
 *     各文件的临时文件名、以及**回滚所需的原内容副本**；
 *  2. 落盘顺序由调用方（store）负责：数据文件 → `INDEX.md` → `.state/ids`；
 *  3. **删除 `intent.json` 就是提交点**（`commitIntent`）；
 *  4. **收敛点**：发现残留 intent 时前滚（临时文件仍在且内容可用 → `rename` 成目标）
 *     或回滚（临时文件已丢 → 用备份副本还原），然后删除并记 warn。
 *
 * 收敛的判定是**整个操作级**的，不是逐文件级的：只要有一个临时文件缺失，
 * 就说明"这次操作没走完"，按"全成或全败"（§12.1）整体回滚到旧版本；
 * 只有全部临时文件都在，才整体前滚到新版本。这样绝不会产出"一半新一半旧"的
 * 语义组合（`INDEX.md` 说有的条目、数据文件里没有）。
 *
 * 回滚依赖一条不变量（由 store 保证）：**备份文件不存在 ⟺ 该目标在操作开始前
 * 不存在**（见 `memory-files.backupFile`：原文件不存在时不生成备份，并清掉陈旧备份）。
 * 因此"备份缺失且目标存在"的回滚动作就是删除目标——它正是操作前的状态。
 *
 * 只依赖 `node:` 内置模块；除编程错误外不抛异常。
 */

import { copyFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdirp, readText, removeFile, writeAtomic, fingerprint } from './memory-files.js';

/** intent 文件相对 `memoryDir` 的路径（§3.5）。 */
export const INTENT_FILE = '.state/intent.json';

/**
 * @typedef {object} Warning
 * @property {string} code
 * @property {string} message
 * @property {string} [filePath]
 * @property {string} [id]
 */

/**
 * @typedef {object} IntentFileEntry
 * @property {string} path 目标文件
 * @property {string} tmpPath 已写好的新内容临时文件
 * @property {string} backupPath 原内容副本（回滚用）
 * @property {string} [beforeFingerprint] 目标**操作前**内容的指纹（由 `beginIntent` 落盘时补写）
 * @property {string} [afterFingerprint] 目标**操作后**内容的指纹（同上）
 */

/**
 * @typedef {object} IntentPayload
 * @property {1} version
 * @property {'batch'|'archive'|'restore'|'reindex'} op
 * @property {IntentFileEntry[]} files
 * @property {string} createdAt
 */

/**
 * @typedef {object} ConvergeResult
 * @property {false|'rolled-forward'|'rolled-back'} recovered
 * @property {Warning[]} warnings
 * @property {boolean} [degraded] 无法收敛时为 true（intent 保留，绝不静默覆盖）
 * @property {string} [intentPath]
 * @property {Array<{ path: string, action: 'forward'|'rollback' }>} [applied]
 */

/**
 * 落一份 intent 记录（**必须在任何 `rename` 之前**）。
 *
 * 走原子写：写 intent 的过程被杀，磁盘上要么没有 intent，要么是一份完整的 intent。
 *
 * 除调用方给的字段外，本函数还**为每个文件补写两枚指纹**（`beforeFingerprint` /
 * `afterFingerprint`）：它们是收敛点的安全前提——没有它们就无法判断"目标当前内容"
 * 究竟是旧版本、新版本，还是**收敛点之前的人工编辑**，于是只能用备份盲目覆盖。
 *
 * @param {string} memoryDir 记忆目录绝对路径
 * @param {IntentPayload} payload 操作类型 + 文件清单 + 回滚副本路径
 * @returns {Promise<{ ok: boolean, intentPath?: string, error?: string }>}
 */
export async function beginIntent(memoryDir, payload) {
  if (!isIntentPayload(payload)) {
    return {
      ok: false,
      error: 'intent 结构非法：需要 { version: 1, op, files: [{ path, tmpPath, backupPath }], createdAt }',
    };
  }

  const intentPath = path.join(memoryDir, INTENT_FILE);
  /** 补写指纹：目标当前内容 = 操作前内容（此时还没 rename），临时文件内容 = 操作后内容 */
  const files = [];
  for (const file of payload.files) {
    /** @type {IntentFileEntry} */
    const enriched = {
      path: file.path,
      tmpPath: file.tmpPath,
      backupPath: file.backupPath,
      beforeFingerprint: await fingerprintOf(file.path, fingerprint('')),
      afterFingerprint: await fingerprintOf(file.tmpPath, undefined),
    };
    if (enriched.afterFingerprint === null) delete enriched.afterFingerprint;
    if (enriched.beforeFingerprint === null) delete enriched.beforeFingerprint;
    files.push(enriched);
  }

  const content = `${JSON.stringify({ ...payload, files }, null, 2)}\n`;
  const written = await writeAtomic(intentPath, content);
  if (!written.ok) {
    return { ok: false, intentPath, error: written.error ?? written.code ?? '写入 intent 失败' };
  }
  return { ok: true, intentPath };
}

/**
 * 提交：**删除 intent 文件即提交**（§12.1 第 3 条）。
 *
 * 幂等：文件已不存在也算提交成功。
 *
 * @param {string} intentPath intent 文件绝对路径
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function commitIntent(intentPath) {
  const removed = await removeFile(intentPath);
  if (!removed.ok) return { ok: false, error: removed.error ?? '删除 intent 失败' };
  return { ok: true };
}

/**
 * 收敛点：发现残留 intent 就前滚或回滚，然后删除 intent 并记 warn。
 *
 * 调用时机由 store 负责（会话边界扫描、写入类工具执行前、显式重建）。
 * 没有残留 intent 时是纯读操作，返回 `{ recovered: false, warnings: [] }`。
 *
 * 无法收敛（intent 损坏/读不出/前滚回滚中途失败）时：**保留 intent、不动磁盘现状**，
 * 返回 `{ recovered:false, degraded:true, intentPath }` 并给出告警——由调用方整理成
 * §12.1 失败形态 3 的 `degraded` 错误（把 intent 路径一并报出）。
 *
 * @param {string} memoryDir 记忆目录绝对路径
 * @param {{ warn?: (warning: Warning) => void, info?: (message: string) => void }} [opts]
 * @returns {Promise<ConvergeResult>}
 */
export async function converge(memoryDir, opts = {}) {
  const { warn, info } = opts;
  const intentPath = path.join(memoryDir, INTENT_FILE);
  /** @type {Warning[]} */
  const warnings = [];

  if (!(await pathExists(intentPath))) {
    // 没有 intent 也不代表没有残留：崩在"写完临时文件、还没落 intent"的那个窗口里，
    // 临时文件是无主孤儿。顺手清扫（保守策略见 sweepStaleTemps），不影响返回值语义。
    const swept = await sweepStaleTemps(memoryDir, { warn, referenced: [] });
    return { recovered: false, warnings: swept };
  }

  const raw = await readText(intentPath);
  if (raw.error !== undefined) {
    return degradedResult(intentPath, `读取 intent 失败：${raw.error}`, warnings, warn);
  }
  if (raw.content.trim() === '') {
    return degradedResult(intentPath, 'intent.json 是空文件（疑似被截断）', warnings, warn);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw.content);
  } catch (error) {
    return degradedResult(intentPath, `intent.json 不是合法 JSON：${describeError(error)}`, warnings, warn);
  }
  if (!isIntentPayload(parsed)) {
    return degradedResult(intentPath, 'intent.json 结构非法（缺 version/op/files 或文件项字段不全）', warnings, warn);
  }

  const { files, op } = parsed;

  // 每个文件先判状态：旧版本（before）/ 新版本（after）/ 无法核对（unknown）
  /** @type {Array<{ file: IntentFileEntry, state: 'before'|'after'|'unknown', reason?: string }>} */
  const states = [];
  for (const file of files) {
    const state = await fileState(file);
    states.push({ file, ...state });
  }

  // 无法核对 → 绝不猜：保留 intent、保住磁盘现状，交人工处理（§12.1 失败形态 3）
  const unknown = states.filter((item) => item.state === 'unknown');
  if (unknown.length > 0) {
    const detail = unknown
      .map((item) => `${item.file.path}（${item.reason ?? '内容与新旧版本都不符'}）`)
      .join('；');
    const warning = {
      code: 'write-conflict',
      message: `检测到人工改动或无法核对的目标内容，已放弃自动收敛（绝不覆盖）：${detail}。intent 保留在 ${intentPath}，请人工确认后处理`,
      filePath: intentPath,
    };
    warnings.push(warning);
    warn?.(warning);
    return { recovered: false, warnings, intentPath, degraded: true };
  }

  /** @type {Array<{ path: string, action: 'forward'|'rollback' }>} */
  const applied = [];

  // 全部已是新版本 → 上次其实已完成落盘、只差"删除 intent"这一步：确认提交，绝不回滚已完成写入
  if (states.length === 0 || states.every((item) => item.state === 'after')) {
    const committedEarly = await commitIntent(intentPath);
    if (!committedEarly.ok) {
      return degradedResult(intentPath, `确认提交失败（删除 intent 失败）：${committedEarly.error ?? ''}`, warnings, warn);
    }
    await cleanupArtifacts(files, warnings, warn);
    for (const item of states) applied.push({ path: item.file.path, action: 'forward' });
    info?.(`上次操作已全部落盘，仅缺提交：已确认提交（${applied.length} 个文件保持新版本）`);
    const warning = {
      code: 'intent-recovered',
      message: `发现上次写入残留的 intent（op=${op}）：${applied.length} 个文件都已落盘完成、只差提交，已确认提交（不回滚已完成写入）`,
      filePath: intentPath,
    };
    warnings.push(warning);
    warn?.(warning);
    return { recovered: 'rolled-forward', warnings, applied, intentPath, degraded: false };
  }

  // 还没到新版本的文件：临时文件仍在就继续完成（前滚）
  const pending = states.filter((item) => item.state === 'before');
  const forwardReady = [];
  for (const item of pending) forwardReady.push(await isUsableFile(item.file.tmpPath));
  const canForward = forwardReady.every(Boolean);

  if (canForward) {
    for (const item of pending) {
      const done = await forwardFile(item.file);
      if (!done.ok) {
        return degradedResult(
          intentPath,
          `前滚失败（已前滚 ${applied.length} 个文件）：${item.file.path} → ${done.error ?? '未知原因'}`,
          warnings,
          warn,
        );
      }
      applied.push({ path: item.file.path, action: 'forward' });
    }
    info?.(`前滚完成：${applied.length} 个文件回到新版本`);
  } else {
    // 新内容已经拿不到了 → 整体回到旧版本（全成或全败）
    for (const item of states) {
      if (item.state !== 'after') continue; // 仍是旧版本的文件不需要动，避免无谓写入
      const done = await rollbackFile(item.file);
      if (!done.ok) {
        return degradedResult(
          intentPath,
          `回滚失败（已回滚 ${applied.length} 个文件）：${item.file.path} → ${done.error ?? '未知原因'}`,
          warnings,
          warn,
        );
      }
      applied.push({ path: item.file.path, action: 'rollback' });
    }
    info?.(`回滚完成：${applied.length} 个文件回到旧版本`);
  }

  // 收敛完成 → 删除 intent（提交点）。删不掉就不能算收敛成功：留着它，
  // 下一次收敛点会再走一遍（绝不会静默提交）。
  const committed = await commitIntent(intentPath);
  if (!committed.ok) {
    return degradedResult(intentPath, `收敛动作已完成但删除 intent 失败：${committed.error ?? ''}`, warnings, warn);
  }

  // 清理本次操作的临时文件与备份副本（尽力而为，失败只告警）。
  await cleanupArtifacts(files, warnings, warn);
  // 再扫一遍同目录里**不被任何 intent 引用**的陈旧产物（崩溃在落 intent 之前的孤儿）。
  const swept = await sweepStaleTemps(memoryDir, {
    warn,
    referenced: files.flatMap((file) => [file.tmpPath, file.backupPath]),
  });
  warnings.push(...swept);

  const recovered = canForward ? 'rolled-forward' : 'rolled-back';
  const summary = canForward ? '前滚到新版本' : '回滚到旧版本';
  const warning = {
    code: 'intent-recovered',
    message: `发现上次写入残留的 intent（op=${op}），已${summary}，涉及 ${applied.length}/${files.length} 个文件`,
    filePath: intentPath,
  };
  warnings.push(warning);
  warn?.(warning);
  return { recovered, warnings, applied, intentPath, degraded: false };
}

/**
 * 我们自己的临时产物命名：`.<原名>.<12 位十六进制>.tmp`（见 memory-files 的原子写）
 * 与同风格的 `.bak` 备份副本（见 store 的 beginIntent 调用点）。
 */
const ARTIFACT_RE = /^\..+\.[0-9a-f]{12}\.(?:tmp|bak)$/;

/**
 * 清扫**无主**的临时／备份产物。
 *
 * 崩溃可能发生在"写完临时文件"与"落 intent 记录"之间，留下一份没有任何 intent 引用的孤儿文件。
 * 它们不影响解析与内容，但会一直堆积。清扫必须保守，三条同时满足才删：
 *   1. 文件名匹配我们自己的产物命名（绝不碰用户的正常文件）；
 *   2. mtime 早于 `staleMs`（默认 10 分钟，避免误删正在并发写的进程的临时文件）；
 *   3. 不在本次 intent 的引用集合里。
 * 任何失败都只记 warn，绝不影响主流程。
 *
 * @param {string} memoryDir
 * @param {{ warn?: (warning: Warning) => void, staleMs?: number, referenced?: string[] }} [opts]
 * @returns {Promise<Warning[]>}
 */
export async function sweepStaleTemps(memoryDir, opts = {}) {
  const { warn, staleMs = 600_000, referenced = [] } = opts;
  /** @type {Warning[]} */
  const warnings = [];
  const keep = new Set(referenced);
  const now = Date.now();

  for (const dir of [memoryDir, path.join(memoryDir, 'archive')]) {
    /** @type {string[]} */
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!ARTIFACT_RE.test(name)) continue;
      const full = path.join(dir, name);
      if (keep.has(full)) continue;
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        if (now - info.mtimeMs < staleMs) continue;
        await unlink(full);
        const warning = {
          code: 'stale-tmp-swept',
          message: `清理了无 intent 引用的陈旧产物 ${name}（崩溃残留，不影响内容）`,
          filePath: full,
        };
        warnings.push(warning);
        warn?.(warning);
      } catch {
        // 清扫是尽力而为：失败不记错误、不阻塞任何操作
      }
    }
  }
  return warnings;
}

/**
 * 前滚单个文件：`rename` 临时文件成目标（§12.1 收敛点）。
 *
 * @param {IntentFileEntry} file
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function forwardFile(file) {
  const ensured = await mkdirp(path.dirname(file.path));
  if (!ensured.ok) return { ok: false, error: `创建目录失败：${ensured.error}` };
  try {
    await rename(file.tmpPath, file.path);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * 判定一个目标文件当前处于哪个版本（收敛点的**安全前提**）。
 *
 *  - `before`：内容等于"操作前"（或原本不存在且现在仍不存在）→ 不需要动它；
 *  - `after` ：内容等于"操作后"（新版本）→ 需要时可用备份还原；
 *  - `unknown`：两者都不是（最典型的是**收敛点之前有人手工编辑过**）→ 绝不覆盖。
 *
 * "操作前内容"优先取 intent 记录的 `beforeFingerprint`，缺失时退化为读备份文件
 * （备份不存在即表示目标原本不存在）；"操作后内容"优先取记录的 `afterFingerprint`，
 * 缺失时退化为读临时文件（还在就能算出来）。
 *
 * @param {IntentFileEntry} file
 * @returns {Promise<{ state: 'before'|'after'|'unknown', reason?: string }>}
 */
async function fileState(file) {
  const before = await beforeFingerprintOf(file);
  const after = await afterFingerprintOf(file);
  const target = await readTarget(file.path);

  if (!target.exists) {
    // 目标不存在：只有"原本也不存在"才算旧版本；有备份却不见了说明被外部删掉，不能猜
    if (before === fingerprint('')) return { state: 'before' };
    return { state: 'unknown', reason: '目标文件已不存在，但 intent 记录它原本存在' };
  }
  if (target.content === null) return { state: 'unknown', reason: '目标文件读不出来' };
  const current = fingerprint(target.content);
  if (after !== null && current === after) return { state: 'after' };
  if (before !== null && current === before) return { state: 'before' };
  return {
    state: 'unknown',
    reason:
      after === null
        ? 'intent 未记录新内容指纹，且临时文件已丢失，无法核对目标内容'
        : '目标内容既不是旧版本也不是新版本（疑似人工编辑）',
  };
}

/**
 * "操作前"内容指纹：优先 intent 记录，其次备份文件，最后"原本不存在"。
 *
 * @param {IntentFileEntry} file
 * @returns {Promise<string|null>}
 */
async function beforeFingerprintOf(file) {
  if (typeof file.beforeFingerprint === 'string') return file.beforeFingerprint;
  if (!(await isUsableFile(file.backupPath))) return fingerprint('');
  const raw = await readText(file.backupPath);
  return raw.error === undefined ? fingerprint(raw.content) : null;
}

/**
 * "操作后"内容指纹：优先 intent 记录，其次仍在的临时文件。
 *
 * @param {IntentFileEntry} file
 * @returns {Promise<string|null>}
 */
async function afterFingerprintOf(file) {
  if (typeof file.afterFingerprint === 'string') return file.afterFingerprint;
  if (!(await isUsableFile(file.tmpPath))) return null;
  const raw = await readText(file.tmpPath);
  return raw.error === undefined ? fingerprint(raw.content) : null;
}

/**
 * 读目标内容；文件不存在与读不出来是两件事。
 *
 * @param {string} filePath
 * @returns {Promise<{ exists: boolean, content: string|null }>}
 */
async function readTarget(filePath) {
  if (!(await pathExists(filePath))) return { exists: false, content: null };
  const raw = await readText(filePath);
  return { exists: true, content: raw.error === undefined ? raw.content : null };
}

/**
 * 读一份内容并算指纹；读不出来返回 `fallback`（`undefined` 表示"未知"）。
 *
 * @param {string} filePath
 * @param {string|undefined} fallback
 * @returns {Promise<string|undefined>}
 */
async function fingerprintOf(filePath, fallback) {
  if (!(await isUsableFile(filePath))) return fallback;
  const raw = await readText(filePath);
  return raw.error === undefined ? fingerprint(raw.content) : fallback;
}

/**
 * 回滚单个文件：有备份就用备份还原（先写同目录临时文件再 `rename`，避免半截文件），
 * 没有备份说明目标原本不存在，则删掉它。
 *
 * 调用前 `fileState` 已确认目标处于"新版本"，因此这里不会覆盖无法核对的内容。
 *
 * @param {IntentFileEntry} file
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function rollbackFile(file) {
  if (await isUsableFile(file.backupPath)) {
    return replaceWith(file.backupPath, file.path);
  }
  const removed = await removeFile(file.path);
  if (!removed.ok) return { ok: false, error: `删除新建文件失败：${removed.error ?? ''}` };
  return { ok: true };
}

/**
 * 用 `sourcePath` 的内容原子替换 `targetPath`。
 *
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function replaceWith(sourcePath, targetPath) {
  const dir = path.dirname(targetPath);
  const ensured = await mkdirp(dir);
  if (!ensured.ok) return { ok: false, error: `创建目录失败：${ensured.error}` };

  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.restore.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await copyFile(sourcePath, tmpPath);
    await rename(tmpPath, targetPath);
    return { ok: true };
  } catch (error) {
    await removeFile(tmpPath);
    return { ok: false, error: describeError(error) };
  }
}

/**
 * 清理本次 intent 的临时文件与备份副本。
 *
 * @param {IntentFileEntry[]} files
 * @param {Warning[]} warnings
 * @param {((warning: Warning) => void)|undefined} warn
 * @returns {Promise<void>}
 */
async function cleanupArtifacts(files, warnings, warn) {
  for (const file of files) {
    for (const artifact of [file.tmpPath, file.backupPath]) {
      const removed = await removeFile(artifact);
      if (!removed.ok) {
        const warning = {
          code: 'intent-recovered',
          message: `清理 intent 的临时/备份文件失败（不影响记忆内容）：${artifact}`,
          filePath: artifact,
        };
        warnings.push(warning);
        warn?.(warning);
      }
    }
  }
}

/**
 * 无法收敛时的统一返回：保留 intent，报出路径与原因，绝不静默覆盖。
 *
 * @param {string} intentPath
 * @param {string} reason
 * @param {Warning[]} warnings
 * @param {((warning: Warning) => void)|undefined} warn
 * @returns {ConvergeResult}
 */
function degradedResult(intentPath, reason, warnings, warn) {
  const warning = {
    code: 'intent-recovered',
    message: `${reason}；无法收敛，磁盘现状与 intent 均保持原样，请人工确认后续处理`,
    filePath: intentPath,
  };
  warnings.push(warning);
  warn?.(warning);
  return { recovered: false, warnings, intentPath, degraded: true };
}

/**
 * 文件存在且是普通文件（"内容可用"的判定：目录、符号链接目标不存在都不算）。
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isUsableFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is IntentPayload}
 */
function isIntentPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = /** @type {Record<string, unknown>} */ (value);
  if (payload.version !== 1) return false;
  if (typeof payload.op !== 'string') return false;
  if (!Array.isArray(payload.files)) return false;
  return payload.files.every((entry) => isIntentFileEntry(entry));
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isIntentFileEntry(value) {
  if (typeof value !== 'object' || value === null) return false;
  const entry = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof entry.path === 'string' && typeof entry.tmpPath === 'string' && typeof entry.backupPath === 'string'
  );
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
