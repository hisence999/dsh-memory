/**
 * `INDEX.md` 的渲染与水位线注记。
 *
 * 行为依据：设计 §2.3（内容规则与重建顺序）、§5.2 结论 2/4（`★` 只给参与注入的置顶条，
 * 其余置顶只留人工意图）、§5.6（手工超限条目仍列出，行尾标 `⚠ 超限未注入`）、
 * §6.1（头部 `next-id` 是水位线的第二份记录）、§9.4（排序链）、§4.2（状态派生）。
 *
 * `INDEX.md` 是**可重建派生物**：本模块只做"从模型渲染出确定性文本"与"从文本读回
 * `next-id`"两件事，不碰磁盘（写盘由 store 负责）。
 *
 * 排序链（§9.4）：`置顶 > 类型(约定>事实>流程>经验) > 置信度 > 优先级 > 创建日期 > 编号`。
 * 两处方向由本文件定死，注入层复用 `compareInjectionOrder` 以保持两处一致：
 *   - 创建日期：**新者优先**（与 §8.2 第 10 键"新者优先"口径一致）；
 *   - 编号：**升序**（§2.3 明确"末位按编号升序"）。
 */

import {
  CONFIDENCES,
  KIND_LABEL,
  KIND_ORDER,
  PRIORITIES,
  effectiveStatus,
  measureEntry,
  todayLocal,
} from './parse.js';

/** 头部水位线注记的前缀（§2.3）。 */
const NOTE_PREFIX = 'next-id:';

/** 人类说明行（固定文本，不含任何动态数字）。 */
const HEADER_NOTE = '（本文件由记忆插件生成，是可重建的派生物；人工可自由重排，重建时会按规则重写。）';

/** 无条目时的占位行（与快照索引段口径一致）。 */
const EMPTY_LINE = '（暂无长期记忆）';

/** 行尾标记：非注入的置顶条（§2.3）。 */
const PINNED_MARK = '（置顶）';

/** 行尾标记：超限未注入（§5.6）。 */
const OVERLENGTH_MARK = '⚠ 超限未注入';

/** 分组顺序（§2.3）：active → candidate → superseded → expired；末尾兜底组见下。 */
const STATUS_GROUPS = ['active', 'candidate', 'superseded', 'expired'];

/**
 * 兜底分组：人工把 `状态：archived` 写进活动文件时用它，保证条目**不静默消失**
 * （正常路径永远不会出现：归档会把条目移到 `archive/` 下）。
 */
const ANOMALY_GROUP = 'archived';

/** @typedef {import('./parse.js').Entry} Entry */

/**
 * @typedef {object} SizeConfig 长度上限（config 的子集，§5.6）
 * @property {number} maxTitleChars
 * @property {number} detailMaxChars
 * @property {number} itemMaxChars
 */

/**
 * @typedef {object} IndexModel
 * @property {Entry[]} [active] 非归档文件中的条目（首选）
 * @property {Entry[]} [entries] 活动 + 归档（缺 `active` 时按路径过滤出活动条目）
 * @property {number} [nextId] 水位线（已分配的最大编号）
 */

/**
 * @typedef {object} Row 渲染行
 * @property {Entry} entry
 * @property {string} status 派生状态
 * @property {boolean} overlength
 */

/**
 * 生成 `INDEX.md` 头部的水位线注记行。
 *
 * @param {number} nextId 水位线（已分配的最大编号）
 * @returns {string} 形如 `next-id: 0011`
 */
export function indexNoteLine(nextId) {
  const value = typeof nextId === 'number' && Number.isFinite(nextId) ? Math.max(0, Math.trunc(nextId)) : 0;
  return `${NOTE_PREFIX} ${String(value).padStart(4, '0')}`;
}

/**
 * 从 `INDEX.md` 内容里读回水位线注记。
 *
 * 人工写坏的形式（缺前导零、多余空格、全角冒号）一律容错接受；读不出返回 `null`
 * ——此时水位线按 §6.1 由其它三处取 max 重建，不报错。
 *
 * @param {string} content
 * @returns {number|null}
 */
