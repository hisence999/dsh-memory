/**
 * Markdown 真相源的解析与渲染。
 *
 * 行为依据：设计 §5 全章（§5.1 文件形状、§5.2 字段表、§5.3 缺省值、§5.4 日志、
 * §5.5 语法契约的 11 条判定）、§4.1–§4.3（类型/状态/优先级/置信度）、
 * §4.2 派生规则、§6.1 编号形态、§8.1 规范化。
 *
 * 纪律（手册 §8.2）：
 *   - 本模块是**纯函数模块**：不碰文件系统、不读配置；长度上限由调用方按 config 判定
 *     （故这里导出 `measureEntry`）；
 *   - **解析绝不抛错**：任何异常都被收敛成 warn + damaged 标记，原文进 `raw`；
 *   - **绝不丢内容**：不认识的字段、游离行、空行后的备注、未知分节都原样保留并回写。
 */

// ────────────────────────────── 类型 ──────────────────────────────

/** @typedef {'convention'|'fact'|'procedure'|'lesson'} Kind */
/** @typedef {'active'|'candidate'|'superseded'|'archived'} Status */
/** @typedef {'high'|'medium'|'low'} Priority */
/** @typedef {'confirmed'|'observed'|'inferred'|'temporary'} Confidence */

/**
 * @typedef {object} Warning
 * @property {string} code
 * @property {string} message
 * @property {string} [filePath]
 * @property {string} [id]
 */

/**
 * 人类备注字段（不在 §5.2 表里的名字）。
 * @typedef {object} UnknownField
 * @property {string} name
 * @property {string} value
 * @property {string|null} anchor 紧邻的前一个**已知**字段名；null = 位于字段区最前（锚点是标题行）
 */

/**
 * 长期记忆条目。
 * @typedef {object} Entry
 * @property {string|null} id
 * @property {Kind} kind
 * @property {string} title
 * @property {string} detail
 * @property {Status} status
 * @property {boolean} pinned
 * @property {Priority} priority
 * @property {Confidence} confidence
 * @property {string} created
 * @property {string} updated
 * @property {string} expiresAt
 * @property {string[]} tags
 * @property {string[]} aliases
 * @property {string[]} related
 * @property {string[]} supersedes
 * @property {string|null} supersededBy
 * @property {string[]} relatedJournal
 * @property {string} source
 * @property {string|null} archivedAt
 * @property {string|null} archivedReason
 * @property {Status|null} archivedStatusBefore
 * @property {UnknownField[]} unknownFields
 * @property {string[]} presentFields 源文件里**显式写出**过的已知字段名（决定回写是否保留）
 * @property {string[]} orphanNotes 不属于本条目、必须原样回写的行（含条目内空行及其后的备注）
 * @property {string} filePath
 * @property {string} fileDate
 * @property {number} order
 * @property {string} raw
 */

/**
 * 项目日志条目。
 * @typedef {object} JournalEntry
 * @property {string|null} id
 * @property {string} title
 * @property {string} content 供检索/展示的正文（取「内容/详细/结果」中第一个非空）
 * @property {string} date
 * @property {Array<{name: string, value: string}>} fields 原始字段（保序，含未 know 的名字）
 * @property {string} filePath
 * @property {number} order
 * @property {string} raw
 */

// ────────────────────────── 常量与映射 ──────────────────────────

/** @type {Kind[]} 固定顺序：约定 > 事实 > 流程 > 经验（§4.1）。 */
export const KINDS = ['convention', 'fact', 'procedure', 'lesson'];

/** 内部值 → 展示名。 */
export const KIND_LABEL = { convention: '约定', fact: '事实', procedure: '流程', lesson: '经验' };

/** 展示名 → 内部值。 */
/** @type {Record<string, Kind>} */
export const LABEL_KIND = { 约定: 'convention', 事实: 'fact', 流程: 'procedure', 经验: 'lesson' };

/** 类型排序权重（注入/索引）：约定最前。 */
export const KIND_ORDER = { convention: 1, fact: 2, procedure: 3, lesson: 4 };

/** 状态优先序（§4.2）：数字越小越优先，只呈现一个。 */
export const STATUS_RANK = { archived: 0, superseded: 1, expired: 2, candidate: 3, active: 4 };

/** @type {Status[]} 允许落盘的状态（expired 是派生态）。 */
export const STATUSES = ['active', 'candidate', 'superseded', 'archived'];

/** @type {Confidence[]} 排序方向同此序（§4.3）。 */
export const CONFIDENCES = ['confirmed', 'observed', 'inferred', 'temporary'];

