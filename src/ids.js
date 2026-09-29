/**
 * 编号原语：编号解析/格式化、水位线判定、新编号分配、重复编号修复。
 *
 * 设计依据 §6.1：
 *  - 编号 `#0001` 形如定长四位（超出四位自然增长），**整个项目内唯一**（跨活动与归档）；
 *  - 水位线两处存放：`.state/ids`（机器）与 `INDEX.md` 头部 `next-id` 注记（人类可见）；
 *  - 新编号 = `max(.state/ids, INDEX.md 注记, 所有活动 ID, 所有归档 ID) + 1`；
 *  - 重复编号修复：按"活动文件（文件名日期升序）→ 归档文件（文件名日期升序）→
 *    同一文件内出现顺序"排序，**第一个保留原号，其余重发新号并记 warn**，不自动合并正文。
 *
 * 全部为纯函数（`repairDuplicates` 不修改入参），便于单测；只依赖 `node:` 内置模块。
 */

/**
 * @typedef {object} Warning
 * @property {string} code
 * @property {string} message
 * @property {string} [filePath]
 * @property {string} [id]
 */

/**
 * @typedef {object} IdEntry 本模块只需要编号判定所需的字段（与 §2 的 Entry 结构兼容）
 * @property {string|null} id
 * @property {string} [filePath]
 * @property {string} [fileDate]
 * @property {number} [order]
 * @property {string|null} [archivedAt]
 */

/**
 * 解析编号文本。
 *
 * 容错范围：允许前导 `#`、前后空白、任意位数字（`'#0007'`、`'0007'`、`'7'`、`'  #12 '`）。
 * 其他一律返回 `null`（例如 `'#abc'`、`'J-2026'`、空串）。数值超出安全整数同样返回 `null`。
 *
 * @param {string} text
 * @returns {number|null} 编号数值；非法返回 `null`
 */
