/**
 * 去重、相似与机械冲突判定（设计 §8.3、§7.1、§11 示例 D）。
 *
 * 本模块是这些规则的**唯一实现**：store 不做重复实现，只按调用方注入的 `validators` 调用
 * （INTERFACES §3.9／§3.11）。三条保守原则：
 *  1. 规范化后**完全相同** → 判重复（拒绝整个批次），返回重复的编号；
 *  2. 规范化后**一条是另一条的子串**，或**编辑距离 ≤ 较长标题长度的 20%** → 只提示不拒绝，
 *     并说明命中的是哪一条判据（`substring` / `edit-distance`）；
 *  3. 冲突必须**四要素同时成立**，缺一不判（跨类型、主题键无交集、指纹相同、其余文本不同都不算冲突）——
 *     误拒绝一条新事实的代价高于暂时留两条待确认内容。
 *
 * 规范化统一走 `parse.normalize`（NFKC + 小写 + 路径分隔符统一 + 空白折叠）。
 */

import { normalize } from './parse.js';

/** @typedef {import('./parse.js').Entry} Entry */

/** 端口：`3080 端口` / `端口 3080` / `:3080`（设计 §8.3 第 3 条）。 */
const PORT_AFTER_RE = /(\d{2,5})\s*(?:号)?\s*(?:端口|port)/gi;
const PORT_BEFORE_RE = /(?:端口|port)\s*[:：]?\s*(\d{2,5})/gi;
const PORT_COLON_RE = /[:：](\d{2,5})(?!\d)/g;

/** 版本号：`v1.2.3` / `1.2`。 */
const VERSION_RE = /v?(\d+(?:\.\d+)+)(?![.\d])/gi;

