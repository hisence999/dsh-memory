/**
 * store —— **唯一的写入入口**（§3.9）。装配层的会话边界写回与四个写入类工具都走这里。
 *
 * 职责（其他模块不要重复实现）：目录创建、跨进程锁、intent/收敛、编号补发与水位线落盘、
 * `INDEX.md` 写入、`usage` 落盘、把 §7.6 的校验失败整理成错误对象。
 *
 * 实现契约（设计 §12.1，唯一允许的实现方式）：
 *  1. 单文件写入 = 同目录临时文件 + `rename`；写前比对指纹（§12.2），不符即
 *     "放弃旧快照 → 重读 → 重新校验 → 重试"，**最多两次**；
 *  2. 多文件操作 = 先写临时文件与备份 → 落 `.state/intent.json` → 按固定顺序
 *     `rename`（数据文件 → `INDEX.md` → `.state/ids`）→ **删除 intent 即提交**；
 *  3. 进程存活期内任何失败都必须回到原样（靠 intent 回滚）；进程被杀允许"已生效子集"，
 *     但每个文件都是语义完整的旧版或新版，并由下一个收敛点前滚/回滚；
 *  4. 连收敛都做不到 → 返回 `degraded` 并报出 intent 路径，**绝不静默覆盖**。
 *
 * 扫描与写回时机（§6.1）：补编号、重复编号修复、`.state/ids` 落盘只允许发生在
 * ① 会话边界建快照（`syncAtBoundary`）② 写入类工具执行前（`applyBatch`）
 * ③ 显式重建（`rebuildIndex`）这三类动作里；读路径（`loadProject`）只报告、不改文件。
 *
 * 只依赖 `node:` 内置模块与本项目模块（工程约定 §0.1）。
 */

import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { backupFile, fingerprint, listDir, mkdirp, readText, removeFile, withPathQueue } from './memory-files.js';
import { acquireLock } from './lock.js';
import { INTENT_FILE, beginIntent, commitIntent, converge } from './intent.js';
import { allocate, formatId, parseId, repairDuplicates, watermark } from './ids.js';
import { STATE_DIR, bumpUsage, loadState, saveState } from './state.js';
import { isOverlength, readIndexNote, renderIndex } from './index-md.js';
import {
  CONFIDENCES,
  KINDS,
  LABEL_KIND,
  PRIORITIES,
  defaultPriority,
  fileDateOf,
  makeJournalId,
  parseJournalFile,
  parseMemoryFile,
  renderJournalFile,
  renderMemoryFile,
  normalize,
  splitList,
  timeLocal,
  todayLocal,
} from './parse.js';

// ────────────────────────────── 常量 ──────────────────────────────

/** 人类视图（可重建派生物）。 */
const INDEX_FILE = 'INDEX.md';

/** 归档子目录。 */
const ARCHIVE_DIR = 'archive';

/** 跨进程锁文件（相对 `memoryDir`）。 */
const LOCK_FILE = '.state/lock';

/** 活动/归档长期记忆文件名。 */
const MEMORY_FILE_RE = /^M-\d{4}-\d{2}-\d{2}\.md$/;

/** 日志文件名。 */
const JOURNAL_FILE_RE = /^JOURNAL-\d{4}-\d{2}-\d{2}\.md$/;

/** §12.2：自动重试最多两次。 */
const MAX_WRITE_RETRY = 2;

/** @typedef {import('./parse.js').Entry} Entry */
/** @typedef {import('./parse.js').JournalEntry} JournalEntry */
/** @typedef {import('./parse.js').Warning} Warning */

/**
 * @typedef {object} Config 配置（`resolveConfig` 的输出）
 * @property {string} memoryDirName
 * @property {number} maxTitleChars
 * @property {number} detailMaxChars
 * @property {number} itemMaxChars
 * @property {number} lockTimeoutMs
 * @property {number} staleLockMs
 */

/**
 * @typedef {object} ProjectModel
 * @property {string} projectRoot
 * @property {string} memoryDir
 * @property {Entry[]} entries
 * @property {Entry[]} active
 * @property {Entry[]} archived
 * @property {JournalEntry[]} journals
 * @property {number} nextId
 * @property {Record<string, {count: number, lastUsedAt: string}>} usage
 * @property {Warning[]} warnings
 */

/**
 * @typedef {object} Validators 由调用方（tools-layer）注入的可选校验器
 *         —— 校验规则本身住在 `dedup.js`/`sensitive.js`，store 只调用，不重复实现。
 * @property {(title: string, entries: Entry[], ctx: { today: string }) => ({ id: string }|null)} [findDuplicate]
 * @property {(title: string, entries: Entry[], ctx: { today: string }) => Array<{ id: string, reason: string }>} [findSimilar]
 * @property {(candidate: object, entries: Entry[], ctx: { today: string, excludeIds: string[] }) => Array<{ id: string, reason: string }>} [findConflicts]
 * @property {(parts: { title: string, detail: string, tags: string[], aliases: string[] }) => Array<{ field: string, category: string }>} [scanEntryTexts]
 */

/**
 * @typedef {object} VFile 内存中的记忆文件（提交时才渲染成文本）
 * @property {string} path
 * @property {string} original 磁盘上的原文（换行已归一）
 * @property {string} content 提交时渲染出的文本
 * @property {Entry[]} entries
 * @property {string} fileDate
 * @property {string[]} preamble
 */

/**
 * @typedef {object} VJournal 内存中的日志文件（追加语义：保留人工写的其它内容）
 * @property {string} path
 * @property {string} original
 * @property {string} content
 * @property {Set<string>} takenIds
 */

/**
 * @typedef {object} ApplyError §7.6 错误对象
 * @property {false} ok
 * @property {string} code
 * @property {string} message
 * @property {string} nextStep
 * @property {number} [entryIndex]
 */

/**
 * @typedef {object} CommitSuccess
 * @property {true} ok
 * @property {string[]} paths
 * @property {Warning[]} warnings
 */

/**
 * @typedef {object} CommitFailure
 * @property {false} ok
 * @property {string} code
 * @property {string} message
 * @property {string} nextStep
 * @property {Warning[]} warnings
 * @property {string} [conflictPath]
 */

/**
 * @typedef {object} BatchResult 一次批量写入的结果（§3.9）
 * @property {string[]} assignedIds
 * @property {string[]} archived
 * @property {string[]} restored
 * @property {string[]} journalIds
 * @property {string[]} paths
 * @property {Array<{ id: string, reason: string, entryIndex: number }>} similar
 *           高度相似提示（§7.1：不拒绝，只提示；调用方负责写进返回文本）——**附加字段**
 */

/**
 * @typedef {object} BatchSuccess
 * @property {true} ok
 * @property {BatchResult} result
 * @property {Warning[]} warnings
 */

/** @typedef {ApplyError & { warnings: Warning[] }} BatchFailure */

/**
 * @typedef {object} RebuildSuccess
 * @property {true} ok
 * @property {boolean} wrote
 * @property {string} index
 * @property {Warning[]} warnings
 */

/** @typedef {ApplyError & { warnings: Warning[] }} RebuildFailure */

// ────────────────────────── 纯工具函数 ──────────────────────────

/**
 * 项目里是否已经有记忆内容（记忆文件 / 日志 / `INDEX.md`）。
 *
 * 用来区分"这个项目在用记忆"和"这个项目还没碰过记忆"：后者不做任何写入，
 * 免得在每个打开过的项目里凭空造出 `memory/`。
 *
 * @param {string} memoryDir
 * @returns {Promise<boolean>}
 */
async function hasMemoryContent(memoryDir) {
  const names = await listDir(memoryDir);
  if (names.some((name) => MEMORY_FILE_RE.test(name) || JOURNAL_FILE_RE.test(name) || name === INDEX_FILE)) return true;
  const archived = await listDir(path.join(memoryDir, ARCHIVE_DIR));
  return archived.some((name) => MEMORY_FILE_RE.test(name));
}

/**
 * 项目根 = 会话工作区根目录（设计 §2.1：**不向上搜 `.git`**）；记忆目录固定为
 * `<项目根>/<memoryDirName>/`。
 *
 * @param {string} workspace
 * @param {Config|undefined} config
 * @returns {{ projectRoot: string, memoryDir: string }}
 */