/** @type {Priority[]} */
export const PRIORITIES = ['high', 'medium', 'low'];

/** 类型默认优先级（§4.1）。 */
/** @type {Record<Kind, Priority>} */
export const KIND_DEFAULT_PRIORITY = { convention: 'high', fact: 'medium', procedure: 'medium', lesson: 'medium' };

/** 内部键 → 中文字段名（§5.2 表，回写顺序即此顺序）。 */
export const KEY_FIELD = {
  status: '状态',
  pinned: '置顶',
  priority: '优先级',
  confidence: '置信度',
  created: '创建',
  updated: '更新',
  expiresAt: '有效至',
  tags: '标签',
  aliases: '别名',
  related: '关联',
  supersedes: '取代',
  supersededBy: '取代者',
  relatedJournal: '关联日志',
  source: '来源',
  detail: '详细',
  archivedAt: '归档时间',
  archivedReason: '归档原因',
  archivedStatusBefore: '归档前状态',
};

/** 中文字段名 → 内部键。 */
export const FIELD_KEY = Object.fromEntries(Object.entries(KEY_FIELD).map(([key, name]) => [name, key]));

/** 已知字段名集合（解析用）。 */
export const FIELD_NAMES = Object.keys(FIELD_KEY);

/** 回写顺序（§5.2 表顺序）。 */
const FIELD_ORDER = Object.values(KEY_FIELD);

/** 日志文件的已知字段名（§5.4：只有标题与内容是必需，其余可选）。 */
export const JOURNAL_FIELD_NAMES = ['时间', '结果', '决策', '证据', '后续', '关联记忆', '标签', '内容', '详细'];