export function parseId(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const matched = /^#?(\d+)$/.exec(trimmed);
  if (matched === null) return null;
  const value = Number(matched[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 格式化编号为 `#0007`（不足四位补零，超过四位按实际位数）。
 *
 * @param {number} n 非负整数
 * @returns {string} 非法输入（非有限数、负数）返回 `''`
 */
export function formatId(n) {
  const value = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return '';
  return `#${String(value).padStart(4, '0')}`;
}

/**
 * 水位线 = `max(.state/ids, INDEX.md 注记, 所有活动 ID, 所有归档 ID)`（§6.1）。
 *
 * 任何一处缺失/损坏都按"该处无贡献"处理（不抛错）：水位线丢失正是靠这条式子重建的。
 *
 * @param {{ idsFileContent?: string|null, indexNote?: number|string|null, activeIds?: Array<string|{id?: string|null}|null>, archivedIds?: Array<string|{id?: string|null}|null> }} [input]
 * @returns {number} 水位线；四处都没有有效编号时返回 `0`（编号从 1 起，0 是安全的加性单位元）
 */
export function watermark(input = {}) {
  const candidates = [
    numberFromIdsFile(input.idsFileContent),
    numberFromNote(input.indexNote),
    maxIdOf(input.activeIds),
    maxIdOf(input.archivedIds),
  ];
  let max = 0;
  for (const value of candidates) if (value > max) max = value;
  return max;
}

/**
 * 从水位线之后开始分配 `count` 个编号。
 *
 * @param {number} startWatermark 当前水位线（已分配的最大编号）
 * @param {number} count 需要分配的个数
 * @returns {{ ids: string[], next: number }} `next` = 分配后的新水位线
 */
export function allocate(startWatermark, count) {
  const start = Number.isFinite(startWatermark) ? Math.max(0, Math.trunc(startWatermark)) : 0;
  const size = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  /** @type {string[]} */
  const ids = [];
  for (let offset = 1; offset <= size; offset += 1) ids.push(formatId(start + offset));
  return { ids, next: start + size };
}

/**
 * 修复重复编号（手工复制粘贴导致），不合并正文。
 *
 * 仲裁顺序（§6.1）：**活动文件（文件名日期升序）→ 归档文件（文件名日期升序）→
 * 同一文件内出现顺序**；每个编号的第一个出现者保留原号，其余重发新号并记
 * `duplicate-id-repaired` 告警。新号从"所有出现过的合法编号的最大值"之后递增，
 * 因此不会与任何既有编号冲突。
 *
 * 无编号（`id === null`）的条目**不在这里处理**：补发编号属于扫描期职责
 * （`missing-id-assigned`，由 store 调 `allocate` 完成）。
 *
 * @param {IdEntry[]} entries
 * @returns {{ entries: IdEntry[], warnings: Warning[], reassigned: Array<{ path: string, from: string, to: string }> }}
 *          `entries` 是一个新数组（保持入参顺序），只替换被重发编号的条目对象
 */
export function repairDuplicates(entries) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {Warning[]} */
  const warnings = [];
  /** @type {Array<{ path: string, from: string, to: string }>} */
  const reassigned = [];

  let max = 0;
  for (const entry of list) {
    const value = parseId(String(entry?.id ?? ''));
    if (value !== null && value > max) max = value;
  }

  /** 需要重发编号的条目下标 → 新编号 */
  /** @type {Map<number, string>} */
  const replacements = new Map();
  const seen = new Set();
  const arbitrationOrder = list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareForArbitration(a.entry, b.entry, a.index, b.index));

  for (const { entry, index } of arbitrationOrder) {
    const value = parseId(String(entry?.id ?? ''));
    if (value === null) continue;
    const current = formatId(value);
    if (!seen.has(current)) {
      seen.add(current);
      continue;
    }
    max += 1;
    const fresh = formatId(max);
    seen.add(fresh);
    replacements.set(index, fresh);
    const filePath = typeof entry.filePath === 'string' ? entry.filePath : '';
    warnings.push({
      code: 'duplicate-id-repaired',
      message: `编号 ${current} 重复出现，已为后出现的条目重发编号 ${fresh}（未合并正文；文件：${filePath || '未知'}）`,
      filePath,
      id: fresh,
    });
    reassigned.push({ path: filePath, from: current, to: fresh });
  }

  const result = list.map((entry, index) => {
    const fresh = replacements.get(index);
    if (fresh === undefined) return entry;
    return { ...entry, id: fresh };
  });

  return { entries: result, warnings, reassigned };
}

/**
 * 仲裁顺序比较：活动先于归档；同类内按文件名日期升序、再按路径、再按文件内出现顺序。
 *
 * @param {IdEntry} a
 * @param {IdEntry} b
 * @param {number} indexA 入参下标，仅用于最终稳定兜底
 * @param {number} indexB
 * @returns {number}
 */
function compareForArbitration(a, b, indexA, indexB) {
  const archivedA = isArchivedEntry(a) ? 1 : 0;
  const archivedB = isArchivedEntry(b) ? 1 : 0;
  if (archivedA !== archivedB) return archivedA - archivedB;

  const dateA = entryDate(a);
  const dateB = entryDate(b);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;

  const pathA = typeof a.filePath === 'string' ? a.filePath : '';
  const pathB = typeof b.filePath === 'string' ? b.filePath : '';
  if (pathA !== pathB) return pathA < pathB ? -1 : 1;

  const orderA = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : 0;
  const orderB = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : 0;
  if (orderA !== orderB) return orderA - orderB;

  return indexA - indexB;
}

/**
 * 条目是否来自归档区：优先看 `archivedAt`，其次看路径里是否有 `archive` 路径段。
 *
 * @param {IdEntry} entry
 * @returns {boolean}
 */
function isArchivedEntry(entry) {
  if (typeof entry.archivedAt === 'string' && entry.archivedAt !== '') return true;
  const filePath = typeof entry.filePath === 'string' ? entry.filePath : '';
  return /(^|[\\/])archive([\\/]|$)/.test(filePath);
}

/**
 * 条目归属日期：优先用 `fileDate`，缺失时从文件名的 `YYYY-MM-DD` 推导。
 *
 * @param {IdEntry} entry
 * @returns {string} 空串表示无法判定（排在最前）
 */
function entryDate(entry) {
  if (typeof entry.fileDate === 'string' && entry.fileDate !== '') return entry.fileDate;
  const filePath = typeof entry.filePath === 'string' ? entry.filePath : '';
  const matched = /(\d{4}-\d{2}-\d{2})/.exec(filePath);
  return matched === null ? '' : matched[1];
}

/**
 * 从 `.state/ids` 的内容里取水位线数值：支持纯数字、`#0011`、以及
 * `{"nextId":11}` 形态的 JSON（人工误改时的容错，不抛错）。
 *
 * @param {string|null|undefined} content
 * @returns {number} 无法识别返回 0
 */
function numberFromIdsFile(content) {
  if (typeof content !== 'string') return 0;
  const trimmed = content.trim();
  if (trimmed === '') return 0;

  const plain = parseId(trimmed);
  if (plain !== null) return plain;

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
    if (typeof parsed === 'object' && parsed !== null) {
      const record = /** @type {Record<string, unknown>} */ (parsed);
      for (const key of ['nextId', 'ids', 'watermark', 'value']) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
      }
    }
  } catch {
    // 不是 JSON：按"没有有效水位线"处理。
  }
  return 0;
}

/**
 * `INDEX.md` 头部注记的值（`readIndexNote` 返回 `number|null`，这里也容忍字符串）。
 *
 * @param {number|string|null|undefined} note
 * @returns {number}
 */
function numberFromNote(note) {
  if (typeof note === 'number') return Number.isFinite(note) ? Math.max(0, Math.trunc(note)) : 0;
  if (typeof note === 'string') return numberFromIdsFile(note);
  return 0;
}

/**
 * 编号清单里的最大编号。
 *
 * @param {Array<string|{id?: string|null}|null>|undefined} ids
 * @returns {number}
 */
function maxIdOf(ids) {
  if (!Array.isArray(ids)) return 0;
  let max = 0;
  for (const item of ids) {
    /** @type {string} */
    let raw = '';
    if (typeof item === 'string') raw = item;
    else if (typeof item === 'object' && item !== null && typeof item.id === 'string') raw = item.id;
    const value = parseId(raw);
    if (value !== null && value > max) max = value;
  }
  return max;
}
