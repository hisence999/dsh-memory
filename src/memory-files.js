/**
 * 记忆文件的底层 IO 原语：读取降级、原子写、幂等建文件、按路径串行队列、目录与备份。
 *
 * 设计依据：§12.1（同目录临时文件 + `rename` 原子替换）、§12.2（写前比对指纹，
 * 发现人工改动就放弃旧快照，绝不覆盖）、§12.3（读失败按"无内容"降级，记忆坏掉
 * 不能拖垮会话）；手册 §8.2（原子替换 / `wx` 幂等 / 同一路径串行队列 / 读失败按
 * 无内容处理）。
 *
 * 纪律：
 *  1. 只依赖 `node:` 内置模块（工程约定 §0.1），不 import 任何宿主包；
 *  2. 除编程错误外不抛异常：失败一律以 `{ ok:false, code?, error? }` 返回，
 *     调用方（store）负责把它整理成面向人的错误；
 *  3. 同目录临时文件名带随机后缀，因此并发写同一目标不会互相踩临时文件。
 */

import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

/** 临时文件扩展名：`rename` 之前承载新内容。 */
const TMP_EXT = '.tmp';

/** 进程内按 key（通常是绝对路径）串行的任务链尾。 */
/** @type {Map<string, Promise<unknown>>} */
const pathQueues = new Map();

/**
 * @typedef {object} ReadTextResult
 * @property {string} content 文件内容；读失败或文件不存在时为 `''`
 * @property {string} [error] 读失败原因；**文件不存在不算失败**，不返回该字段
 */

/**
 * @typedef {object} WriteResult
 * @property {boolean} ok
 * @property {'write_conflict'|'io_error'} [code] `write_conflict` = 指纹不符；`io_error` = 环境失败
 * @property {string} [error] 面向人的失败说明
 */

/**
 * 读取文本文件。
 *
 * **读失败一律按"无内容"处理并返回 `error`，绝不抛异常**（手册 §8.2）：记忆读失败
 * 绝不能拖垮会话创建或模型轮次，调用方按降级路径继续即可。
 * 换行统一为 `\n`（`\r\n` 与孤立 `\r` 都归一），这样"内容指纹"只反映语义变化，
 * 不会被 Windows 编辑器的换行差异误判成人工改动。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {{ signal?: AbortSignal }} [opts] `signal` 用于中止读取（可选）
 * @returns {Promise<ReadTextResult>}
 */
export async function readText(filePath, opts = {}) {
  try {
    const raw = await readFile(filePath, { encoding: 'utf8', signal: opts.signal });
    return { content: normalizeNewlines(raw) };
  } catch (error) {
    // 文件不存在是正常状态（首次使用、尚未落盘），不是降级。
    if (isErrorCode(error, 'ENOENT')) return { content: '' };
    return { content: '', error: describeError(error) };
  }
}

/**
 * 内容指纹：sha256 十六进制前 16 位。
 *
 * 用途是"写前比对"（§12.2）：发现磁盘内容与调用方快照不一致就返回 `write_conflict`，
 * 由调用方重读重试（最多两次），**绝不覆盖人工修改**。
 *
 * @param {string} content
 * @returns {string} 16 位小写十六进制
 */