/** 路径：含 `/` 或 `\` 且至少两段的词。 */
const PATH_RE = /[^\s，。；：、"'`（）()[\]{}<>|]+[\\/][^\s，。；：、"'`（）()[\]{}<>|]*/g;

/** 独立数字串。 */
const NUMBER_RE = /(?<!\d)\d+(?!\d)/g;

/** 相似提示里出现的判据名（INTERFACES §3.11 冻结的取值）。 */
export const SIMILAR_REASONS = Object.freeze(['substring', 'edit-distance']);

/**
 * 该条目是否已归档（归档条目对写入校验"不可见"）。
 *
 * @param {Entry} entry
 * @returns {boolean}
 */
function isArchived(entry) {
  return entry?.status === 'archived' || (typeof entry?.archivedAt === 'string' && entry.archivedAt.length > 0);
}

/**
 * 一次正则扫描，取回所有匹配（含 group 1 或整段匹配在文本中的位置）。
 *
 * @param {string} text
 * @param {RegExp} pattern 必须带 `g`
 * @returns {Array<{ value: string, start: number, end: number }>}
 */
function matchAll(text, pattern) {
  /** @type {Array<{ value: string, start: number, end: number }>} */
  const out = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    out.push({ value: match[1] ?? match[0], start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(text);
  }
  return out;
}

/**
 * @param {number} index
 * @param {Array<{ start: number, end: number }>} spans
 * @returns {boolean}
 */
function insideSpans(index, spans) {
  return spans.some((span) => index >= span.start && index < span.end);
}

/**
 * 标题 → 分类指纹（端口／版本／路径／独立数字）。
 *
 * 独立数字会排除掉落在端口／版本／路径里面的数字，否则 `v1.2.3` 会额外贡献 `1/2/3`，
 * 让"指纹集合不同"这个判据变得过于敏感。
 *
 * @param {string} title
 * @returns {{ ports: Set<string>, versions: Set<string>, paths: Set<string>, numbers: Set<string>, spans: Array<{ start: number, end: number }> }}
 */
export function fingerprintParts(title) {
  const text = normalize(title);
  /** @type {Set<string>} */
  const ports = new Set();
  /** @type {Set<string>} */
  const versions = new Set();
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {Set<string>} */
  const numbers = new Set();
  /** @type {Array<{ start: number, end: number }>} */
  const spans = [];

  for (const hit of [...matchAll(text, PORT_AFTER_RE), ...matchAll(text, PORT_BEFORE_RE), ...matchAll(text, PORT_COLON_RE)]) {
    ports.add(normalize(hit.value));
    spans.push({ start: hit.start, end: hit.end });
  }
  for (const hit of matchAll(text, VERSION_RE)) {
    versions.add(normalize(hit.value));
    spans.push({ start: hit.start, end: hit.end });
  }
  for (const hit of matchAll(text, PATH_RE)) {
    const value = normalize(hit.value).replace(/\/+$/, '');
    if (value.split('/').filter((segment) => segment.length > 0).length < 2) continue;
    paths.add(value);
    spans.push({ start: hit.start, end: hit.end });
  }
  for (const hit of matchAll(text, NUMBER_RE)) {
    if (insideSpans(hit.start, spans)) continue;
    numbers.add(hit.value);
  }

  return { ports, versions, paths, numbers, spans };
}

/**
 * 标题的指纹集合（§8.3 第 3 条："从标题抽取的指纹集合"）。
 *
 * @param {string} title
 * @returns {Set<string>} 端口／版本／路径／独立数字的并集
 */
export function extractFingerprints(title) {
  const parts = fingerprintParts(title);
  return new Set([...parts.ports, ...parts.versions, ...parts.paths, ...parts.numbers]);
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/**
 * 去掉文本里的某个 token（ASCII token 按词边界，避免 `us` 吃掉 `user` 里的字符）。
 *
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
function removeToken(text, token) {
  if (token.length === 0) return text;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ascii = /^[\x20-\x7e]+$/.test(token);
  const pattern = new RegExp(ascii ? `(?<![a-z0-9])${escaped}(?![a-z0-9])` : escaped, 'g');
  return text.replace(pattern, ' ');
}

/**
 * 主题键：`标签` 与 `别名`（规范化后），带上是哪一个字段（冲突理由里要写出来）。
 *
 * @param {{ tags?: unknown, aliases?: unknown }} entry
 * @returns {Array<{ field: '标签'|'别名', key: string }>}
 */
function topicPairs(entry) {
  /** @type {Array<{ field: '标签'|'别名', key: string }>} */
  const pairs = [];
  for (const [key, field] of /** @type {Array<[string, '标签'|'别名']>} */ ([['tags', '标签'], ['aliases', '别名']])) {
    const raw = /** @type {Record<string, unknown>} */ (entry)?.[key];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、]/) : [];
    for (const item of list) {
      const normalized = normalize(typeof item === 'string' ? item : String(item ?? ''));
      if (normalized.length > 0) pairs.push({ field, key: normalized });
    }
  }
  return pairs;
}

/**
 * 两条条目的主题键交集，渲染成 `标签=port` 这种碎片。
 *
 * @param {Array<{ field: string, key: string }>} left
 * @param {Array<{ field: string, key: string }>} right
 * @returns {string[]}
 */
function sharedTopicTexts(left, right) {
  /** @type {string[]} */
  const shared = [];
  for (const item of left) {
    if (!right.some((other) => other.key === item.key)) continue;
    const text = `${item.field}=${item.key}`;
    if (!shared.includes(text)) shared.push(text);
  }
  return shared.sort();
}

/**
 * "去掉指纹与主题词后"的其余文本（§8.3 第 4 条）。
 *
 * @param {{ ports: Set<string>, versions: Set<string>, paths: Set<string>, numbers: Set<string> }} parts
 * @param {Array<{ field: string, key: string }>} topics
 * @param {string} rawTitle
 * @returns {string}
 */
function restText(parts, topics, rawTitle) {
  let text = normalize(rawTitle);
  for (const token of [...parts.ports, ...parts.versions, ...parts.paths, ...parts.numbers]) text = removeToken(text, token);
  for (const topic of topics) text = removeToken(text, topic.key);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 两个 Unicode 字符串的编辑距离（按码点，不按 UTF-16 单元）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  const left = [...a];
  const right = [...b];
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  /** @type {number[]} */
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    /** @type {number[]} */
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/**
 * 是否"基本相同"（§8.3 第 4 条）：相等，或编辑距离 ≤ 较长者 20%。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function nearlySame(a, b) {
  if (a === b) return true;
  if (a.length === 0 || b.length === 0) return false;
  const maxLength = Math.max([...a].length, [...b].length);
  return editDistance(a, b) <= maxLength * 0.2;
}

/**
 * 冲突理由里的"指纹差异"碎片，形如 `端口 3180 ≠ 3080`。
 *
 * @param {ReturnType<typeof fingerprintParts>} left 候选（新条目）
 * @param {ReturnType<typeof fingerprintParts>} right 已有条目
 * @returns {string}
 */
function diffText(left, right) {
  /** @type {string[]} */
  const parts = [];
  /** @param {string} label @param {Set<string>} a @param {Set<string>} b */
  const push = (label, a, b) => {
    const onlyA = [...a].filter((item) => !b.has(item)).sort();
    const onlyB = [...b].filter((item) => !a.has(item)).sort();
    if (onlyA.length === 0 && onlyB.length === 0) return;
    parts.push(`${label} ${onlyA.join('/') || '（无）'} ≠ ${onlyB.join('/') || '（无）'}`);
  };
  push('端口', left.ports, right.ports);
  push('版本', left.versions, right.versions);
  push('路径', left.paths, right.paths);
  push('数字', left.numbers, right.numbers);
  return parts.slice(0, 2).join('；');
}

/**
 * 精确重复：规范化后标题完全相同（§8.3 第一条）。
 *
 * 归档条目**也参与**重复判定（§7.1 没有给它开例外），这样"归档后又写一条同名"不会
 * 悄悄造出两条同名记忆；重复命中时的下一步会提示可用 `restore` 复用归档条目。
 *
 * @param {string} title
 * @param {Entry[]} entries
 * @param {{ today?: string }} [ctx]
 * @returns {{ id: string } | null}
 */
export function findDuplicate(title, entries, ctx) {
  void ctx;
  const target = normalize(title);
  if (target.length === 0) return null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    if (normalize(entry.title) !== target) continue;
    return { id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : '（本批中尚未编号的新条目）' };
  }
  return null;
}

/**
 * 高度相似：规范化后一条是另一条的子串，或编辑距离 ≤ 较长标题长度的 20%（§8.3 第二条）。
 *
 * **只提示不拒绝**；归档条目不参与（它已经不在活动视图里）。
 *
 * @param {string} title
 * @param {Entry[]} entries
 * @param {{ today?: string }} [ctx]
 * @returns {Array<{ id: string, reason: string }>}
 */
export function findSimilar(title, entries, ctx) {
  void ctx;
  /** @type {Array<{ id: string, reason: string }>} */
  const hits = [];
  const target = normalize(title);
  if (target.length === 0) return hits;
  const targetLength = [...target].length;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || isArchived(entry)) continue;
    const other = normalize(entry.title);
    if (other.length === 0 || other === target) continue;

    let reason = '';
    if (target.includes(other) || other.includes(target)) {
      reason = 'substring';
    } else {
      const maxLength = Math.max(targetLength, [...other].length);
      if (maxLength > 0 && editDistance(target, other) <= maxLength * 0.2) reason = 'edit-distance';
    }
    if (reason === '') continue;
    hits.push({ id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : '（本批中尚未编号的新条目）', reason });
  }

  return hits.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 机械冲突：四要素同时成立才判（§8.3 第 3 条）。
 *
 * 1. 同一 `kind`；
 * 2. `标签` 或 `别名` 规范化后交集非空（主题由人写的字段确定）；
 * 3. 标题指纹集合有差异；
 * 4. 去掉指纹与主题词后其余文本相同，或编辑距离 ≤ 较长者 20%。
 *
 * `excludeIds`（本批 `supersedes` 指向的编号）**必须排除**：§7.1 的 R1.4 排除规则，
 * 没有它"冲突 → 带 supersedes 重发"会被同样的理由再拒一次，形成死锁（§11 示例 D）。
 * 已归档与 `superseded` 的条目不参与（它们已退出活动视图）。
 *
 * @param {{ kind?: unknown, title?: unknown, tags?: unknown, aliases?: unknown }} candidate
 * @param {Entry[]} entries
 * @param {{ today?: string, excludeIds?: string[] }} [ctx]
 * @returns {Array<{ id: string, reason: string }>}
 */