/** 标题行正则：`- [#0007] 陈述` / `- 陈述`（`-` 或 `*`）。 */
const TITLE_RE = /^([-*])\s+(?:\[#(\d{1,6})\]\s*)?(.*)$/;

/** 日志分节标题：`## J-20260920-1432 · 标题`。 */
const JOURNAL_HEADING_RE = /^##\s+(J-\d{8}-\d{4}(?:-\d+)?)\s*(?:[·:：]\s*(.*))?$/;

/** `## 约定` 这类分节标题。 */
const SECTION_RE = /^##\s+(.+?)\s*$/;

// ────────────────────────── 小工具 ──────────────────────────

/**
 * 拆行：统一 CRLF/LF，并丢掉文件末尾的空行（渲染产物总是以换行结尾，
 * 否则每次解析都会为"最后那个空行"报一次假告警）。
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length === 0) lines.pop();
  return lines;
}

/**
 * 缩进深度：Tab、全角空格、连续半角空格一律等价，只表示"更深一级"（§5.5 第 4 条）。
 * @param {string} prefix
 * @returns {number}
 */
function depthOf(prefix) {
  const expanded = prefix.replace(/\t/g, '  ').replace(/\u3000/g, '  ');
  return expanded.length;
}

/**
 * 字段行匹配：`<缩进>[- ]字段名：值`（列表标记可选，中英文冒号均可）。
 *
 * ⚠️ 必须显式吃掉可选的 `- `/`* ` 列表标记：否则 `  - 状态：active` 会被解析成
 * 字段名 `"- 状态"`，整份文件的字段全部退化成"未知字段"（真实踩过的坑）。
 *
 * @param {string} line
 * @returns {{ prefix: string, name: string, value: string }|null}
 */
function matchFieldLine(line) {
  const m = /^([ \t\u3000]*)(?:[-*][ \t\u3000]+)?([^ \t\u3000][^：:]*?)[ \t\u3000]*[：:][ \t\u3000]?([\s\S]*)$/.exec(line);
  if (m === null) return null;
  const prefix = m[1] ?? '';
  const name = (m[2] ?? '').trim();
  const value = m[3] ?? '';
  if (name.length === 0) return null;
  return { prefix, name, value };
}

/**
 * 逗号分隔列表 → 数组（中英文逗号、顿号都接受）。
 * @param {string} value
 * @returns {string[]}
 */
export function splitList(value) {
  return String(value ?? '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 一条警告。
 * @param {string} code
 * @param {string} message
 * @param {{ filePath?: string, id?: string }} [extra]
 * @returns {Warning}
 */
function warn(code, message, extra) {
  return { code, message, ...(extra?.filePath === undefined ? {} : { filePath: extra.filePath }), ...(extra?.id === undefined ? {} : { id: extra.id }) };
}

/**
 * 从文件名推导归属日期：`M-2026-09-20.md` / `JOURNAL-2026-09-20.md`。
 * @param {string} filePath
 * @returns {string|null} `YYYY-MM-DD`
 */
export function fileDateOf(filePath) {
  const base = String(filePath ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /^(?:M|JOURNAL)-(\d{4})-(\d{2})-(\d{2})\.md$/.exec(base);
  return m === null ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * 本机本地日期（**不用 UTC**，§4.2／§5.4）。
 * @param {Date} [now]
 * @returns {string} `YYYY-MM-DD`
 */
export function todayLocal(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 本地日历日的加减（按 UTC 毫秒运算，避免夏令时造成的整日偏移）。
 * @param {string} dateStr `YYYY-MM-DD`
 * @param {number} delta
 * @returns {string} `YYYY-MM-DD`
 */
export function addDays(dateStr, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (m === null) return dateStr;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * 86_400_000;
  const d = new Date(base);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 查询/比较用规范化（§8.1）：NFKC + 小写 + 路径分隔符统一 + 空白折叠。
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 是否已过期（派生状态，§4.2）。
 * @param {Entry} entry
 * @param {string} today
 * @returns {boolean}
 */
export function isExpired(entry, today) {
  const expiresAt = entry.expiresAt ?? '永久';
  if (expiresAt === '永久') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return false;
  return today > expiresAt;
}

/**
 * 对外呈现的唯一状态（§4.2）：archived > superseded > expired > candidate > active。
 * @param {Entry} entry
 * @param {string} today
 * @returns {Status|'expired'}
 */
export function effectiveStatus(entry, today) {
  if (entry.status === 'archived') return 'archived';
  if (entry.status === 'superseded') return 'superseded';
  if (isExpired(entry, today)) return 'expired';
  return entry.status;
}

/**
 * 是否参与注入（§5.2 结论 4：只有 active 且未过期、未归档的条目计入）。
 * @param {Entry} entry
 * @param {string} today
 * @returns {boolean}
 */
export function participatesInInjection(entry, today) {
  return effectiveStatus(entry, today) === 'active';
}

/**
 * 类型默认优先级。
 * @param {Kind} kind
 * @returns {Priority}
 */
export function defaultPriority(kind) {
  return KIND_DEFAULT_PRIORITY[kind] ?? 'medium';
}

/**
 * 度量条目字符数（供 §5.6 的长度判定；本模块不读配置，只用调用方传入的上限做比较）。
 * @param {Entry} entry
 * @returns {{ titleChars: number, detailChars: number, itemChars: number }}
 */
export function measureEntry(entry) {
  const rendered = renderEntry(entry).join('\n');
  return {
    titleChars: [...String(entry.title ?? '')].length,
    detailChars: [...String(entry.detail ?? '')].length,
    itemChars: [...rendered].length,
  };
}

// ────────────────────── 长期记忆：解析 ──────────────────────

/**
 * 解析一个长期记忆文件。
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{ entries: Entry[], warnings: Warning[], damaged: boolean, preamble: string[] }}
 */
export function parseMemoryFile(content, filePath) {
  /** @type {Entry[]} */
  const entries = [];
  /** @type {Warning[]} */
  const warnings = [];
  /** @type {string[]} 第一个条目之前、非 H1 正文的行（原样保留） */
  const preamble = [];
  const fileDate = fileDateOf(filePath) ?? todayLocal();

  try {
    const lines = splitLines(content);
    /** @type {Entry|null} */
    let current = null;
    /** @type {Kind|null} 当前分节对应的类型 */
    let sectionKind = null;
    let sectionSeen = false;
    let titleDepth = 0;
    let lastFieldDepth = 0;
    let lastKnownField = null;
    /** @type {string|null} 上一个字段名（用于续行归属） */
    let lastFieldName = null;
    /** 当前条目在源文件里的起始行号（用于保留 raw 原文） */
    let startIndex = 0;
    /** 被空行终止的那个条目：其后的缩进行按"人类备注"原样挂回它（§5.5 第 5 条） */
    /** @type {Entry|null} */
    let orphanOwner = null;
    /** 刚被空行终止、且**尚未**出现"空行之后又有内容"的条目（用于延迟告警） */
    /** @type {Entry|null} */
    let blankOwner = null;
    /** 是否见过"实质内容行"（非 H1、非空行）——用于区分"空文件"与"有内容但解析不出条目" */
    let sawContentLine = false;

    /**
     * 结束当前条目（把已有对象收进结果，并把原文片段留在 raw 里）。
     * @param {number} endIndex
     */
    const closeEntry = (endIndex) => {
      if (current !== null) {
        current.raw = lines.slice(startIndex, endIndex).join('\n');
        entries.push(current);
      }
      current = null;
      lastFieldName = null;
      lastKnownField = null;
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';

      // H1：固定行，渲染时重新生成，不进 preamble
      if (/^#\s+记忆\s*·/.test(line)) {
        closeEntry(index);
        continue;
      }

      // H2：分节标题
      if (/^##\s+/.test(line)) {
        closeEntry(index);
        orphanOwner = null;
        blankOwner = null;
        sectionSeen = true;
        const label = line.replace(/^##\s+/, '').trim();
        const kind = LABEL_KIND[label];
        if (kind === undefined) {
          sectionKind = null;
          warnings.push(warn('unknown-section', `无法识别的分节「${label}」，其下条目按「事实」处理`, { filePath }));
        } else {
          sectionKind = kind;
        }
        continue;
      }

      // 空行：终止当前条目；空行本身作为上一条目的 orphanNotes 原样保留。
      // ⚠️ 这里**不立刻告警**：分节之间本来就有空行（本插件渲染出来的文件也是如此），
      //    那不是"条目内含空行"；只有当空行之后**确实又有缩进行挂回该条**时才告警（见下方 blankOwner）。
      if (line.trim().length === 0) {
        if (current !== null) {
          current.orphanNotes.push('');
          orphanOwner = current;
          blankOwner = current;
          closeEntry(index);
        }
        continue;
      }

      const indentMatch = /^([ \t\u3000]*)/.exec(line);
      const prefix = indentMatch === null ? '' : indentMatch[1] ?? '';
      const depth = depthOf(prefix);
      const body = line.slice(prefix.length);
      sawContentLine = true;

      const titleLike = TITLE_RE.exec(line);

      // 顶格（相对标题行不更深）且不是列表项：按 §5.5 第 7 条三条互斥规则处理
      if (titleLike === null && (current === null || depth <= titleDepth)) {
        const field = matchFieldLine(line);
        if (current !== null && field !== null && FIELD_KEY[field.name] !== undefined) {
          warnings.push(warn('field-no-indent', `条目 ${current.id ?? '(无编号)'} 的字段「${field.name}」缺少缩进，已按字段处理`, { filePath }));
          applyField(current, field.name, field.value, warnings, filePath, () => {
            lastKnownField = field.name;
            lastFieldName = field.name;
            lastFieldDepth = depth;
          });
          continue;
        }
        if (current !== null && field !== null && FIELD_KEY[field.name] === undefined && depth > 0) {
          // 顶格（但相对本条目仍有缩进）的未知字段 → 人类备注
          current.unknownFields.push({ name: field.name, value: field.value, anchor: lastKnownField });
          lastFieldName = null;
          continue;
        }
        if (current !== null && field === null) {
          warnings.push(warn('free-field', `条目 ${current.id ?? '(无编号)'} 下出现既非字段也非续行的行，已原样保留`, { filePath }));
          current.orphanNotes.push(line);
          continue;
        }
      }

      // 新条目：标题行
      if (titleLike !== null) {
        closeEntry(index);
        startIndex = index;
        orphanOwner = null;
        blankOwner = null;
        const idText = titleLike[2];
        const title = (titleLike[3] ?? '').trim();
        current = newEntry({
          id: idText === undefined ? null : `#${idText.padStart(4, '0')}`,
          kind: sectionKind ?? 'fact',
          title,
          filePath,
          fileDate,
          order: entries.length,
        });
        titleDepth = depth;
        lastFieldDepth = depth;
        lastFieldName = null;
        lastKnownField = null;
        if (!sectionSeen) {
          warnings.push(warn('entry-before-section', `条目 ${current.id ?? '(无编号)'} 出现在任何 H2 分节之前，已按「事实」暂存`, { filePath }));
        }
        if (title.length === 0) {
          warnings.push(warn('empty-title', `条目 ${current.id ?? '(无编号)'} 的标题为空`, { filePath }));
        }
        continue;
      }

      // 字段行 / 续行
      const field = matchFieldLine(line);
      if (current !== null && field !== null) {
        const known = FIELD_KEY[field.name] !== undefined;
        const isField = depth > titleDepth || (depth >= titleDepth && known && field.name.length > 0 && depth === titleDepth);
        if (isField) {
          if (known) {
            applyField(current, field.name, field.value, warnings, filePath, () => {
              lastKnownField = field.name;
              lastFieldName = field.name;
              lastFieldDepth = depth;
            });
          } else {
            // 未知字段：锚点 = 紧邻的前一个已知字段（§5.5 第 6 条）
            current.unknownFields.push({ name: field.name, value: field.value, anchor: lastKnownField });
            lastFieldName = null;
            lastFieldDepth = depth;
          }
          continue;
        }
        // 比字段行更深 → 续行（多行值）
        if (depth > lastFieldDepth && lastFieldName !== null) {
          appendToField(current, lastFieldName, body.replace(/^[-*][ \t\u3000]+/, ''), warnings, filePath);
          continue;
        }
      }

      if (current !== null) {
        if (lastFieldName !== null && depth > titleDepth) {
          appendToField(current, lastFieldName, body.replace(/^[-*][ \t\u3000]+/, ''), warnings, filePath);
        } else {
          warnings.push(warn('free-field', `条目 ${current.id ?? '(无编号)'} 下出现无法归类的行，已原样保留`, { filePath }));
          current.orphanNotes.push(line);
        }
        continue;
      }

      // 被空行终止的条目：其后的缩进行按人类备注挂回它，保证位置不漂移；
      // 这时才说明"空行确实把一个条目切开了"，于是补一条告警（延迟到此刻，避免分节间空行误报）。
      if (orphanOwner !== null && depth > 0) {
        orphanOwner.orphanNotes.push(line);
        if (blankOwner === orphanOwner) {
          warnings.push(
            warn('entry-blank-line', `条目 ${orphanOwner.id ?? '(无编号)'} 的空行之后仍有缩进行，已按备注保留（内容不丢）`, {
              filePath,
              ...(orphanOwner.id === null ? {} : { id: orphanOwner.id }),
            }),
          );
          blankOwner = null;
        }
        continue;
      }

      preamble.push(line);
    }

    closeEntry(lines.length);

    // ⚠️ 只在"有实质内容却解析不出条目"时告警：一个当天刚创建、或条目全被归档/移走、
    // 只剩 H1 头部的文件是**正常状态**（不是损坏），早期实现会对它反复报 empty-file（用户真机测试发现）。
    if (entries.length === 0 && sawContentLine) {
      warnings.push(warn('empty-file', '文件有内容但未解析出任何条目', { filePath }));
    }

    return { entries, warnings, damaged: false, preamble };
  } catch (error) {
    // §12.3：降级而不是抛错——调用方按"无内容"处理并告警
    return {
      entries: [],
      warnings: [
        ...warnings,
        warn('parse-damaged', `解析失败，已按无内容处理并保留原文：${error instanceof Error ? error.message : String(error)}`, { filePath }),
      ],
      damaged: true,
      preamble,
    };
  }
}

/**
 * 造一个带全部默认值的条目对象（§5.3 缺省值）。
 * @param {object} input
 * @param {string|null} input.id
 * @param {Kind} input.kind
 * @param {string} input.title
 * @param {string} input.filePath
 * @param {string} input.fileDate
 * @param {number} input.order
 * @returns {Entry}
 */
function newEntry({ id, kind, title, filePath, fileDate, order }) {
  return {
    id,
    kind,
    title,
    detail: '',
    status: 'active',
    pinned: false,
    priority: defaultPriority(kind),
    confidence: 'observed',
    created: fileDate,
    updated: fileDate,
    expiresAt: '永久',
    tags: [],
    aliases: [],
    related: [],
    supersedes: [],
    supersededBy: null,
    relatedJournal: [],
    source: '',
    archivedAt: null,
    archivedReason: null,
    archivedStatusBefore: null,
    unknownFields: [],
    presentFields: [],
    orphanNotes: [],
    filePath,
    fileDate,
    order,
    raw: '',
  };
}

/**
 * 把一个已知字段写进条目（后者胜出 + warn，§5.5 第 8 条）。
 * @param {Entry} entry
 * @param {string} name
 * @param {string} value
 * @param {Warning[]} warnings
 * @param {string} filePath
 * @param {() => void} onApplied
 * @returns {void}
 */
function applyField(entry, name, value, warnings, filePath, onApplied) {
  const key = FIELD_KEY[name];
  if (key === undefined) return;
  if (entry.presentFields.includes(name)) {
    warnings.push(warn('duplicate-field', `条目 ${entry.id ?? '(无编号)'} 的字段「${name}」出现多次，后一次胜出`, { filePath }));
  }
  entry.presentFields.push(name);
  const text = value.trim();

  switch (key) {
    case 'status': {
      if (STATUSES.includes(/** @type {Status} */ (text))) entry.status = /** @type {Status} */ (text);
      else warnings.push(warn('bad-value', `条目 ${entry.id ?? '(无编号)'} 的状态「${text}」非法，按 active 处理`, { filePath }));
      break;
    }
    case 'pinned': {
      entry.pinned = text.toLowerCase() === 'true';
      break;
    }
    case 'priority': {
      if (PRIORITIES.includes(/** @type {Priority} */ (text))) entry.priority = /** @type {Priority} */ (text);
      else warnings.push(warn('bad-value', `优先级「${text}」非法，按类型默认值处理`, { filePath }));
      break;
    }
    case 'confidence': {
      if (CONFIDENCES.includes(/** @type {Confidence} */ (text))) entry.confidence = /** @type {Confidence} */ (text);
      else warnings.push(warn('bad-value', `置信度「${text}」非法，按 observed 处理`, { filePath }));
      break;
    }
    case 'created':
      entry.created = text;
      break;
    case 'updated':
      entry.updated = text;
      break;
    case 'expiresAt':
      entry.expiresAt = text.length === 0 ? '永久' : text;
      break;
    case 'tags':
      entry.tags = splitList(text);
      break;
    case 'aliases':
      entry.aliases = splitList(text);
      break;
    case 'related':
      entry.related = splitList(text);
      break;
    case 'supersedes':
      entry.supersedes = splitList(text);
      break;
    case 'supersededBy':
      entry.supersededBy = text.length === 0 ? null : text;
      break;
    case 'relatedJournal':
      entry.relatedJournal = splitList(text);
      break;
    case 'source':
      entry.source = text;
      break;
    case 'detail':
      entry.detail = text;
      break;
    case 'archivedAt':
      entry.archivedAt = text.length === 0 ? null : text;
      break;
    case 'archivedReason':
      entry.archivedReason = text.length === 0 ? null : text;
      break;
    case 'archivedStatusBefore': {
      const allowed = ['active', 'candidate', 'superseded'];
      entry.archivedStatusBefore = allowed.includes(text) ? /** @type {Status} */ (text) : null;
      if (entry.archivedStatusBefore === null && text.length > 0) {
        warnings.push(warn('bad-value', `归档前状态「${text}」非法`, { filePath }));
      }
      break;
    }
    default:
      break;
  }
  onApplied();
}

/**
 * 给上一个字段追加续行。
 * @param {Entry} entry
 * @param {string} name
 * @param {string} text
 * @param {Warning[]} warnings
 * @param {string} filePath
 * @returns {void}
 */
function appendToField(entry, name, text, warnings, filePath) {
  const key = FIELD_KEY[name];
  if (key === undefined) {
    warnings.push(warn('free-field', `续行无法归属已知字段「${name}」，已原样保留`, { filePath }));
    entry.orphanNotes.push(text);
    return;
  }
  if (key === 'detail') {
    entry.detail = `${entry.detail}\n${text}`;
    return;
  }
  warnings.push(warn('free-field', `字段「${name}」不接受续行，已原样保留`, { filePath }));
  entry.orphanNotes.push(text);
}

// ────────────────────── 长期记忆：渲染 ──────────────────────

/**
 * 一个已知字段是否应当回写（保真：源文件写过的保留；新写的按"非默认值"决定）。
 * @param {Entry} entry
 * @param {string} name
 * @returns {boolean}
 */
function shouldEmitField(entry, name) {
  if (entry.presentFields.includes(name)) return true;
  switch (name) {
    case '状态':
      return entry.status !== 'active';
    case '置顶':
      return entry.pinned === true;
    case '优先级':
      return entry.priority !== defaultPriority(entry.kind);
    case '置信度':
      return entry.confidence !== 'observed';
    case '创建':
      return entry.created !== entry.fileDate;
    case '更新':
      return entry.updated !== entry.created;
    case '有效至':
      return entry.expiresAt !== '永久';
    case '标签':
      return entry.tags.length > 0;
    case '别名':
      return entry.aliases.length > 0;
    case '关联':
      return entry.related.length > 0;
    case '取代':
      return entry.supersedes.length > 0;
    case '取代者':
      return entry.supersededBy !== null;
    case '关联日志':
      return entry.relatedJournal.length > 0;
    case '来源':
      return entry.source.length > 0;
    case '详细':
      return entry.detail.length > 0;
    case '归档时间':
      return entry.archivedAt !== null;
    case '归档原因':
      return entry.archivedReason !== null;
    case '归档前状态':
      return entry.archivedStatusBefore !== null;
    default:
      return false;
  }
}

/**
 * 渲染一个条目的全部行（含未知字段回写与 orphanNotes）。
 * @param {Entry} entry
 * @returns {string[]}
 */
export function renderEntry(entry) {
  const lines = [];
  const idText = entry.id === null ? '' : `[${entry.id}] `;
  lines.push(`- ${idText}${entry.title}`);

  /** 追加某已知字段（含其锚定的未知字段） */
  /** @param {string} name */
  const emitKnownField = (name) => {
    if (!shouldEmitField(entry, name)) return;
    const value = fieldValueText(entry, name);
    if (name === '详细') {
      const parts = value.split('\n');
      lines.push(`  - 详细：${parts[0] ?? ''}`);
      for (const extra of parts.slice(1)) lines.push(`    ${extra}`);
    } else if (value.includes('\n')) {
      const parts = value.split('\n');
      lines.push(`  - ${name}：${parts[0] ?? ''}`);
      for (const extra of parts.slice(1)) lines.push(`    ${extra}`);
    } else {
      lines.push(`  - ${name}：${value}`);
    }
    for (const unknown of entry.unknownFields.filter((item) => item.anchor === name)) {
      lines.push(`  - ${unknown.name}：${unknown.value}`);
    }
  };

  // 锚点为"标题行"的未知字段紧跟在标题之后（§5.5 第 6 条）
  for (const unknown of entry.unknownFields.filter((item) => item.anchor === null)) {
    lines.push(`  - ${unknown.name}：${unknown.value}`);
  }
  for (const name of FIELD_ORDER) emitKnownField(name);
  // 锚点指向一个已被移除/不存在的已知字段时，仍要写出来（绝不丢）
  for (const unknown of entry.unknownFields.filter((item) => item.anchor !== null && !FIELD_ORDER.includes(item.anchor))) {
    lines.push(`  - ${unknown.name}：${unknown.value}`);
  }
  for (const note of entry.orphanNotes) lines.push(note);

  return lines;
}

/**
 * 字段的文本值。
 * @param {Entry} entry
 * @param {string} name
 * @returns {string}
 */
function fieldValueText(entry, name) {
  switch (name) {
    case '状态':
      return entry.status;
    case '置顶':
      return entry.pinned ? 'true' : 'false';
    case '优先级':
      return entry.priority;
    case '置信度':
      return entry.confidence;
    case '创建':
      return entry.created;
    case '更新':
      return entry.updated;
    case '有效至':
      return entry.expiresAt;
    case '标签':
      return entry.tags.join(', ');
    case '别名':
      return entry.aliases.join(', ');
    case '关联':
      return entry.related.join(', ');
    case '取代':
      return entry.supersedes.join(', ');
    case '取代者':
      return entry.supersededBy ?? '';
    case '关联日志':
      return entry.relatedJournal.join(', ');
    case '来源':
      return entry.source;
    case '详细':
      return entry.detail;
    case '归档时间':
      return entry.archivedAt ?? '';
    case '归档原因':
      return entry.archivedReason ?? '';
    case '归档前状态':
      return entry.archivedStatusBefore ?? '';
    default:
      return '';
  }
}

/**
 * 渲染整个长期记忆文件（分节按 §4.1 固定顺序，空分节不渲染）。
 *
 * @param {string} fileDate `YYYY-MM-DD`
 * @param {Entry[]} entries 同一文件的条目（可含多类型）
 * @param {{ preamble?: string[] }} [options]
 * @returns {string}
 */
export function renderMemoryFile(fileDate, entries, options = {}) {
  const lines = [`# 记忆 · ${fileDate}`, ''];
  const preamble = options.preamble ?? [];
  for (const line of preamble) lines.push(line);
  if (preamble.length > 0) lines.push('');

  for (const kind of KINDS) {
    const group = entries
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => a.order - b.order);
    if (group.length === 0) continue;
    lines.push(`## ${KIND_LABEL[kind]}`);
    for (const entry of group) {
      for (const line of renderEntry(entry)) lines.push(line);
    }
    lines.push('');
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

// ────────────────────────── 项目日志 ──────────────────────────

/**
 * 解析一个日志文件。
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{ entries: JournalEntry[], warnings: Warning[] }}
 */
export function parseJournalFile(content, filePath) {
  /** @type {JournalEntry[]} */
  const entries = [];
  /** @type {Warning[]} */
  const warnings = [];
  const date = fileDateOf(filePath) ?? todayLocal();

  try {
    /** @type {JournalEntry|null} */
    let current = null;
    for (const line of splitLines(content)) {
      if (/^#\s+项目日志\s*·/.test(line)) continue;
      if (line.trim().length === 0) continue;

      const heading = JOURNAL_HEADING_RE.exec(line);
      if (heading !== null) {
        if (current !== null) entries.push(current);
        current = {
          id: heading[1] ?? null,
          title: (heading[2] ?? '').trim(),
          content: '',
          date,
          fields: [],
          filePath,
          order: entries.length,
          raw: '',
        };
        continue;
      }
      if (/^##\s+/.test(line)) {
        if (current !== null) entries.push(current);
        current = null;
        warnings.push(warn('journal-heading-invalid', `日志分节标题不符合 J-YYYYMMDD-HHMM 规范：${line.trim()}`, { filePath }));
        continue;
      }

      const field = /^[-*]\s*([^：:]+)[：:]\s?([\s\S]*)$/.exec(line);
      if (current !== null && field !== null) {
        const name = (field[1] ?? '').trim();
        const value = (field[2] ?? '').trim();
        const existing = current.fields.find((item) => item.name === name);
        if (existing === undefined) current.fields.push({ name, value });
        else existing.value = `${existing.value}\n${value}`;
        continue;
      }

      if (current !== null) {
        const last = current.fields[current.fields.length - 1];
        if (last === undefined) {
          current.fields.push({ name: '内容', value: line.trim() });
        } else {
          last.value = `${last.value}\n${line.replace(/^\s+/, '')}`;
        }
        continue;
      }
    }
    if (current !== null) entries.push(current);

    for (const entry of entries) {
      entry.content = fieldValueOf(entry, '内容') ?? fieldValueOf(entry, '详细') ?? fieldValueOf(entry, '结果') ?? '';
      if (entry.id === null) {
        warnings.push(warn('journal-id-invalid', '日志条目的编号缺失或非法', { filePath }));
      }
      if (entry.title.length === 0) {
        warnings.push(warn('empty-title', `日志条目 ${entry.id ?? '(无编号)'} 缺少标题`, { filePath, ...(entry.id === null ? {} : { id: entry.id }) }));
      }
      if (entry.content.length === 0) {
        warnings.push(warn('journal-no-content', `日志条目 ${entry.id ?? '(无编号)'} 缺少内容`, { filePath, ...(entry.id === null ? {} : { id: entry.id }) }));
      }
    }

    // 同一文件内编号重复（跨文件唯一性由写入方保证）
    const seen = new Map();
    for (const entry of entries) {
      if (entry.id === null) continue;
      const count = (seen.get(entry.id) ?? 0) + 1;
      seen.set(entry.id, count);
      if (count > 1) {
        warnings.push(warn('duplicate-journal-id', `日志编号 ${entry.id} 在同一文件内重复，写入方必须重发`, { filePath, id: entry.id }));
      }
    }

    return { entries, warnings };
  } catch (error) {
    return {
      entries: [],
      warnings: [
        ...warnings,
        warn('parse-damaged', `日志解析失败，已按无内容处理：${error instanceof Error ? error.message : String(error)}`, { filePath }),
      ],
    };
  }
}

/**
 * 取日志条目的字段值。
 * @param {JournalEntry} entry
 * @param {string} name
 * @returns {string|null}
 */
export function fieldValueOf(entry, name) {
  const found = entry.fields.find((item) => item.name === name);
  return found === undefined ? null : found.value;
}

/**
 * 渲染整个日志文件（字段按原顺序回写）。
 * @param {string} fileDate `YYYY-MM-DD`
 * @param {JournalEntry[]} entries
 * @returns {string}
 */
export function renderJournalFile(fileDate, entries) {
  const lines = [`# 项目日志 · ${fileDate}`, ''];
  for (const entry of entries) {
    lines.push(`## ${entry.id ?? ''} · ${entry.title}`.trimEnd());
    for (const field of entry.fields) {
      lines.push(`- ${field.name}：${field.value.replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/**
 * 生成日志编号：`J-YYYYMMDD-HHMM`，同一分钟多次追加 `-2`、`-3`（§5.4）。
 * @param {string} date `YYYY-MM-DD`
 * @param {string} time `HH:MM`
 * @param {Set<string>} taken 已占用的编号集合（同一文件内）
 * @returns {string}
 */
export function makeJournalId(date, time, taken) {
  const base = `J-${date.replace(/-/g, '')}-${time.replace(':', '')}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 本地时间 `HH:MM`。
 * @param {Date} [now]
 * @returns {string}
 */
export function timeLocal(now = new Date()) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