function projectPaths(workspace, config) {
  const projectRoot = path.resolve(typeof workspace === 'string' && workspace.length > 0 ? workspace : process.cwd());
  const dirName =
    config !== undefined && typeof config.memoryDirName === 'string' && config.memoryDirName.length > 0
      ? config.memoryDirName
      : 'memory';
  return { projectRoot, memoryDir: path.join(projectRoot, dirName) };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [filePath]
 * @param {string} [id]
 * @returns {Warning}
 */
function warn(code, message, filePath, id) {
  /** @type {Warning} */
  const item = { code, message };
  if (filePath !== undefined) item.filePath = filePath;
  if (id !== undefined) item.id = id;
  return item;
}

/**
 * §7.6 的错误对象（模型可见：做了什么 / 结果如何 / 下一步建议）。
 *
 * @param {string} code
 * @param {string} message
 * @param {string} nextStep
 * @param {number} [entryIndex]
 * @returns {ApplyError}
 */
function errorObject(code, message, nextStep, entryIndex) {
  /** @type {ApplyError} */
  const error = { ok: false, code, message, nextStep };
  if (entryIndex !== undefined) error.entryIndex = entryIndex;
  return error;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isArchivedPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return /(^|[\\/])archive([\\/]|$)/.test(filePath);
}

/**
 * 提交顺序（§12.1）：数据文件（`M-*.md` / `archive/M-*.md` / `JOURNAL-*.md`）→ `INDEX.md`
 * → `.state/ids`。中间态因此永远可以由"数据文件 + 重跑一次重建"收敛。
 *
 * @param {{ path: string }} target
 * @returns {number}
 */
function commitRank(target) {
  const base = path.basename(target.path);
  if (base === INDEX_FILE) return 1;
  if (base === 'ids' && path.basename(path.dirname(target.path)) === STATE_DIR) return 2;
  return 0;
}

/**
 * 字符串数组（容忍逗号分隔的字符串：人工与工具都可能给）。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.length > 0);
  if (typeof value === 'string' && value.trim().length > 0) return splitList(value);
  return [];
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
function isRestorableStatus(status) {
  return status === 'active' || status === 'candidate' || status === 'superseded';
}

/**
 * @param {{ presentFields: string[] }} entry
 * @param {string} name
 */
function ensurePresent(entry, name) {
  if (!entry.presentFields.includes(name)) entry.presentFields.push(name);
}

/**
 * @param {Entry} entry
 * @param {string} name
 */
function removePresent(entry, name) {
  entry.presentFields = entry.presentFields.filter((item) => item !== name);
}

/**
 * @param {Array<{ order: number }>} entries
 * @returns {number}
 */
function nextOrder(entries) {
  let max = -1;
  for (const entry of entries) if (typeof entry.order === 'number' && entry.order > max) max = entry.order;
  return max + 1;
}

/**
 * 条目排序：归属日期升序 → 归档在后 → 路径 → 文件内出现顺序。
 *
 * @param {Entry} a
 * @param {Entry} b
 * @returns {number}
 */
function compareEntries(a, b) {
  if (a.fileDate !== b.fileDate) return a.fileDate < b.fileDate ? -1 : 1;
  const archivedA = isArchivedPath(a.filePath) ? 1 : 0;
  const archivedB = isArchivedPath(b.filePath) ? 1 : 0;
  if (archivedA !== archivedB) return archivedA - archivedB;
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  return a.order - b.order;
}

/**
 * @param {VFile} a
 * @param {VFile} b
 * @returns {number}
 */
function compareVFiles(a, b) {
  const archivedA = isArchivedPath(a.path) ? 1 : 0;
  const archivedB = isArchivedPath(b.path) ? 1 : 0;
  if (archivedA !== archivedB) return archivedA - archivedB;
  if (a.fileDate !== b.fileDate) return a.fileDate < b.fileDate ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * 渲染一条日志分节（复用 `parse.renderJournalFile` 的渲染，保证字段转义口径一致）。
 *
 * @param {JournalEntry} entry
 * @param {string} today
 * @returns {string}
 */
function renderJournalSection(entry, today) {
  const lines = renderJournalFile(today, [entry]).split('\n');
  // 去掉 H1 与其后的空行
  while (lines.length > 0 && (lines[0] === '' || lines[0].startsWith('# 项目日志'))) lines.shift();
  return lines.join('\n').trimEnd();
}

/**
 * 日志追加：保留原文（含人工写的其它内容），在末尾追加新分节。
 *
 * @param {string} original
 * @param {string} today
 * @param {JournalEntry[]} entries
 * @returns {string}
 */
function appendJournal(original, today, entries) {
  const body = entries.map((entry) => renderJournalSection(entry, today)).join('\n\n');
  const header = `# 项目日志 · ${today}`;
  if (original.trim().length === 0) return `${header}\n\n${body}\n`;
  if (original.includes(header)) return `${original.trimEnd()}\n\n${body}\n`;
  return `${header}\n\n${original.trimEnd()}\n\n${body}\n`;
}

// ────────────────────────── 读：loadProject ──────────────────────────

/**
 * 读取整个项目模型：扫描活动/归档记忆、日志、`.state/`，隔离损坏并派生告警。
 *
 * **只读**：不创建目录、不改文件（§6.1：注入路径只读；`memory_search` 也走这里）。
 * 发现问题只进 `warnings`（§12.3：降级告警必须出现在工具返回里）。
 *
 * @param {{ workspace: string, config: Config }} params
 * @returns {Promise<ProjectModel>}
 */
export async function loadProject({ workspace, config }) {
  const { projectRoot, memoryDir } = projectPaths(workspace, config);
  /** @type {Warning[]} */
  const warnings = [];

  /** @type {Entry[]} */
  const entries = [];
  const memoryFilePaths = [
    ...(await listDir(memoryDir)).filter((name) => MEMORY_FILE_RE.test(name)).map((name) => path.join(memoryDir, name)),
    ...(await listDir(path.join(memoryDir, ARCHIVE_DIR)))
      .filter((name) => MEMORY_FILE_RE.test(name))
      .map((name) => path.join(memoryDir, ARCHIVE_DIR, name)),
  ].sort();

  for (const filePath of memoryFilePaths) {
    const raw = await readText(filePath);
    if (raw.error !== undefined) {
      warnings.push(warn('parse-damaged', `读取记忆文件失败，已跳过该文件：${raw.error}`, filePath));
      continue;
    }
    const parsed = parseMemoryFile(raw.content, filePath);
    warnings.push(...parsed.warnings);
    entries.push(...parsed.entries);
  }
  entries.sort(compareEntries);

  const active = entries.filter((entry) => !isArchivedPath(entry.filePath));
  const archived = entries.filter((entry) => isArchivedPath(entry.filePath));

  /** @type {JournalEntry[]} */
  const journals = [];
  const journalFilePaths = (await listDir(memoryDir))
    .filter((name) => JOURNAL_FILE_RE.test(name))
    .map((name) => path.join(memoryDir, name));
  for (const filePath of journalFilePaths) {
    const raw = await readText(filePath);
    if (raw.error !== undefined) {
      warnings.push(warn('parse-damaged', `读取日志文件失败，已跳过该文件：${raw.error}`, filePath));
      continue;
    }
    const parsed = parseJournalFile(raw.content, filePath);
    warnings.push(...parsed.warnings);
    journals.push(...parsed.entries);
  }
  journals.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));

  const state = await loadState(memoryDir);
  warnings.push(...state.warnings);

  const indexPath = path.join(memoryDir, INDEX_FILE);
  const indexRaw = await readText(indexPath);
  if (indexRaw.error !== undefined) {
    warnings.push(warn('index-rebuilt', `读取 INDEX.md 失败，将按活动记忆重建：${indexRaw.error}`, indexPath));
  }
  const indexNote = readIndexNote(indexRaw.content);

  const nextId = watermark({
    idsFileContent: state.ids === null ? '' : String(state.ids),
    indexNote,
    activeIds: active.map((entry) => entry.id),
    archivedIds: archived.map((entry) => entry.id),
  });

  warnings.push(...diagnoseScan({ active, entries, nextId, storedIds: state.ids, indexNote, config, indexText: indexRaw.content }));

  return { projectRoot, memoryDir, entries, active, archived, journals, nextId, usage: state.usage, warnings };
}

/**
 * 扫描期诊断（只报告，不改文件）：重复编号、手工超限、水位线注记不一致、两处水位线双丢失、
 * **新增的置顶标记**（§14.64：置顶是纯人工字段，本插件的工具永不写它，所以"新增"只可能来自
 * 人工编辑或模型用通用文件工具越权改文件——两种都必须告警，但不擅自回退人工意图）。
 *
 * @param {{ active: Entry[], entries: Entry[], nextId: number, storedIds: number|null, indexNote: number|null, config: Config, indexText?: string }} input
 * @returns {Warning[]}
 */
function diagnoseScan({ active, entries, nextId, storedIds, indexNote, config, indexText }) {
  /** @type {Warning[]} */
  const warnings = [];

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const entry of entries) {
    if (entry.id === null) continue;
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      warnings.push(
        warn('manual-edit-detected', `编号 ${id} 在 ${count} 处重复出现（疑似手工复制），将在下一次写入类动作中自动重发编号`, undefined, id),
      );
    }
  }

  for (const entry of active) {
    for (const code of isOverlength(entry, config).codes) {
      warnings.push(
        warn(
          code,
          `条目 ${entry.id ?? '(无编号)'} 超出长度上限（${code.replace('overlength-', '')}），该条不进入会话边界快照；INDEX.md 中已标「⚠ 超限未注入」`,
          entry.filePath,
          entry.id ?? undefined,
        ),
      );
    }
  }

  if (indexNote !== null && indexNote !== nextId) {
    warnings.push(
      warn('manual-edit-detected', `INDEX.md 的 next-id 注记（${indexNote}）与实际水位线（${nextId}）不一致，已按 §6.1 取最大值修正`),
    );
  }
  if (storedIds === null && indexNote === null && nextId > 0) {
    warnings.push(
      warn(
        'watermark-rebuilt',
        `水位线两处（.state/ids 与 INDEX.md 注记）均缺失，已按现存编号重建为 ${nextId}；此路径下历史编号可能被复用（§6.1 唯一允许的复用路径）`,
      ),
    );
  }

  // 新增的置顶标记（§14.64）。基线取"上一次 INDEX.md 里已经渲染过的置顶条"：
  // 只有能读到可解析的 INDEX.md 时才比较，否则无从判断（首扫/索引被删时一律不报，避免误告警）。
  //
  // ⚠️ 必须只看**非归档**条目（`active`）：`INDEX.md` 不渲染归档条目（§2.3），所以已归档条目的
  // `置顶：true`（§14.20 要求原样保留，且归档一个置顶条时本插件自己就会写出来）永远不可能出现在
  // 基线里——若拿 `entries` 比，它会让每次 `loadProject`（会话边界 + 每次搜索返回）都误报一次。
  const pinnedNow = active.filter((entry) => entry.pinned === true && entry.id !== null).map((entry) => String(entry.id));
  if (pinnedNow.length > 0 && typeof indexText === 'string' && indexText.includes('next-id:')) {
    const baseline = pinnedIdsFromIndex(indexText);
    const added = pinnedNow.filter((id) => !baseline.has(id));
    if (added.length > 0) {
      warnings.push(
        warn(
          'manual-edit-detected',
          `检测到新增的置顶标记（${added.join('、')}）：本插件的工具从不写「置顶」——若这是你手工加的，忽略本条；若是模型用 write/edit/pwsh 直接改了记忆文件，那属越权编辑（该标记仍按 §5.2 结论 4 生效，本插件不擅自回退人的意图）`,
        ),
      );
    }
  }

  return warnings;
}