export function findConflicts(candidate, entries, ctx) {
  /** @type {Array<{ id: string, reason: string }>} */
  const conflicts = [];
  const context = ctx ?? {};
  const kind = typeof candidate?.kind === 'string' ? candidate.kind : '';
  const title = typeof candidate?.title === 'string' ? candidate.title : '';
  if (kind === '' || title.length === 0) return conflicts;

  const excluded = new Set(
    (Array.isArray(context.excludeIds) ? context.excludeIds : []).map((id) => normalize(String(id))).filter((id) => id.length > 0),
  );

  const candidateTopics = topicPairs(candidate);
  if (candidateTopics.length === 0) return conflicts; // 第 2 条不成立 → 不可能判冲突
  const candidateParts = fingerprintParts(title);
  const candidateFingerprints = new Set([...candidateParts.ports, ...candidateParts.versions, ...candidateParts.paths, ...candidateParts.numbers]);
  const candidateRest = restText(candidateParts, candidateTopics, title);

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry === candidate) continue;
    if (entry.kind !== kind) continue; // 第 1 条
    if (isArchived(entry) || entry.status === 'superseded') continue;
    if (typeof entry.id === 'string' && excluded.has(normalize(entry.id))) continue; // §7.1 排除规则

    const entryTopics = topicPairs(entry);
    const shared = sharedTopicTexts(candidateTopics, entryTopics);
    if (shared.length === 0) continue; // 第 2 条

    const entryParts = fingerprintParts(String(entry.title ?? ''));
    const entryFingerprints = new Set([...entryParts.ports, ...entryParts.versions, ...entryParts.paths, ...entryParts.numbers]);
    if (sameSet(candidateFingerprints, entryFingerprints)) continue; // 第 3 条：必须"有差异"

    const entryRest = restText(entryParts, entryTopics, String(entry.title ?? ''));
    if (!nearlySame(candidateRest, entryRest)) continue; // 第 4 条

    conflicts.push({
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : '（未编号）',
      reason: `同主题 ${shared.join('、')}；${diffText(candidateParts, entryParts)}`,
    });
  }

  return conflicts;
}