export function fingerprint(content) {
  const text = typeof content === 'string' ? content : String(content);
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 原子写：同目录临时文件 + `rename` 覆盖目标（§12.1 第 1 条）。
 *
 * 进程在写入中途被杀不会留下半截文件——目标要么是旧版本，要么是新版本。
 * 父目录不存在时自动创建（`mkdir -p`）。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {string} content 新内容
 * @param {{ expectedFingerprint?: string, signal?: AbortSignal }} [opts]
 *        `expectedFingerprint`：写前读现状比对指纹，不符返回 `write_conflict`
 * @returns {Promise<WriteResult>}
 */
export async function writeAtomic(filePath, content, opts = {}) {
  const { expectedFingerprint, signal } = opts;

  if (isAborted(signal)) return abortResult();

  if (expectedFingerprint !== undefined) {
    const current = await readText(filePath, { signal });
    if (current.error !== undefined) {
      // 读不出来就无法安全比对，宁可失败也不写（§12.3「写入中途状态不确定 → 不静默覆盖」）。
      return { ok: false, code: 'io_error', error: `写入前读取现状失败：${current.error}` };
    }
    const actual = fingerprint(current.content);
    if (actual !== expectedFingerprint) {
      return {
        ok: false,
        code: 'write_conflict',
        error: `文件在读取后已被改动（期望指纹 ${expectedFingerprint}，实际 ${actual}）`,
      };
    }
  }

  const dir = path.dirname(filePath);
  const ensured = await mkdirp(dir);
  if (!ensured.ok) return { ok: false, code: 'io_error', error: `创建目录失败：${ensured.error}` };

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}${TMP_EXT}`);
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', signal });
    if (isAborted(signal)) {
      await removeFile(tmpPath);
      return abortResult();
    }
    await rename(tmpPath, filePath);
    return { ok: true };
  } catch (error) {
    await removeFile(tmpPath);
    return { ok: false, code: 'io_error', error: describeError(error) };
  }
}

/**
 * 幂等建文件：`writeFile(..., { flag: 'wx' })`，已存在即 no-op（手册 §8.2）。
 *
 * 多会话并发首次使用同一项目时，只有一个会真正创建骨架，其余读到的就是已存在的文件。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {string} content 文件不存在时写入的初始内容
 * @returns {Promise<{ created: boolean, error?: string }>}
 */
export async function ensureFile(filePath, content) {
  const ensured = await mkdirp(path.dirname(filePath));
  if (!ensured.ok) return { created: false, error: `创建目录失败：${ensured.error}` };

  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return { created: true };
  } catch (error) {
    // 已存在：幂等成功，**不覆盖**既有内容。
    if (isErrorCode(error, 'EEXIST')) return { created: false };
    return { created: false, error: describeError(error) };
  }
}

/**
 * 同一 key 的异步任务串行（进程内），避免同轮多次调用造成 read-modify-write 竞争
 * （手册 §8.2）。key 惯例用目标文件绝对路径。
 *
 * 前一个任务失败不会阻塞后一个（`then(fn, fn)`），失败只由各自调用方处理。
 *
 * @template T
 * @param {string} key 串行键，通常为绝对路径
 * @param {() => Promise<T>} fn 任务
 * @returns {Promise<T>} 任务本身的返回值
 */
export async function withPathQueue(key, fn) {
  /** @type {Promise<unknown>} */
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  pathQueues.set(key, settled);
  // 链尾静默后清理键，避免长期运行下 Map 无界增长。
  settled.then(() => {
    if (pathQueues.get(key) === settled) pathQueues.delete(key);
  });
  return next;
}

/**
 * 列出目录下的条目名（不递归，含子目录名）。
 *
 * 目录不存在或读不了都返回 `[]`（§12.3：整目录读失败按"没有记忆"降级）。
 * 结果按码位升序排序，保证同一目录内容产出稳定顺序。
 *
 * @param {string} dir 目录绝对路径
 * @returns {Promise<string[]>}
 */
export async function listDir(dir) {
  try {
    const names = await readdir(dir);
    return names.slice().sort(compareNames);
  } catch {
    return [];
  }
}

/**
 * 递归创建目录（`mkdir -p`）。
 *
 * @param {string} dir 目录绝对路径
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function mkdirp(dir) {
  try {
    await mkdir(dir, { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * 备份原内容（intent 回滚用）：字节级复制到 `backupPath`。
 *
 * 原文件不存在时返回 `{ ok:true, existed:false }` 并**清掉可能残留的同名旧备份**——
 * 否则上一次操作的陈旧备份会被本轮的收敛逻辑误当成"原内容"。此时回滚语义是
 * "把目标删掉"（原本就不存在）。
 *
 * @param {string} filePath 原文件绝对路径
 * @param {string} backupPath 备份文件绝对路径
 * @returns {Promise<{ ok: boolean, existed: boolean, error?: string }>} `existed` = 是否真的备份了内容
 */
export async function backupFile(filePath, backupPath) {
  const ensured = await mkdirp(path.dirname(backupPath));
  if (!ensured.ok) return { ok: false, existed: false, error: `创建目录失败：${ensured.error}` };

  try {
    await copyFile(filePath, backupPath);
    return { ok: true, existed: true };
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      await removeFile(backupPath);
      return { ok: true, existed: false };
    }
    return { ok: false, existed: false, error: describeError(error) };
  }
}

/**
 * 删除单个文件（仅用于 intent 的临时文件与备份文件）。
 *
 * 幂等：文件不存在也算成功（`existed:false`）。
 *
 * @param {string} filePath 目标文件绝对路径
 * @returns {Promise<{ ok: boolean, existed: boolean, error?: string }>}
 */
export async function removeFile(filePath) {
  try {
    await unlink(filePath);
    return { ok: true, existed: true };
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return { ok: true, existed: false };
    return { ok: false, existed: false, error: describeError(error) };
  }
}

/**
 * 换行归一：`\r\n` 与孤立 `\r` 都变成 `\n`。
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeNewlines(content) {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 码位升序比较（不依赖 locale，保证跨环境稳定）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareNames(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
function isAborted(signal) {
  return signal !== undefined && signal.aborted;
}

/** @returns {WriteResult} */
function abortResult() {
  return { ok: false, code: 'io_error', error: '写入已中止（AbortSignal）' };
}

/**
 * 判断错误码。
 *
 * @param {unknown} error
 * @param {string} code
 * @returns {boolean}
 */
function isErrorCode(error, code) {
  if (typeof error !== 'object' || error === null) return false;
  return /** @type {{ code?: unknown }} */ (error).code === code;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