export function readIndexNote(content) {
  if (typeof content !== 'string') return null;
  const matched = /^[ \t]*next-id[ \t]*[:：][ \t]*#?0*(\d+)[ \t]*$/m.exec(content);
  if (matched === null) return null;
  const value = Number(matched[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * 条目是否超限（§5.6：标题 / 详细 / 单条总计任一超限即"超限未注入"）。
 *
 * 判定口径必须与 `snapshot.js` 一致，故导出给注入层复用（唯一的实现）。
 *
 * @param {Entry} entry
 * @param {SizeConfig} [config]
 * @returns {{ overlength: boolean, codes: string[] }} codes ∈ overlength-title/detail/item
 */
export function isOverlength(entry, config) {
  /** @type {string[]} */
  const codes = [];
  if (config === undefined || config === null) return { overlength: false, codes };
  const size = measureEntry(entry);
  if (size.titleChars > config.maxTitleChars) codes.push('overlength-title');
  if (size.detailChars > config.detailMaxChars) codes.push('overlength-detail');
  if (size.itemChars > config.itemMaxChars) codes.push('overlength-item');
  return { overlength: codes.length > 0, codes };
}

/**
 * 渲染 `INDEX.md` 全文（确定性：同一模型 + 同一天必然产出逐字符相同的结果）。
 *
 * 结构：H1 → `next-id` 注记 → 固定说明行 → 条目行（参与注入的置顶条在前，随后按
 * 状态分组 active → candidate → superseded → expired）。
 *
 * @param {IndexModel} [model]
 * @param {{ today?: string, config?: SizeConfig, overlengthIds?: Iterable<string> }} [opts]
 *        `today` 用于派生 expired；`config` 用于超限判定（不传则不渲染超限标记）；
 *        `overlengthIds` 供调用方自行预先判定时传入
 * @returns {string}
 */
export function renderIndex(model, opts = {}) {
  const safeModel = model ?? {};
  const today = typeof opts.today === 'string' && opts.today.length > 0 ? opts.today : todayLocal();
  const config = opts.config;

  /** @type {Set<string>} */
  const precomputed = new Set();
  if (opts.overlengthIds !== undefined) {
    for (const id of opts.overlengthIds) precomputed.add(id);
  }

  /** @type {Row[]} */
  const rows = activeEntriesOf(safeModel).map((entry) => {
    const status = effectiveStatus(entry, today);
    const judged = isOverlength(entry, config);
    const overlength = judged.overlength || (entry.id !== null && precomputed.has(entry.id));
    return { entry, status, overlength };
  });

  // 第一段：参与注入的置顶条目（渲染 ★），按去掉首键的排序链
  const starredRows = rows
    .filter((row) => row.status === 'active' && !row.overlength && row.entry.pinned === true)
    .sort((a, b) => compareInjectionOrder(a.entry, b.entry, true));
  /** @type {Set<string|null>} */
  const listed = new Set(starredRows.map((row) => row.entry.id));

  // 第二段：按状态分组的其余条目（已列过的置顶条不重复出现）
  /** @type {Row[]} */
  const grouped = [];
  for (const group of [...STATUS_GROUPS, ANOMALY_GROUP]) {
    const inGroup = rows
      .filter((row) => row.status === group && !listed.has(row.entry.id))
      .sort((a, b) => compareInjectionOrder(a.entry, b.entry, false));
    grouped.push(...inGroup);
  }

  const body = [...starredRows, ...grouped].map((row) => renderLine(row.entry, row.status, row.overlength));
  const lines = [
    '# 项目记忆索引',
    '',
    indexNoteLine(typeof safeModel.nextId === 'number' ? safeModel.nextId : 0),
    '',
    HEADER_NOTE,
    '',
  ];
  if (body.length === 0) lines.push(EMPTY_LINE);
  else lines.push(...body);
  return `${lines.join('\n')}\n`;
}

/**
 * 注入排序链（§9.4）：置顶 → 类型 → 置信度 → 优先级 → 创建日期（新者优先）→ 编号（升序）。
 *
 * ★ 段与状态分组用同一函数：`usePinned` = true 时比较首键，分组内传 false
 * （否则自指；非注入条目按 `置顶 = false` 处理，§2.3）。
 *
 * @param {Entry} a
 * @param {Entry} b
 * @param {boolean} usePinned
 * @returns {number}
 */
export function compareInjectionOrder(a, b, usePinned) {
  if (usePinned) {
    const pinnedA = a.pinned === true ? 1 : 0;
    const pinnedB = b.pinned === true ? 1 : 0;
    if (pinnedA !== pinnedB) return pinnedB - pinnedA;
  }

  const kindA = KIND_ORDER[a.kind] ?? 99;
  const kindB = KIND_ORDER[b.kind] ?? 99;
  if (kindA !== kindB) return kindA - kindB;

  const rankA = rankIn(CONFIDENCES, a.confidence);
  const rankB = rankIn(CONFIDENCES, b.confidence);
  if (rankA !== rankB) return rankA - rankB;

  const weightA = rankIn(PRIORITIES, a.priority);
  const weightB = rankIn(PRIORITIES, b.priority);
  if (weightA !== weightB) return weightA - weightB;

  const createdA = typeof a.created === 'string' ? a.created : '';
  const createdB = typeof b.created === 'string' ? b.created : '';
  if (createdA !== createdB) return createdA < createdB ? 1 : -1; // 新者优先

  const idA = idNumber(a);
  const idB = idNumber(b);
  if (idA !== idB) return idA - idB; // 编号升序
  // 全键相等的兜底键（合法数据下不可达）：保证"内容相同、入参顺序不同"时行序仍逐字符一致。
  // 注意：这是**唯一**的注入排序实现，snapshot.js 必须复用它（否则 §2.3 与 §9.4 会分叉）。
  const dateA = typeof a.fileDate === 'string' ? a.fileDate : '';
  const dateB = typeof b.fileDate === 'string' ? b.fileDate : '';
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return (a.order ?? 0) - (b.order ?? 0);
}

/**
 * 渲染一行条目（§2.3 的行格式：`[★ #0007] 约定 · 标题 · 状态 active`）。
 *
 * `★` 只给"参与注入的置顶条"；超限条目不参与注入，因此即使置顶也只渲染行尾
 * `（置顶）`，两个标记的顺序固定为 `（置顶）⚠ 超限未注入`。
 *
 * @param {Entry} entry
 * @param {string} status 派生状态
 * @param {boolean} overlength
 * @returns {string}
 */
function renderLine(entry, status, overlength) {
  const injects = status === 'active' && !overlength;
  const starred = injects && entry.pinned === true;
  const idText = entry.id === null ? '未编号' : entry.id;
  const kindText = KIND_LABEL[entry.kind] ?? String(entry.kind);

  /** @type {string[]} */
  const marks = [];
  if (entry.pinned === true && !starred) marks.push(PINNED_MARK);
  if (overlength) marks.push(OVERLENGTH_MARK);

  const head = `[${starred ? '★ ' : ''}${idText}] ${kindText} · ${entry.title} · 状态 ${status}`;
  return marks.length === 0 ? head : `${head} ${marks.join('')}`;
}

/**
 * 取模型的"全部非归档条目"：优先用 `model.active`，否则从 `model.entries` 按路径过滤。
 *
 * @param {IndexModel} model
 * @returns {Entry[]}
 */
function activeEntriesOf(model) {
  if (Array.isArray(model.active)) return model.active;
  if (!Array.isArray(model.entries)) return [];
  return model.entries.filter((entry) => !isArchivedPath(entry.filePath));
}

/**
 * @param {string|undefined} filePath
 * @returns {boolean}
 */
function isArchivedPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return /(^|[\\/])archive([\\/]|$)/.test(filePath);
}

/**
 * 值在枚举里的下标（不在其中排到最后）。
 *
 * @param {readonly string[]} list
 * @param {string} value
 * @returns {number}
 */
function rankIn(list, value) {
  const index = list.indexOf(value);
  return index === -1 ? 99 : index;
}

/**
 * @param {Entry} entry
 * @returns {number}
 */
function idNumber(entry) {
  if (typeof entry.id !== 'string') return Number.MAX_SAFE_INTEGER;
  const matched = /^#?(\d+)$/.exec(entry.id.trim());
  if (matched === null) return Number.MAX_SAFE_INTEGER;
  const value = Number(matched[1]);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}