/**
 * 从 INDEX.md 文本里取出"已渲染过置顶"的编号集合（`★ #0001` 或行尾 `（置顶）`）。
 *
 * @param {string} indexText
 * @returns {Set<string>}
 */
function pinnedIdsFromIndex(indexText) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const line of String(indexText).split('\n')) {
    if (!line.includes('★') && !line.includes('（置顶）')) continue;
    const matched = /#(\d{4,})/.exec(line);
    if (matched !== null) ids.add(`#${matched[1]}`);
  }
  return ids;
}

// ────────────────────────── 写入事务编辑器 ──────────────────────────

/**
 * 一次写入事务的内存工作区：懒加载目标文件，全部改动先在内存完成，
 * 最后由 `commit()` 一次性按固定顺序落盘（intent + 原子替换）。
 */
class Editor {
  /**
   * @param {{ projectRoot: string, memoryDir: string, config: Config, today: string, now: Date, validators?: Validators }} ctx
   */
  constructor(ctx) {
    this.projectRoot = ctx.projectRoot;
    this.memoryDir = ctx.memoryDir;
    this.config = ctx.config;
    this.today = ctx.today;
    this.now = ctx.now;
    this.validators = ctx.validators;
    /** @type {Map<string, VFile>} */
    this.files = new Map();
    /** @type {Map<string, VJournal>} */
    this.journals = new Map();
    /**
     * 本次操作**真正改动过**的文件路径。
     *
     * §5.5 第 9 条"工具除归档/恢复外不主动整理"：只有登记过的文件才重新渲染写盘；
     * 否则仅仅因为"扫描时读过它"，人工版式（`*` 列表标记、缺缩进、多余空行）就会被规范化。
     *
     * @type {Set<string>}
     */
    this.dirty = new Set();
    /** @type {Warning[]} */
    this.warnings = [];
    this.result = {
      assignedIds: /** @type {string[]} */ ([]),
      archived: /** @type {string[]} */ ([]),
      restored: /** @type {string[]} */ ([]),
      journalIds: /** @type {string[]} */ ([]),
      paths: /** @type {string[]} */ ([]),
      similar: /** @type {Array<{ id: string, reason: string, entryIndex: number }>} */ ([]),
    };
    this.indexPath = path.join(ctx.memoryDir, INDEX_FILE);
    this.idsPath = path.join(ctx.memoryDir, STATE_DIR, 'ids');
    this.indexOriginal = '';
    this.idsOriginal = '';
    this.indexWasStale = false;
    this.memoryDirExisted = false;
    /** @type {number|null} */
    this.storedIds = null;
    /** @type {number|null} */
    this.indexNote = null;
    this.nextId = 0;
    this.scanned = false;
  }

  /** 读取 `.state/` 与 `INDEX.md` 的现状（提交时用于比对与备份）。 */
  async init() {
    const idsRaw = await readText(this.idsPath);
    this.idsOriginal = idsRaw.content;
    this.storedIds = parseId(idsRaw.content.trim());

    const indexRaw = await readText(this.indexPath);
    this.indexOriginal = indexRaw.content;
    this.indexNote = readIndexNote(indexRaw.content);

    this.memoryDirExisted = await hasMemoryContent(this.memoryDir);
    return this;
  }

  /**
   * 登记"这个文件被本次操作改动了"（只有登记过的文件才会重新渲染落盘）。
   *
   * @param {string|undefined} filePath
   */
  markDirty(filePath) {
    if (typeof filePath === 'string' && filePath.length > 0) this.dirty.add(filePath);
  }

  /**
   * 懒加载一个记忆文件。
   *
   * @param {string} filePath
   * @returns {Promise<VFile>}
   */
  async memoryFile(filePath) {
    const existing = this.files.get(filePath);
    if (existing !== undefined) return existing;

    const raw = await readText(filePath);
    /** @type {Entry[]} */
    let entries = [];
    /** @type {string[]} */
    let preamble = [];
    if (raw.error !== undefined) {
      this.warnings.push(warn('parse-damaged', `读取记忆文件失败，按无内容处理：${raw.error}`, filePath));
    } else {
      const parsed = parseMemoryFile(raw.content, filePath);
      entries = parsed.entries;
      preamble = parsed.preamble;
      this.warnings.push(...parsed.warnings);
    }

    /** @type {VFile} */
    const file = {
      path: filePath,
      original: raw.content,
      content: raw.content,
      entries,
      fileDate: fileDateOf(filePath) ?? this.today,
      preamble,
    };
    this.files.set(filePath, file);
    return file;
  }

  /**
   * 懒加载一个日志文件（追加语义，因此保留原文）。
   *
   * @param {string} filePath
   * @returns {Promise<VJournal>}
   */
  async journalFile(filePath) {
    const existing = this.journals.get(filePath);
    if (existing !== undefined) return existing;

    const raw = await readText(filePath);
    /** @type {Set<string>} */
    const takenIds = new Set();
    if (raw.error !== undefined) {
      this.warnings.push(warn('parse-damaged', `读取日志文件失败，按无内容处理：${raw.error}`, filePath));
    } else {
      const parsed = parseJournalFile(raw.content, filePath);
      this.warnings.push(...parsed.warnings);
      for (const entry of parsed.entries) if (typeof entry.id === 'string' && entry.id.length > 0) takenIds.add(entry.id);
    }

    /** @type {VJournal} */
    const journal = { path: filePath, original: raw.content, content: raw.content, takenIds };
    this.journals.set(filePath, journal);
    return journal;
  }

  /** @returns {Entry[]} 全部非归档条目（INDEX.md 与查重都用它） */
  activeEntries() {
    /** @type {Entry[]} */
    const list = [];
    for (const file of this.files.values()) if (!isArchivedPath(file.path)) list.push(...file.entries);
    return list;
  }

  /** @returns {Entry[]} 全部条目（活动 + 归档） */
  allEntries() {
    /** @type {Entry[]} */
    const list = [];
    for (const file of this.files.values()) list.push(...file.entries);
    return list;
  }

  /** @returns {string} 下一个编号（并推进水位线） */
  allocateOne() {
    const allocated = allocate(this.nextId, 1);
    this.nextId = allocated.next;
    return allocated.ids[0] ?? '';
  }

  /**
   * 扫描期写回（§6.1）：加载全部记忆文件、补发缺失编号、修复重复编号。只改内存。
   *
   * @returns {Promise<void>}
   */
  async scan() {
    if (this.scanned) return;
    this.scanned = true;

    for (const name of (await listDir(this.memoryDir)).filter((item) => MEMORY_FILE_RE.test(item))) {
      await this.memoryFile(path.join(this.memoryDir, name));
    }
    for (const name of (await listDir(path.join(this.memoryDir, ARCHIVE_DIR))).filter((item) => MEMORY_FILE_RE.test(item))) {
      await this.memoryFile(path.join(this.memoryDir, ARCHIVE_DIR, name));
    }

    const all = this.allEntries();
    this.nextId = watermark({
      idsFileContent: this.storedIds === null ? '' : String(this.storedIds),
      indexNote: this.indexNote,
      activeIds: all.filter((entry) => !isArchivedPath(entry.filePath)).map((entry) => entry.id),
      archivedIds: all.filter((entry) => isArchivedPath(entry.filePath)).map((entry) => entry.id),
    });

    // ① 手工新增的无编号条目：扫描发现就补发编号并写回（§6.1）
    for (const file of [...this.files.values()].sort(compareVFiles)) {
      for (const entry of file.entries) {
        if (entry.id !== null) continue;
        const fresh = this.allocateOne();
        entry.id = fresh;
        this.markDirty(file.path);
        this.warnings.push(warn('missing-id-assigned', `条目「${entry.title}」无编号，已补发 ${fresh} 并写回文件`, entry.filePath, fresh));
      }
    }

    // ② 重复编号修复：活动文件日期升序 → 归档文件日期升序 → 文件内出现顺序（§6.1）
    const watermarkBefore = this.nextId;
    const snapshot = this.allEntries();
    const repaired = repairDuplicates(snapshot);
    this.warnings.push(...repaired.warnings);
    for (let index = 0; index < snapshot.length; index += 1) {
      const original = snapshot[index];
      const fixed = repaired.entries[index];
      if (original === undefined || fixed === undefined) continue;
      if (fixed.id === original.id) continue;

      const value = parseId(String(fixed.id));
      if (value !== null && value <= watermarkBefore) {
        // §6.1：正常路径下编号永不复用 —— 落在水位线之下的号可能属于历史条目，改用新号
        const fresh = this.allocateOne();
        original.id = fresh;
        this.markDirty(original.filePath);
        this.warnings.push(
          warn('duplicate-id-repaired', `编号 ${fixed.id} 重复出现，已重发为 ${fresh}（避开水位线以下的历史编号）`, original.filePath, fresh),
        );
        continue;
      }
      original.id = fixed.id;
      // ⚠️ 真实宿主冒烟发现的缺陷修复：修复后的编号可能**高于当前水位线**（repairDuplicates 刻意
      // 发新号避开水位线以下）。水位线的定义是"已分配的最大编号"，因此必须一并抬高——否则该条目
      // 日后被人工删除时，水位线会落回它之下，正常路径就可能复用这个已经分配过的号（§1.4/§6.1）。
      if (value !== null && value > this.nextId) this.nextId = value;
      this.markDirty(original.filePath);
    }

    // ③ 诊断（与读路径同口径，保证工具返回里也看得到）
    this.indexWasStale = this.indexOriginal.trim() === '' || this.indexOriginal !== this.renderIndexNow();
    if (this.indexNote !== null && this.indexNote !== this.nextId) {
      this.warnings.push(
        warn('manual-edit-detected', `INDEX.md 的 next-id 注记（${this.indexNote}）与实际水位线（${this.nextId}）不一致，已按 §6.1 取最大值修正`, this.indexPath),
      );
    }
    if (this.storedIds === null && this.indexNote === null && this.nextId > 0) {
      this.warnings.push(
        warn(
          'watermark-rebuilt',
          `水位线两处（.state/ids 与 INDEX.md 注记）均缺失，已按现存编号重建为 ${this.nextId}；此路径下历史编号可能被复用（§6.1 唯一允许的复用路径）`,
        ),
      );
    }
    for (const entry of this.activeEntries()) {
      for (const code of isOverlength(entry, this.config).codes) {
        this.warnings.push(
          warn(
            code,
            `条目 ${entry.id ?? '(无编号)'} 超出长度上限，该条不进入会话边界快照；INDEX.md 中已标「⚠ 超限未注入」`,
            entry.filePath,
            entry.id ?? undefined,
          ),
        );
      }
    }
  }

  /** @returns {string} 按当前内存状态渲染的 INDEX.md */
  renderIndexNow() {
    return renderIndex({ active: this.activeEntries(), nextId: this.nextId }, { today: this.today, config: this.config });
  }

  /**
   * 提交：渲染 → 只写有变化的文件 → 写前指纹比对 → 临时文件/备份 → intent →
   * 固定顺序 `rename` → 删 intent → 清理备份（§12.1）。
   *
   * @param {string} op intent 里的操作类型
   * @param {{ rebuildIndex?: boolean }} [options]
   * @returns {Promise<CommitSuccess|CommitFailure>}
   */
  async commit(op, options = {}) {
    const wantIndex = options.rebuildIndex !== false;
    // §5.5 第 9 条：只重新渲染本次真正改动过的文件——扫描读过 ≠ 改动过，
    // 否则每做一次写入都会把全项目的人工版式规范化一遍。
    for (const file of this.files.values()) {
      if (!this.dirty.has(file.path)) continue;
      file.content = renderMemoryFile(file.fileDate, file.entries, { preamble: file.preamble });
    }

    /** @type {Array<{ path: string, content: string, original: string }>} */
    const targets = [];
    for (const file of this.files.values()) targets.push({ path: file.path, content: file.content, original: file.original });
    for (const journal of this.journals.values()) targets.push({ path: journal.path, content: journal.content, original: journal.original });
    if (wantIndex) targets.push({ path: this.indexPath, content: this.renderIndexNow(), original: this.indexOriginal });
    targets.push({ path: this.idsPath, content: `${String(this.nextId)}\n`, original: this.idsOriginal });

    const changed = targets.filter((target) => target.content !== target.original);
    if (changed.length === 0) return { ok: true, paths: [], warnings: [] };

    // 全新项目（`memory/` 本来不存在）且只有派生物要写 → 不创建目录，避免污染无关项目
    if (!this.memoryDirExisted && changed.every((target) => target.path === this.indexPath || target.path === this.idsPath)) {
      return { ok: true, paths: [], warnings: [] };
    }

    // §12.2 写前指纹比对：发现被人工改动 → 放弃旧快照（由 applyBatch 重读重试）
    for (const target of changed) {
      const current = await readText(target.path);
      if (current.error !== undefined) {
        return {
          ok: false,
          code: 'io_error',
          message: `写入前读取 ${target.path} 失败：${current.error}`,
          nextStep: '稍后重试；若持续失败请人工检查文件权限',
          warnings: [],
        };
      }
      if (fingerprint(current.content) !== fingerprint(target.original)) {
        return {
          ok: false,
          code: 'write_conflict',
          conflictPath: target.path,
          message: `${target.path} 在读取后被外部改动，已放弃本次修改（绝不覆盖人工修改）`,
          nextStep: '重读并重新校验后重试',
          warnings: [],
        };
      }
    }

    const ordered = [...changed].sort((a, b) => commitRank(a) - commitRank(b) || (a.path < b.path ? -1 : 1));

    // 1) 写临时文件（专门留着给 intent 引用：崩溃后才能前滚）
    const stamp = `${process.pid.toString(36)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    /** @type {Array<{ path: string, tmpPath: string, backupPath: string, content: string }>} */
    const staged = [];
    /**
     * @param {string} message
     * @returns {Promise<CommitFailure>}
     */
    const bail = async (message) => {
      for (const item of staged) {
        await removeFile(item.tmpPath);
        await removeFile(item.backupPath);
      }
      return { ok: false, code: 'io_error', message, nextStep: '稍后重试', warnings: [] };
    };
    for (const target of ordered) {
      const dir = path.dirname(target.path);
      const ensured = await mkdirp(dir);
      if (!ensured.ok) return bail(`创建目录失败：${ensured.error}`);
      const base = path.basename(target.path);
      const tmpPath = path.join(dir, `.${base}.${stamp}.tmp`);
      try {
        await writeFile(tmpPath, target.content, { encoding: 'utf8' });
      } catch (error) {
        await removeFile(tmpPath);
        return bail(`写临时文件失败：${describeError(error)}`);
      }
      staged.push({ path: target.path, tmpPath, backupPath: path.join(dir, `.${base}.${stamp}.bak`), content: target.content });
    }

    // 2) 备份原内容（回滚用）；原文件不存在时不产生备份（回滚语义 = 删除目标）
    for (const item of staged) {
      const backed = await backupFile(item.path, item.backupPath);
      if (!backed.ok) return bail(`备份原内容失败：${backed.error ?? ''}`);
    }

    // 3) 落 intent（必须在任何 rename 之前，§12.1 第 1 条）
    const begun = await beginIntent(this.memoryDir, {
      version: 1,
      op: /** @type {'batch'} */ (op),
      files: staged.map((item) => ({ path: item.path, tmpPath: item.tmpPath, backupPath: item.backupPath })),
      createdAt: new Date().toISOString(),
    });
    const intentPath = begun.intentPath ?? path.join(this.memoryDir, INTENT_FILE);
    if (!begun.ok) return bail(`写入 intent 失败：${begun.error ?? ''}`);

    // 4) 固定顺序 rename
    for (const item of staged) {
      try {
        await rename(item.tmpPath, item.path);
      } catch (error) {
        // 进程还活着就失败 → 必须回到原样（§12.1 失败形态 1）：用 intent 回滚
        const rolled = await converge(this.memoryDir, { warn: () => undefined });
        return {
          ok: false,
          code: 'degraded',
          message: `落盘失败：${describeError(error)}；已按 intent 处理残留（${String(rolled.recovered)}${rolled.degraded === true ? '，但未能收敛' : ''}）`,
          nextStep: `重试；若返回 degraded 请人工检查 ${intentPath}`,
          warnings: rolled.warnings,
        };
      }
    }

    // 5) 删除 intent = 提交（§12.1 第 3 条）
    const committed = await commitIntent(intentPath);
    if (!committed.ok) {
      // 此时所有文件都已落盘完成：保留 intent 与备份，**绝不自动回滚**——
      // 下一个收敛点会看到"全部文件已是新版本"，按"确认提交"处理（不会撤销已完成的写入）。
      return {
        ok: false,
        code: 'degraded',
        message: `文件已全部写入，但删除 intent 失败（${committed.error ?? ''}）；已保留 intent 与备份，下次收敛点会确认提交（不会回滚已完成的写入）`,
        nextStep: `人工确认 ${intentPath} 后可手动删除`,
        warnings: [],
      };
    }

    // 6) 清理备份；并把 original 更新成已落盘内容（幂等）
    for (const item of staged) await removeFile(item.backupPath);
    for (const item of staged) this.markWritten(item.path, item.content);

    this.result.paths = ordered.map((target) => target.path);
    if (changed.some((target) => target.path === this.indexPath) && this.indexWasStale) {
      this.warnings.push(warn('index-rebuilt', 'INDEX.md 缺失或与活动记忆不一致，已重建', this.indexPath));
      this.indexWasStale = false;
    }
    return { ok: true, paths: this.result.paths, warnings: [] };
  }

  /**
   * 记录"这个路径已经是刚落盘的内容"。
   *
   * @param {string} filePath
   * @param {string} content
   */
  markWritten(filePath, content) {
    const file = this.files.get(filePath);
    if (file !== undefined) {
      file.original = content;
      file.content = content;
      return;
    }
    const journal = this.journals.get(filePath);
    if (journal !== undefined) {
      journal.original = content;
      journal.content = content;
      return;
    }
    if (filePath === this.indexPath) this.indexOriginal = content;
    if (filePath === this.idsPath) {
      this.idsOriginal = content;
      this.storedIds = parseId(content.trim());
    }
  }

  /**
   * 按"先归档/恢复，后写/编辑/日志"的顺序执行 ops；任一条失败整批不写入（§12.1）。
   *
   * @param {Array<Record<string, unknown>>} ops
   * @returns {Promise<{ ok: true } | ApplyError>}
   */
  async applyOps(ops) {
    /** @type {Record<string, number>} */
    const rank = { archive: 0, restore: 1, write: 2, edit: 3, log: 4 };
    const ordered = (Array.isArray(ops) ? ops : [])
      .map((item, index) => ({ op: item, index }))
      .sort((a, b) => {
        const rankA = rank[String(a.op?.type)] ?? 9;
        const rankB = rank[String(b.op?.type)] ?? 9;
        return rankA === rankB ? a.index - b.index : rankA - rankB;
      });

    for (const { op } of ordered) {
      const type = String(op?.type);
      if (type === 'archive') {
        const failure = await this.applyArchive(op);
        if (failure !== null) return failure;
      } else if (type === 'restore') {
        const failure = await this.applyRestore(op);
        if (failure !== null) return failure;
      } else if (type === 'write') {
        const failure = await this.applyWrite(op);
        if (failure !== null) return failure;
      } else if (type === 'edit') {
        const failure = await this.applyEdit(op);
        if (failure !== null) return failure;
      } else if (type === 'log') {
        const failure = await this.applyLog(op);
        if (failure !== null) return failure;
      } else {
        return errorObject('invalid_param', `未知的操作类型「${type}」`, '请使用 write/edit/archive/restore/log 之一');
      }
    }
    return { ok: true };
  }

  /**
   * 归档：从原活动文件移除该条，追加到 `archive/M-原日期.md`（§6.2，针对单条记忆）。
   *
   * @param {Record<string, unknown>} op
   * @returns {Promise<ApplyError|null>}
   */
  async applyArchive(op) {
    const ids = stringList(op.ids);
    if (ids.length === 0) return errorObject('invalid_param', 'archive 需要非空的 ids 数组', '请提供要归档的编号');
    const reason = typeof op.reason === 'string' && op.reason.length > 0 ? op.reason : null;

    for (const id of ids) {
      const target = this.allEntries().find((entry) => entry.id === id);
      if (target === undefined) {
        return errorObject('not_found', `编号 ${id} 不存在`, '用 memory_search 确认编号');
      }
      if (isArchivedPath(target.filePath) || target.status === 'archived') {
        return errorObject('not_found', `编号 ${id} 已归档`, '如需编辑，请先用 memory_archive 的 restore 恢复');
      }

      const sourceFile = await this.memoryFile(target.filePath);
      const index = sourceFile.entries.indexOf(target);
      if (index >= 0) sourceFile.entries.splice(index, 1);

      const archivePath = path.join(this.memoryDir, ARCHIVE_DIR, `M-${target.fileDate}.md`);
      const archiveFile = await this.memoryFile(archivePath);
      const previousStatus = target.status;
      target.status = /** @type {any} */ ('archived');
      target.archivedStatusBefore = /** @type {any} */ (previousStatus);
      target.archivedAt = `${this.today} ${timeLocal(this.now)}`;
      target.archivedReason = reason;
      target.filePath = archivePath;
      target.order = nextOrder(archiveFile.entries);
      ensurePresent(target, '状态');
      ensurePresent(target, '归档前状态');
      ensurePresent(target, '归档时间');
      if (reason !== null) ensurePresent(target, '归档原因');
      archiveFile.entries.push(target);
      this.markDirty(sourceFile.path);
      this.markDirty(archiveFile.path);

      if (target.pinned === true) {
        this.warnings.push(warn('manual-edit-detected', `编号 ${id} 原为置顶，已随归档退出注入；归档文件里保留「置顶：true」（工具不搬运置顶）`, archivePath, id));
      }
      this.result.archived.push(id);
    }
    return null;
  }

  /**
   * 恢复：放回原日期文件，把 `归档前状态` 回填到 `状态`，删除三个归档字段（§6.2）。
   *
   * @param {Record<string, unknown>} op
   * @returns {Promise<ApplyError|null>}
   */
  async applyRestore(op) {
    const ids = stringList(op.ids);
    if (ids.length === 0) return errorObject('invalid_param', 'restore 需要非空的 ids 数组', '请提供要恢复的编号');

    for (const id of ids) {
      const target = this.allEntries().find((entry) => entry.id === id && isArchivedPath(entry.filePath));
      if (target === undefined) {
        return errorObject('not_found', `归档区里没有编号 ${id}`, '用 memory_search(includeArchived=true) 确认编号');
      }

      // 前置检查（§6.2）：① 编号冲突 ② 与活动记忆精确重复 ③ 字段不可容纳
      if (this.activeEntries().some((entry) => entry.id === id)) {
        return errorObject('conflict', `编号 ${id} 已存在于活动记忆，无法恢复（不自动合并）`, '先处理活动区里同编号的条目，或人工确认后重试');
      }
      const duplicate = this.activeEntries().find(
        (entry) => entry.id !== id && normalize(entry.title) === normalize(target.title),
      );
      if (duplicate !== undefined) {
        return errorObject(
          'conflict',
          `归档条目 ${id} 与活动记忆 ${duplicate.id ?? '(无编号)'} 标题重复（按 §8.3 判据），无法恢复`,
          '人工决定保留哪一条后重试',
        );
      }
      const nextStatus = target.archivedStatusBefore ?? (target.status === 'archived' ? null : target.status);
      if (nextStatus === null || !isRestorableStatus(nextStatus)) {
        return errorObject(
          'invalid_param',
          `${id} 的「归档前状态」（${String(target.archivedStatusBefore ?? '缺失')}）不在 active｜candidate｜superseded 内，无法确定恢复后的状态；原条目原样留在归档区（不猜测、不修复）`,
          '请人工修正该条的「归档前状态」后再恢复',
        );
      }
      if (!KINDS.includes(/** @type {any} */ (target.kind))) {
        return errorObject('invalid_param', `${id} 的类型「${String(target.kind)}」不在四类内，拒绝恢复（原样留在归档区）`, '请人工修正类型后再恢复');
      }
      if (!CONFIDENCES.includes(/** @type {any} */ (target.confidence))) {
        return errorObject('invalid_param', `${id} 的置信度「${String(target.confidence)}」不在四档内，拒绝恢复（原样留在归档区）`, '请人工修正置信度后再恢复');
      }
      if (parseId(String(target.id)) === null) {
        return errorObject('invalid_param', `编号形态不合法：${String(target.id)}，拒绝恢复（原样留在归档区）`, '请人工修正编号后再恢复');
      }

      const archiveFile = await this.memoryFile(target.filePath);
      const index = archiveFile.entries.indexOf(target);
      if (index >= 0) archiveFile.entries.splice(index, 1);

      const restorePath = path.join(this.memoryDir, `M-${target.fileDate}.md`);
      const restoreFile = await this.memoryFile(restorePath);
      target.status = /** @type {any} */ (nextStatus);
      target.archivedAt = null;
      target.archivedReason = null;
      target.archivedStatusBefore = null;
      target.filePath = restorePath;
      target.order = nextOrder(restoreFile.entries);
      removePresent(target, '归档时间');
      removePresent(target, '归档原因');
      removePresent(target, '归档前状态');
      if (nextStatus !== 'active') ensurePresent(target, '状态');
      restoreFile.entries.push(target);
      this.markDirty(archiveFile.path);
      this.markDirty(restoreFile.path);

      this.result.restored.push(id);
    }
    return null;
  }

  /**
   * 写入新条目（§7.1）：整批先校验，任何一条失败则整批不写入。
   *
   * @param {Record<string, unknown>} op
   * @returns {Promise<ApplyError|null>}
   */
  async applyWrite(op) {
    const rawEntries = Array.isArray(op.entries) ? op.entries : [];
    if (rawEntries.length === 0) return errorObject('invalid_param', 'write 需要非空的 entries 数组', '请提供要写入的条目');

    const todayFile = await this.memoryFile(path.join(this.memoryDir, `M-${this.today}.md`));

    /** @type {Array<{ entry: Entry, supersedes: string[] }>} */
    const planned = [];
    const supersededSoFar = new Set();

    for (let index = 0; index < rawEntries.length; index += 1) {
      const raw = /** @type {Record<string, unknown>} */ (rawEntries[index] ?? {});
      const built = this.validateNewEntry(raw, index);
      if (built.ok === false) return built;

      const known = [...this.allEntries(), ...planned.map((item) => item.entry)];
      const checked = this.runValidators(built.entry, known, built.supersedes, index);
      if (checked !== null) return checked;

      for (const oldId of built.supersedes) {
        if (supersededSoFar.has(oldId)) {
          return errorObject('conflict', `同一批里有两条新条目都要取代 ${oldId}`, '让一条新条目取代它，或拆成两次调用', index);
        }
        supersededSoFar.add(oldId);
      }
      planned.push({ entry: built.entry, supersedes: built.supersedes });
    }

    // 校验全部通过后才分配编号并写入（全成或全败）
    for (const item of planned) {
      const fresh = this.allocateOne();
      item.entry.id = fresh;
      item.entry.filePath = todayFile.path;
      item.entry.fileDate = todayFile.fileDate;
      item.entry.order = nextOrder(todayFile.entries);
      if (item.supersedes.length > 0) ensurePresent(item.entry, '取代');
      this.result.assignedIds.push(fresh);
    }

    // §6.3：同一次调用完成"新增 + 取代"，不产生双活
    for (const item of planned) {
      for (const oldId of item.supersedes) {
        const old = this.allEntries().find((entry) => entry.id === oldId && !isArchivedPath(entry.filePath));
        if (old === undefined) continue; // 校验阶段已确认存在
        const newId = item.entry.id ?? '';
        old.status = /** @type {any} */ ('superseded');
        old.supersededBy = newId;
        ensurePresent(old, '状态');
        ensurePresent(old, '取代者');
        this.markDirty(old.filePath);
        if (old.pinned === true) {
          this.warnings.push(
            warn(
              'manual-edit-detected',
              `${oldId} 原为置顶，已随取代退出注入；如需保留，请在人工编辑时把「置顶：true」移到 ${newId}（工具不自动搬运置顶）`,
              old.filePath,
              oldId,
            ),
          );
        }
      }
    }

    for (const item of planned) todayFile.entries.push(item.entry);
    this.markDirty(todayFile.path);
    return null;
  }

  /**
   * 校验一条新条目并构造内部对象（§7.1 的机械校验）。
   *
   * @param {Record<string, unknown>} raw
   * @param {number} entryIndex
   * @returns {{ ok: true, entry: Entry, supersedes: string[] } | ApplyError}
   */
  validateNewEntry(raw, entryIndex) {
    const config = this.config;
    const today = this.today;

    const kindRaw = raw.kind;
    const kind = typeof kindRaw === 'string' ? (LABEL_KIND[kindRaw] ?? kindRaw) : undefined;
    if (kind === undefined || !KINDS.includes(/** @type {any} */ (kind))) {
      return errorObject('invalid_param', `kind 非法：${String(kindRaw)}；合法值 ${KINDS.join(' / ')}`, '请用 convention/fact/procedure/lesson 之一', entryIndex);
    }

    const titleRaw = raw.title;
    if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
      return errorObject('invalid_param', 'title 必填且不能为空', '请提供一条独立可用的短陈述', entryIndex);
    }
    const title = titleRaw.trim();
    if (title.includes('\n') || title.includes('\r')) {
      return errorObject('invalid_param', 'title 必须是单行（不含换行符）', '把长解释放进 detail', entryIndex);
    }
    if ([...title].length > config.maxTitleChars) {
      return errorObject('too_long', `title 长度 ${[...title].length} 超过上限 ${config.maxTitleChars}`, '精简标题，把细节放进 detail', entryIndex);
    }

    const detail = typeof raw.detail === 'string' ? raw.detail : '';
    if ([...detail].length > config.detailMaxChars) {
      return errorObject('too_long', `detail 长度 ${[...detail].length} 超过上限 ${config.detailMaxChars}`, '拆成多条或精简详细', entryIndex);
    }

    let status = 'active';
    if (raw.status !== undefined && raw.status !== null) {
      if (raw.status !== 'active' && raw.status !== 'candidate') {
        return errorObject('invalid_param', `status 只能是 active 或 candidate（收到 ${String(raw.status)}）`, '未验证的结论请显式写 candidate', entryIndex);
      }
      status = raw.status;
    }

    const priority = raw.priority === undefined || raw.priority === null ? defaultPriority(/** @type {any} */ (kind)) : raw.priority;
    if (typeof priority !== 'string' || !PRIORITIES.includes(/** @type {any} */ (priority))) {
      return errorObject('invalid_param', `priority 非法：${String(raw.priority)}；合法值 ${PRIORITIES.join(' / ')}`, '省略该字段即按类型推导', entryIndex);
    }

    const confidence = raw.confidence === undefined || raw.confidence === null ? 'observed' : raw.confidence;
    if (typeof confidence !== 'string' || !CONFIDENCES.includes(/** @type {any} */ (confidence))) {
      return errorObject('invalid_param', `confidence 非法：${String(raw.confidence)}；合法值 ${CONFIDENCES.join(' / ')}`, '省略该字段即按 observed 处理', entryIndex);
    }

    const expiresAt = this.validateExpiresAt(raw.expiresAt, entryIndex);
    if (typeof expiresAt !== 'string') return expiresAt;

    const supersedes = stringList(raw.supersedes);
    for (const id of supersedes) {
      const target = this.allEntries().find((entry) => entry.id === id);
      if (target === undefined || isArchivedPath(target.filePath)) {
        return errorObject('not_found', `supersedes 指向的编号 ${id} 不存在或已归档`, 'supersedes 只接受存在且未被归档的编号', entryIndex);
      }
      if (target.status === 'superseded') {
        return errorObject(
          'conflict',
          `${id} 已被 ${target.supersededBy ?? '(未知)'} 取代，不能再被取代`,
          `请改为指向 ${target.supersededBy ?? '最新的那条'}，避免把取代链压平`,
          entryIndex,
        );
      }
    }

    const related = stringList(raw.relatedMemory);
    for (const id of related) {
      if (!this.allEntries().some((entry) => entry.id === id)) {
        return errorObject('not_found', `relatedMemory 指向的编号 ${id} 不存在`, '用 memory_search 确认编号', entryIndex);
      }
    }

    // 注：`relatedJournal` 只作为引用记录写入，不做存在性校验（日志按日生成、扫描期不读全部日志文件，
    // 校验引用会误报；§7.1 也没有要求。日志侧的 relatedMemoryIds 另有 §7.5 的"告警但仍写入"。）

    /** @type {Entry} */
    const entry = {
      id: null,
      kind: /** @type {any} */ (kind),
      title,
      detail,
      status: /** @type {any} */ (status),
      pinned: false,
      priority: /** @type {any} */ (priority),
      confidence: /** @type {any} */ (confidence),
      created: today,
      updated: today,
      expiresAt,
      tags: stringList(raw.tags),
      aliases: stringList(raw.aliases),
      related,
      supersedes,
      supersededBy: null,
      relatedJournal: stringList(raw.relatedJournal),
      source: typeof raw.source === 'string' ? raw.source : '',
      archivedAt: null,
      archivedReason: null,
      archivedStatusBefore: null,
      unknownFields: [],
      presentFields: [],
      orphanNotes: [],
      filePath: '',
      fileDate: today,
      order: 0,
      raw: '',
    };

    if (isOverlength(entry, config).codes.includes('overlength-item')) {
      return errorObject(
        'too_long',
        `单条总计超过上限 ${config.itemMaxChars}（标题 + 详细 + 字段开销）`,
        '精简标题或详细，或拆成多条',
        entryIndex,
      );
    }
    return { ok: true, entry, supersedes };
  }

  /**
   * `有效至` 校验（§7.1：早于今天一律拒绝，否则会出现"写成功但立刻不可见"）。
   *
   * @param {unknown} value
   * @param {number} entryIndex
   * @returns {string | ApplyError}
   */
  validateExpiresAt(value, entryIndex) {
    if (value === undefined || value === null) return '永久';
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return errorObject('invalid_param', `expiresAt 必须是 YYYY-MM-DD 或不填（收到 ${String(value)}）`, '不填即永久', entryIndex);
    }
    if (value < this.today) {
      return errorObject(
        'invalid_param',
        '有效至不得早于今天；如需记录历史结论，请留空（永久）并在 详细 中说明',
        '改为今天之后，或留空表示永久',
        entryIndex,
      );
    }
    return value;
  }

  /**
   * 运行调用方注入的校验器（§7.1：重复整批拒绝、冲突不写入、敏感整批拒绝；相似只提示）。
   *
   * @param {Entry} entry
   * @param {Entry[]} known
   * @param {string[]} supersedes
   * @param {number} entryIndex
   * @returns {ApplyError|null}
   */
  runValidators(entry, known, supersedes, entryIndex) {
    const validators = this.validators;
    if (validators === undefined || validators === null) return null;
    const today = this.today;

    if (typeof validators.findDuplicate === 'function') {
      const duplicate = validators.findDuplicate(entry.title, known, { today });
      if (duplicate !== null && duplicate !== undefined) {
        return errorObject('duplicate', `标题规范化后与 ${duplicate.id} 完全相同`, `请改用 memory_edit 补充 ${duplicate.id}，或改写标题`, entryIndex);
      }
    }

    if (typeof validators.findSimilar === 'function') {
      // §7.1：高度相似**不拒绝**，只把候选编号与原因交给调用方放进返回文本
      const similar = validators.findSimilar(entry.title, known, { today });
      if (Array.isArray(similar)) {
        for (const hit of similar) this.result.similar.push({ id: hit.id, reason: hit.reason, entryIndex });
      }
    }

    if (typeof validators.findConflicts === 'function') {
      // §7.1：冲突判定排除本批 supersedes 指向的编号（否则会用同样的理由再拒一次）
      const conflicts = validators.findConflicts(entry, known, { today, excludeIds: supersedes });
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        const list = conflicts.map((item) => `${item.id}（${item.reason}）`).join('、');
        return errorObject('conflict', `与已有记忆冲突：${list}`, '如需替换，请重发一次并带 supersedes:[...]', entryIndex);
      }
    }

    if (typeof validators.scanEntryTexts === 'function') {
      const hits = validators.scanEntryTexts({ title: entry.title, detail: entry.detail, tags: entry.tags, aliases: entry.aliases });
      if (Array.isArray(hits) && hits.length > 0) {
        const list = hits.map((hit) => `${hit.field}（${hit.category}）`).join('、');
        return errorObject('sensitive', `命中敏感信息：${list}（不回显原文）`, '改写为不含具体值的说明性文字后重试', entryIndex);
      }
    }
    return null;
  }

  /**
   * 编辑既有条目（§7.2）：编号不变、未知字段原样保留、`更新` 自动刷新。
   *
   * @param {Record<string, unknown>} op
   * @returns {Promise<ApplyError|null>}
   */
  async applyEdit(op) {
    const edits = Array.isArray(op.edits) ? op.edits : [];
    if (edits.length === 0) return errorObject('invalid_param', 'edit 需要非空的 edits 数组', '请提供要修改的条目');

    /** @type {Entry[]} */
    const touched = [];
    for (let index = 0; index < edits.length; index += 1) {
      const edit = /** @type {Record<string, unknown>} */ (edits[index] ?? {});
      const idRaw = edit.id;
      if (typeof idRaw !== 'string') {
        return errorObject('invalid_param', `edit.id 非法：${String(idRaw)}`, '请提供形如 #0008 的编号', index);
      }
      // 容忍 '#7' / '0007' 这类不补零的写法：先归一成 '#0007' 再查
      const numericId = parseId(idRaw);
      if (numericId === null) {
        return errorObject('invalid_param', `edit.id 非法：${idRaw}`, '请提供形如 #0008 的编号', index);
      }
      const canonicalId = formatId(numericId);
      const target = this.allEntries().find((entry) => entry.id === canonicalId || entry.id === idRaw);
      if (target === undefined) {
        return errorObject('not_found', `编号 ${canonicalId} 不存在`, '用 memory_search 确认编号', index);
      }
      if (isArchivedPath(target.filePath)) {
        return errorObject('not_found', `${canonicalId} 已归档，请先用 memory_archive 的 restore 恢复再编辑`, '先恢复再编辑', index);
      }
      const failure = this.planEdit(target, edit, index);
      if (failure !== null) return failure;
      touched.push(target);
    }

    for (const entry of touched) {
      entry.updated = this.today;
      if (entry.updated !== entry.created) ensurePresent(entry, '更新');
      this.markDirty(entry.filePath);
    }
    return null;
  }

  /**
   * 计算一条 edit 的字段改动（改了标题/类型/状态/优先级/置信度后重跑查重，§7.2）。
   *
   * @param {Entry} target
   * @param {Record<string, unknown>} edit
   * @param {number} entryIndex
   * @returns {ApplyError|null}
   */
  planEdit(target, edit, entryIndex) {
    const has = (/** @type {string} */ key) => Object.prototype.hasOwnProperty.call(edit, key);
    let recheck = false;

    if (has('title')) {
      const value = edit.title;
      if (typeof value !== 'string') return errorObject('invalid_param', 'title 不能被清空（title: null 非法）', '要改标题请给出非空字符串', entryIndex);
      const title = value.trim();
      if (title.length === 0 || title.includes('\n') || title.includes('\r')) {
        return errorObject('invalid_param', 'title 必须是非空单行文本', '把长解释放进 detail', entryIndex);
      }
      if ([...title].length > this.config.maxTitleChars) {
        return errorObject('too_long', `title 长度 ${[...title].length} 超过上限 ${this.config.maxTitleChars}`, '精简标题', entryIndex);
      }
      target.title = title;
      recheck = true;
    }

    if (has('detail')) {
      const value = edit.detail;
      if (value === null) {
        target.detail = '';
        removePresent(target, '详细');
      } else if (typeof value === 'string') {
        if ([...value].length > this.config.detailMaxChars) {
          return errorObject('too_long', `detail 长度 ${[...value].length} 超过上限 ${this.config.detailMaxChars}`, '拆条或精简', entryIndex);
        }
        target.detail = value;
        ensurePresent(target, '详细');
      } else {
        return errorObject('invalid_param', 'detail 必须是字符串或 null（null = 清空）', 'null 表示清空详细', entryIndex);
      }
    }

    if (has('kind')) {
      const value = edit.kind;
      if (typeof value !== 'string') return errorObject('invalid_param', 'kind 不能被清空', `提供 ${KINDS.join(' / ')} 之一`, entryIndex);
      const kind = LABEL_KIND[value] ?? value;
      if (!KINDS.includes(/** @type {any} */ (kind))) {
        return errorObject('invalid_param', `kind 非法：${value}`, `合法值 ${KINDS.join(' / ')}`, entryIndex);
      }
      target.kind = /** @type {any} */ (kind); // 渲染按类型分节，改 kind 即移动到目标分节
      recheck = true;
    }

    if (has('status')) {
      const value = edit.status;
      if (value !== 'active' && value !== 'candidate') {
        return errorObject('invalid_param', `status 只能改成 active 或 candidate（收到 ${String(value)}）`, '状态只允许这两个值', entryIndex);
      }
      target.status = value;
      ensurePresent(target, '状态');
      recheck = true;
    }

    if (has('priority')) {
      const value = edit.priority;
      if (typeof value !== 'string' || !PRIORITIES.includes(/** @type {any} */ (value))) {
        return errorObject('invalid_param', `priority 非法：${String(value)}`, `合法值 ${PRIORITIES.join(' / ')}`, entryIndex);
      }
      target.priority = /** @type {any} */ (value);
      ensurePresent(target, '优先级');
      recheck = true;
    }

    if (has('confidence')) {
      const value = edit.confidence;
      if (typeof value !== 'string' || !CONFIDENCES.includes(/** @type {any} */ (value))) {
        return errorObject('invalid_param', `confidence 非法：${String(value)}`, `合法值 ${CONFIDENCES.join(' / ')}`, entryIndex);
      }
      target.confidence = /** @type {any} */ (value);
      ensurePresent(target, '置信度');
      recheck = true;
    }

    if (has('expiresAt')) {
      if (edit.expiresAt === null) {
        target.expiresAt = '永久';
        removePresent(target, '有效至');
      } else {
        const checked = this.validateExpiresAt(edit.expiresAt, entryIndex);
        if (typeof checked !== 'string') return checked;
        target.expiresAt = checked;
        ensurePresent(target, '有效至');
      }
    }

    for (const [key, fieldName] of /** @type {Array<[string, string]>} */ ([['tags', '标签'], ['aliases', '别名']])) {
      if (!has(key)) continue;
      const value = edit[key];
      if (!Array.isArray(value) && typeof value !== 'string') {
        return errorObject('invalid_param', `${key} 必须是数组（[] = 清空）`, '空数组表示清空该字段', entryIndex);
      }
      const list = stringList(value);
      if (key === 'tags') target.tags = list;
      else target.aliases = list;
      if (list.length === 0) removePresent(target, fieldName);
      else ensurePresent(target, fieldName);
      recheck = true;
    }

    if (recheck && this.validators !== undefined && this.validators !== null && typeof this.validators.findDuplicate === 'function') {
      const others = this.allEntries().filter((entry) => entry !== target);
      const duplicate = this.validators.findDuplicate(target.title, others, { today: this.today });
      if (duplicate !== null && duplicate !== undefined) {
        return errorObject('duplicate', `改后的标题与 ${duplicate.id} 规范化后完全相同`, `请改写标题，或直接编辑 ${duplicate.id}`, entryIndex);
      }
    }
    return null;
  }

  /**
   * 追加日志（§7.5）：只追加、自动生成唯一 `J-` 编号、不查重、不参与 usage。
   *
   * @param {Record<string, unknown>} op
   * @returns {Promise<ApplyError|null>}
   */
  async applyLog(op) {
    const rawEntries = Array.isArray(op.entries) ? op.entries : [];
    if (rawEntries.length === 0) return errorObject('invalid_param', 'log 需要非空的 entries 数组', '请提供要记录的日志条目');

    /** @type {Array<{ title: string, content: string, fields: Array<{name: string, value: string}> }>} */
    const prepared = [];
    for (let index = 0; index < rawEntries.length; index += 1) {
      const raw = /** @type {Record<string, unknown>} */ (rawEntries[index] ?? {});
      const titleRaw = raw.title;
      if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
        return errorObject('invalid_param', '日志 title 必填且不能为空', '请给一句话标题', index);
      }
      const title = titleRaw.trim();
      if (title.includes('\n')) return errorObject('invalid_param', '日志 title 必须是单行', '把细节放进 content', index);

      const content = typeof raw.content === 'string' ? raw.content : '';
      if (content.trim().length === 0) {
        this.warnings.push(warn('journal-no-content', `日志「${title}」缺少内容（仍写入）`));
      }

      const relatedIds = stringList(raw.relatedMemoryIds);
      for (const id of relatedIds) {
        if (!this.allEntries().some((entry) => entry.id === id)) {
          this.warnings.push(warn('manual-edit-detected', `日志引用不存在的记忆编号 ${id}（仍写入：日志不该因引用笔误丢内容）`, undefined, id));
        }
      }

      if (this.validators !== undefined && this.validators !== null && typeof this.validators.scanEntryTexts === 'function') {
        const hits = this.validators.scanEntryTexts({ title, detail: content, tags: stringList(raw.tags), aliases: [] });
        if (Array.isArray(hits) && hits.length > 0) {
          return errorObject('sensitive', `日志命中敏感信息：${hits.map((hit) => `${hit.field}（${hit.category}）`).join('、')}（不回显原文）`, '改写后重试', index);
        }
      }

      /** @type {Array<{name: string, value: string}>} */
      const fields = [];
      const push = (/** @type {string} */ name, /** @type {unknown} */ value) => {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text.length > 0) fields.push({ name, value: text });
      };
      push('时间', raw.time);
      push('内容', content);
      push('结果', raw.result);
      push('决策', raw.decision);
      push('证据', raw.evidence);
      push('后续', raw.followUp);
      push('关联记忆', relatedIds.join(', '));
      push('标签', stringList(raw.tags).join(', '));

      prepared.push({ title, content, fields });
    }

    const filePath = path.join(this.memoryDir, `JOURNAL-${this.today}.md`);
    const journal = await this.journalFile(filePath);
    /** @type {JournalEntry[]} */
    const appended = [];
    for (const item of prepared) {
      const id = makeJournalId(this.today, timeLocal(this.now), journal.takenIds);
      journal.takenIds.add(id);
      const entry = {
        id,
        title: item.title,
        content: item.content,
        date: this.today,
        fields: item.fields,
        filePath,
        order: this.result.journalIds.length,
        raw: '',
      };
      appended.push(entry);
      this.result.journalIds.push(id);
    }
    journal.content = appendJournal(journal.original, this.today, appended);
    return null;
  }

  /**
   * 日志编号是否已存在于任何已加载的日志文件里（日志只在写入时懒加载，故仅供参考）。
   *
   * @param {string} journalId
   * @returns {boolean}
   */
  hasJournalId(journalId) {
    for (const journal of this.journals.values()) if (journal.takenIds.has(journalId)) return true;
    return false;
  }
}

/**
 * @param {{ projectRoot: string, memoryDir: string, config: Config, today: string, now: Date, validators?: Validators }} ctx
 * @returns {Promise<Editor>}
 */
async function createEditor(ctx) {
  const editor = new Editor(ctx);
  await editor.init();
  return editor;
}

// ────────────────────────── 写：applyBatch ──────────────────────────

/**
 * 唯一的写入入口：锁 → 收敛 → 重读 → 校验 → intent → 固定顺序落盘 → 提交。
 *
 * 注意：函数内部会**重新读取磁盘**（`model` 只用于取 `projectRoot`/`memoryDir`），
 * 因为 §12.2 要求"写入前发现改动就放弃旧快照、重读、重新校验"，最多重试两次。
 *
 * @param {ProjectModel} model
 * @param {Array<Record<string, unknown>>} ops
 * @param {{ config: Config, today?: string, now?: Date, validators?: Validators }} opts
 * @returns {Promise<BatchSuccess|BatchFailure>}
 */
export async function applyBatch(model, ops, opts) {
  const config = opts.config;
  const today = typeof opts.today === 'string' && opts.today.length > 0 ? opts.today : todayLocal();
  const now = opts.now instanceof Date ? opts.now : new Date();
  const memoryDir = typeof model?.memoryDir === 'string' && model.memoryDir.length > 0 ? model.memoryDir : '';

  if (memoryDir === '') {
    return { ...errorObject('degraded', '模型缺少 memoryDir（请先用 loadProject 取模型）', '重新 loadProject 后重试'), warnings: [] };
  }

  return withPathQueue(memoryDir, async () => {
    // 目录创建是 store 的职责（§3.9）：锁文件住在 .state/ 里，先把它建出来
    const ensured = await mkdirp(path.join(memoryDir, STATE_DIR));
    if (!ensured.ok) {
      return { ...errorObject('degraded', `创建 .state 目录失败：${ensured.error}`, '检查项目目录权限后重试'), warnings: [] };
    }

    const lock = await acquireLock(path.join(memoryDir, LOCK_FILE), {
      timeoutMs: config.lockTimeoutMs,
      staleMs: config.staleLockMs,
    });
    if (!lock.ok) {
      const code = lock.reason === 'locked' ? 'locked' : 'degraded';
      return {
        ...errorObject(code, lock.error ?? '拿不到跨进程写锁', '稍后重试；另一个会话正在写同一个项目的记忆'),
        warnings: lock.warnings ?? [],
      };
    }

    /** @type {Warning[]} */
    const warnings = [];
    /** @type {Warning[]} */
    const lockWarnings = lock.warnings;
    warnings.push(...lockWarnings);

    try {
      for (let attempt = 0; attempt <= MAX_WRITE_RETRY; attempt += 1) {
        // 收敛点：发现残留 intent 就前滚/回滚（§12.1 第 4 条）
        const converged = await converge(memoryDir, { warn: () => undefined });
        warnings.push(...converged.warnings);
        if (converged.degraded === true) {
          return {
            ...errorObject('degraded', `残留 intent 无法收敛（${converged.intentPath ?? ''}），本次未做任何写入`, '请人工检查 .state/intent.json 与相关文件'),
            warnings,
          };
        }

        const editor = await createEditor({
          projectRoot: typeof model?.projectRoot === 'string' ? model.projectRoot : memoryDir,
          memoryDir,
          config,
          today,
          now,
          ...(opts.validators === undefined ? {} : { validators: opts.validators }),
        });
        await editor.scan();
        const applied = await editor.applyOps(Array.isArray(ops) ? ops : []);
        if (applied.ok === false) return { ...applied, warnings: [...warnings, ...editor.warnings] };

        const committed = await editor.commit(intentOpOf(ops), { rebuildIndex: true });
        if (committed.ok) {
          return {
            ok: true,
            result: editor.result,
            warnings: [...warnings, ...editor.warnings, ...committed.warnings],
          };
        }

        if (committed.code === 'write_conflict' && attempt < MAX_WRITE_RETRY) {
          warnings.push(
            warn(
              'write-conflict',
              `文件在读取后被外部改动（${String(committed.conflictPath ?? '')}），已放弃旧快照并重读重试（第 ${attempt + 1} 次，最多 ${MAX_WRITE_RETRY} 次）`,
              committed.conflictPath,
            ),
          );
          continue;
        }

        return {
          ...errorObject(committed.code, committed.message, committed.nextStep),
          warnings: [...warnings, ...editor.warnings, ...committed.warnings],
        };
      }
      return {
        ...errorObject('write_conflict', `连续 ${MAX_WRITE_RETRY} 次重试后文件仍被外部改动，已放弃（绝不覆盖人工修改）`, '请确认没有其它工具在改这些文件后重试'),
        warnings,
      };
    } finally {
      await lock.release();
    }
  });
}

/**
 * intent 的操作类型（诊断用）。
 *
 * @param {Array<Record<string, unknown>>|undefined} ops
 * @returns {'batch'|'archive'|'restore'}
 */
function intentOpOf(ops) {
  const types = new Set((Array.isArray(ops) ? ops : []).map((op) => String(op?.type)));
  if (types.has('archive') && types.size === 1) return 'archive';
  if (types.has('restore') && types.size === 1) return 'restore';
  return 'batch';
}

// ──────────────── 写：会话边界写回 / 显式重建 / usage ────────────────

/**
 * 会话边界写回（§6.1 ①，由装配层在 `agent/created` 调用）：
 * 收敛残留 intent → 扫描 → 补发编号 / 修复重复编号 → 重建 `INDEX.md` → 落 `.state/ids`。
 *
 * 幂等：没有任何变化时不做任何写入（`wrote: false`）。
 * 失败不抛错（§1.4：记忆功能坏掉绝不能拖垮会话创建）。
 *
 * @param {ProjectModel} model
 * @param {{ config: Config, today?: string, now?: Date }} opts
 * @returns {Promise<{ ok: boolean, wrote: boolean, warnings: Warning[], error?: string }>}
 */
export async function syncAtBoundary(model, opts) {
  const result = await rebuildIndex(model, opts);
  if (result.ok === false) return { ok: false, wrote: false, warnings: result.warnings, error: result.message };
  return { ok: true, wrote: result.wrote, warnings: result.warnings };
}

/**
 * 显式重建 `INDEX.md`（§6.1 ③：`INDEX.md` 被删、水位线丢失、人工触发）。
 *
 * 与 `syncAtBoundary` 走同一条边界写回路径（补编号 / 修复重复编号也要跟着写回，
 * 否则 `INDEX.md` 会出现文件里根本没有的编号）；只是返回结构面向"重建"这个动作。
 *
 * @param {ProjectModel} model
 * @param {{ config: Config, today?: string, now?: Date }} opts
 * @returns {Promise<RebuildSuccess|RebuildFailure>}
 */
export async function rebuildIndex(model, opts) {
  const config = opts.config;
  const today = typeof opts.today === 'string' && opts.today.length > 0 ? opts.today : todayLocal();
  const now = opts.now instanceof Date ? opts.now : new Date();
  const memoryDir = typeof model?.memoryDir === 'string' && model.memoryDir.length > 0 ? model.memoryDir : '';
  if (memoryDir === '') {
    return { ...errorObject('degraded', '模型缺少 memoryDir（请先用 loadProject 取模型）', '重新 loadProject 后重试'), warnings: [] };
  }
  // 这个项目还没碰过记忆 → 不建目录、不落 INDEX.md（免得污染无关项目）
  if (!(await hasMemoryContent(memoryDir))) {
    return { ok: true, wrote: false, index: path.join(memoryDir, INDEX_FILE), warnings: [] };
  }

  return withPathQueue(memoryDir, async () => {
    // 目录创建是 store 的职责（§3.9）
    const ensured = await mkdirp(path.join(memoryDir, STATE_DIR));
    if (!ensured.ok) {
      return { ...errorObject('degraded', `创建 .state 目录失败：${ensured.error}`, '检查项目目录权限后重试'), warnings: [] };
    }

    const lock = await acquireLock(path.join(memoryDir, LOCK_FILE), {
      timeoutMs: config.lockTimeoutMs,
      staleMs: config.staleLockMs,
    });
    if (!lock.ok) {
      return {
        ...errorObject(lock.reason === 'locked' ? 'locked' : 'degraded', lock.error ?? '拿不到跨进程写锁', '稍后重试'),
        warnings: lock.warnings ?? [],
      };
    }

    /** @type {Warning[]} */
    const warnings = [...(lock.warnings ?? [])];
    try {
      const converged = await converge(memoryDir, { warn: () => undefined });
      warnings.push(...converged.warnings);
      if (converged.degraded === true) {
        return {
          ...errorObject('degraded', `残留 intent 无法收敛（${converged.intentPath ?? ''}），未重建 INDEX.md`, '请人工检查 .state/intent.json'),
          warnings,
        };
      }

      const editor = await createEditor({
        projectRoot: typeof model?.projectRoot === 'string' ? model.projectRoot : memoryDir,
        memoryDir,
        config,
        today,
        now,
      });
      await editor.scan();
      const committed = await editor.commit('reindex', { rebuildIndex: true });
      if (committed.ok === false) {
        return { ...errorObject(committed.code, committed.message, committed.nextStep), warnings: [...warnings, ...editor.warnings, ...committed.warnings] };
      }
      return {
        ok: true,
        wrote: committed.paths.length > 0,
        index: editor.indexPath,
        warnings: [...warnings, ...editor.warnings, ...committed.warnings],
      };
    } catch (error) {
      return { ...errorObject('degraded', `重建失败：${describeError(error)}`, '稍后重试'), warnings };
    } finally {
      await lock.release();
    }
  });
}

/**
 * `usage` 落盘（§8.2：只有返回长期记忆正文才计入；`usage` 只影响搜索排序）。
 *
 * 纯函数 `bumpUsage` 负责算，这里只负责读改写与原子落盘（`.state/ids` 不动）。
 *
 * @param {ProjectModel} model
 * @param {string[]} ids 本次读取正文的长期记忆编号
 * @param {{ now?: Date|string }} [opts]
 * @returns {Promise<{ ok: boolean, usage: Record<string, {count: number, lastUsedAt: string}>, warnings: Warning[], error?: string }>}
 */
export async function recordUsage(model, ids, opts = {}) {
  const memoryDir = typeof model?.memoryDir === 'string' && model.memoryDir.length > 0 ? model.memoryDir : '';
  if (memoryDir === '') return { ok: false, usage: model?.usage ?? {}, warnings: [], error: '模型缺少 memoryDir' };

  const state = await loadState(memoryDir);
  const stamp = opts.now instanceof Date ? opts.now.toISOString() : typeof opts.now === 'string' ? opts.now : new Date().toISOString();
  const usage = bumpUsage(state.usage, Array.isArray(ids) ? ids : [], stamp);
  const saved = await saveState(memoryDir, { usage });
  return saved.ok
    ? { ok: true, usage, warnings: state.warnings }
    : { ok: false, usage, warnings: state.warnings, error: saved.error ?? '写入 usage 失败' };
}
