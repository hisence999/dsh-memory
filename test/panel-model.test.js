/**
 * client/memory-panel.js 纯函数区单元测试（node --test，ESM）。
 *
 * ⚠️ 夹具依据 src/parse.js 的**实际行为**构造，不照抄设计文档：
 *    用户已明确 docs/memory-tools-design-r1.4.md §5 的样例可能已落后于实际代码，一切以代码为准。
 *    因此每条长期记忆/日志夹具都会与 src/parse.js 的解析结果交叉验证（见「交叉验证」一节），
 *    这是本次 client 改造最重要的回归护栏：一旦客户端解析器与真实解析器行为漂移，这里会立刻红。
 *
 * 交叉验证的三个维度（同一条夹具，两个解析器都跑）：
 *   1. entries —— **全字段**投影（含 filePath / fileDate / order / unknownFields / presentFields /
 *      orphanNotes / raw），不再是精选子集；
 *   2. warnings —— 只比 code 的**多重集合**（排序后逐项比较），不比 message 文案（避免过度耦合）；
 *   3. damaged —— 合法夹具必须双方都是 false。
 *    日志侧同样三维（entries 全字段 + warnings code），并单独覆盖 journal-no-content 与
 *    duplicate-journal-id 两条曾经缺失的告警分支。
 *
 * 与共享任务 task-3 描述文本的**已核对差异**（以实际代码为准，已回报 Lead）：
 *   1. 客户端导出的是 `KINDS`（枚举数组，对齐 src/parse.js:87）+ `KIND_LABEL`（内部值 → 中文名，
 *      对齐 src/parse.js:90），而不是 task-3 描述的 `KINDS: {convention:'约定', ...}` 对象。
 *   2. `buildActionLine` 遇到未知 action 会抛错（`未知动作「…」`），而不是返回字符串；
 *      task-3 只冻结了 archive / restore 两种动作的形态。
 *   3. `module.exports` 另含 `rowKey(entry)`（行身份 `filePath + '#' + order`），由
 *      test/panel-loader.test.js 覆盖，本文件不重复测它。
 *
 * 加载方式：client/memory-panel.js 是手写 classic script（顶层 IIFE，文件末尾条件导出 module.exports）。
 * 本包 package.json 是 "type":"module"，不能 import/require 这个 .js；只能读源码后在 node:vm 里执行，
 * 再取 module.exports。注意：vm 沙箱里造出来的对象属于**另一个 realm**，其原型与宿主不同，
 * `assert.deepStrictEqual` 会因原型比较而误判，所以所有跨 realm 的比较都要先过 `toHost()`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import * as real from '../src/parse.js';

const PANEL_URL = new URL('../client/memory-panel.js', import.meta.url);

/** 标准长期记忆文件路径（生产里传的是工作区相对路径，含归属日期）。 */
const MEM_FILE = 'memory/M-2026-09-20.md';
/** 归档目录下的长期记忆文件路径。 */
const ARCHIVE_FILE = 'memory/archive/M-2026-09-20.md';
/** 标准日志文件路径。 */
const JOURNAL_FILE = 'memory/JOURNAL-2026-09-20.md';

/**
 * 读取并执行 client/memory-panel.js，返回它的 module.exports（纯函数区）。
 * @returns {any}
 */
function loadPanelApi() {
  let source;
  try {
    source = fs.readFileSync(PANEL_URL, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`读不到 client/memory-panel.js（实现可能还没落盘）：${detail}`);
  }
  /** @type {any} */
  const sandbox = { module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return /** @type {any} */ (sandbox.module.exports);
}

const api = loadPanelApi();

// ────────────────────────── 夹具与工具 ──────────────────────────

/**
 * 把 vm 沙箱 realm 里的值搬到宿主 realm（保留 undefined 与键顺序，供 deepStrictEqual 使用）。
 * @param {any} value
 * @returns {any}
 */
function toHost(value) {
  if (Array.isArray(value)) return Array.from(value, toHost);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toHost(item)]));
  }
  return value;
}

/**
 * 长期记忆夹具（形状与 src/parse.js 实际支持的语法一致：顶格条目行、两空格字段行、四空格续行）。
 */
const MEM_SAMPLE = [
  '# 记忆 · 2026-09-20',
  '',
  '## 约定',
  '',
  '- [#0007] 项目默认使用 SSH 别名 `us` 连接服务器',
  '  - 状态：active',
  '  - 置顶：true',
  '  - 优先级：high',
  '  - 置信度：confirmed',
  '  - 创建：2026-09-20',
  '  - 更新：2026-09-20',
  '  - 标签：ssh, server',
  '  - 别名：myserver, 服务器',
  '  - 详细：详见本项目的部署文档第 3 节。',
  '',
  '## 经验',
  '',
  '- [#0008] DSH bundle 成员变化后必须重启 profile',
  '  - 状态：active',
  '  - 优先级：medium',
  '  - 置信度：confirmed',
  '  - 创建：2026-09-20',
  '  - 更新：2026-09-20',
  '  - 来源：实测',
  '  - 关联日志：J-20260918-1542',
  '  - 详细：profile patch 支持热加载，但依赖清单变化不会随 patch 热加载。',
  '    重启后确认生效。',
].join('\n');

/** 日志夹具（字段行顶格，与 src/parse.js 的日志字段正则一致）。 */
const JOURNAL_SAMPLE = [
  '# 项目日志 · 2026-09-20',
  '',
  '## J-20260920-1432 · 确认记忆插件的项目边界',
  '',
  '- 时间：2026-09-20 14:32',
  '- 结果：确认插件只读写当前项目根目录下的 `memory/`。',
  '- 决策：不提供用户级、全局级或跨项目记忆。',
  '- 详细：移除 scope 字段，项目边界由会话工作区根决定。',
  '- 后续：更新设计并补充提示词。',
  '- 关联记忆：无',
  '',
  '## J-20260920-1510 · 复查依赖热加载结论（同一主题的第二次验证）',
  '',
  '- 时间：2026-09-20 15:10',
  '- 尝试：修改 profile patch 并执行配置检查。',
  '- 结果：patch 修改可热加载；依赖清单变化仍需重启 profile。',
  '- 证据：命令与输出见本次日志正文。',
  '- 关联记忆：#0008',
].join('\n');

/**
 * 长期记忆条目的**全字段**投影（含回写保真相关的内部字段，逐字段对拍）。
 * @param {any} e
 * @returns {any}
 */
function project(e) {
  return {
    id: e.id,
    kind: e.kind,
    title: e.title,
    detail: e.detail,
    status: e.status,
    pinned: e.pinned,
    priority: e.priority,
    confidence: e.confidence,
    created: e.created,
    updated: e.updated,
    expiresAt: e.expiresAt,
    tags: e.tags,
    aliases: e.aliases,
    related: e.related,
    supersedes: e.supersedes,
    supersededBy: e.supersededBy,
    relatedJournal: e.relatedJournal,
    source: e.source,
    archivedAt: e.archivedAt,
    archivedReason: e.archivedReason,
    archivedStatusBefore: e.archivedStatusBefore,
    unknownFields: e.unknownFields,
    presentFields: e.presentFields,
    orphanNotes: e.orphanNotes,
    filePath: e.filePath,
    fileDate: e.fileDate,
    order: e.order,
    raw: e.raw,
  };
}

/**
 * 日志条目的全字段投影。
 * @param {any} e
 * @returns {any}
 */
function projectJournal(e) {
  return {
    id: e.id,
    title: e.title,
    content: e.content,
    date: e.date,
    fields: e.fields,
    filePath: e.filePath,
    order: e.order,
    raw: e.raw,
  };
}

/**
 * 取一条警告的 code。
 * @param {any} warning
 * @returns {string}
 */
function warningCode(warning) {
  return warning.code;
}

/**
 * 某次解析结果的警告码**多重集合**（已排序，保留重复项）。
 * @param {any} result
 * @returns {string[]}
 */
function warningCodesOf(result) {
  return toHost(result.warnings.map(warningCode)).sort();
}

/**
 * 客户端解析结果必须与 src/parse.js 一致：entries 全字段 + warnings code + damaged。
 * @param {string} text
 * @param {string} filePath
 * @param {string} label
 * @returns {any}
 */
function assertSameMemoryEntries(text, filePath, label) {
  const mine = api.parseMemoryFile(text, filePath);
  const theirs = real.parseMemoryFile(text, filePath);
  assert.ok(Array.isArray(mine.entries), `${label}：客户端 parseMemoryFile 必须返回 { entries }`);
  assert.ok(Array.isArray(mine.warnings), `${label}：客户端 parseMemoryFile 必须返回 warnings 数组`);
  assert.strictEqual(mine.damaged, false, `${label}：合法输入不应被判为 damaged`);
  assert.strictEqual(theirs.damaged, false, `${label}：参照实现 src/parse.js 不应 damaged`);
  assert.deepStrictEqual(
    toHost(mine.entries.map(project)),
    toHost(theirs.entries.map(project)),
    `${label}：客户端解析结果应与 src/parse.js 全字段一致`,
  );
  assert.deepStrictEqual(
    warningCodesOf(mine),
    warningCodesOf(theirs),
    `${label}：客户端 warnings 的 code 多重集合应与 src/parse.js 一致`,
  );
  return mine;
}

/**
 * 日志解析结果必须与 src/parse.js 一致：entries 全字段 + warnings code。
 * @param {string} text
 * @param {string} filePath
 * @param {string} label
 * @returns {any}
 */
function assertSameJournalEntries(text, filePath, label) {
  const mine = api.parseJournalFile(text, filePath);
  const theirs = real.parseJournalFile(text, filePath);
  assert.ok(Array.isArray(mine.entries), `${label}：客户端 parseJournalFile 必须返回 { entries }`);
  assert.ok(Array.isArray(mine.warnings), `${label}：客户端 parseJournalFile 必须返回 warnings 数组`);
  assert.deepStrictEqual(
    toHost(mine.entries.map(projectJournal)),
    toHost(theirs.entries.map(projectJournal)),
    `${label}：日志条目应与 src/parse.js 全字段一致`,
  );
  assert.deepStrictEqual(
    warningCodesOf(mine),
    warningCodesOf(theirs),
    `${label}：日志 warnings 的 code 多重集合应与 src/parse.js 一致`,
  );
  return mine;
}

/**
 * 取列表里每个元素的某个字段（结果落在宿主 realm，便于 deepStrictEqual）。
 * @param {any} list
 * @param {string} key
 * @returns {any[]}
 */
function pluck(list, key) {
  return Array.from(list, (/** @type {any} */ item) => item[key]);
}

/** 形状与 src/parse.js 的 newEntry() 一致的条目默认值（排序/分桶用例用）。 */
/** @type {any} */
const ENTRY_DEFAULTS = {
  id: '#0001',
  kind: 'fact',
  title: '标题',
  detail: '',
  status: 'active',
  pinned: false,
  priority: 'medium',
  confidence: 'observed',
  created: '2026-09-20',
  updated: '2026-09-20',
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
  filePath: MEM_FILE,
  fileDate: '2026-09-20',
  order: 0,
  raw: '',
};

/**
 * 造一条条目（只用于 groupByStatus / sortForDisplay）。
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function mk(over = {}) {
  return { ...ENTRY_DEFAULTS, ...over };
}

// ────────────────────────── KINDS / KIND_LABEL / formatKind ──────────────────────────

test('KINDS 枚举与 KIND_LABEL 中文名都与 src/parse.js 对齐', () => {
  assert.deepStrictEqual(
    toHost(api.KINDS),
    toHost(real.KINDS),
    'KINDS 必须与 src/parse.js 的类型枚举一致（实际代码里是数组，不是对象映射）',
  );
  assert.deepStrictEqual(
    toHost(api.KIND_LABEL),
    { convention: '约定', fact: '事实', procedure: '流程', lesson: '经验' },
    'KIND_LABEL 必须逐字等于 {convention:约定, fact:事实, procedure:流程, lesson:经验}',
  );
  assert.deepStrictEqual(toHost(api.KIND_LABEL), toHost(real.KIND_LABEL), 'KIND_LABEL 必须与 src/parse.js 的 KIND_LABEL 一致');
});

test('formatKind：已知类型返回中文，未知类型返回「未知」且不抛错', () => {
  for (const [kind, label] of Object.entries(real.KIND_LABEL)) {
    assert.strictEqual(api.formatKind(kind), label, `formatKind('${kind}') 应为「${label}」`);
  }
  assert.strictEqual(api.formatKind('杂项'), '未知', "formatKind('杂项') 应为「未知」");
  assert.strictEqual(api.formatKind('unknown'), '未知', "formatKind('unknown') 应为「未知」");
  assert.strictEqual(api.formatKind(''), '未知', 'formatKind(空串) 应为「未知」');
  assert.strictEqual(api.formatKind(undefined), '未知', 'formatKind(undefined) 应返回「未知」而不是抛错');
});

// ────────────────────────── parseMemoryFile ──────────────────────────

test('parseMemoryFile：合法样例逐字段解析，并与 src/parse.js 交叉验证', () => {
  const { entries } = assertSameMemoryEntries(MEM_SAMPLE, MEM_FILE, '长期记忆样例');
  assert.strictEqual(entries.length, 2, '应解析出 2 条条目');

  const e0 = entries[0];
  assert.strictEqual(e0.id, '#0007', '编号应补零为 #0007');
  assert.strictEqual(e0.kind, 'convention', '「## 约定」下的条目 kind 应为 convention');
  assert.strictEqual(e0.title, '项目默认使用 SSH 别名 `us` 连接服务器', '标题应逐字保留');
  assert.strictEqual(e0.status, 'active', '状态应取「状态」字段值');
  assert.strictEqual(e0.pinned, true, '「置顶：true」应解析为 true');
  assert.strictEqual(e0.priority, 'high', '优先级应取 high');
  assert.strictEqual(e0.confidence, 'confirmed', '置信度应取 confirmed');
  assert.strictEqual(e0.created, '2026-09-20', '创建应取字段值');
  assert.strictEqual(e0.updated, '2026-09-20', '更新应取字段值');
  assert.strictEqual(e0.expiresAt, '永久', '未写「有效至」时应缺省为 永久');
  assert.deepStrictEqual(toHost(e0.tags), ['ssh', 'server'], '标签应按逗号切分并去掉空白');
  assert.deepStrictEqual(toHost(e0.aliases), ['myserver', '服务器'], '别名应按逗号切分并去掉空白');
  assert.strictEqual(e0.detail, '详见本项目的部署文档第 3 节。', '详细应解析为单行文本');
  assert.strictEqual(e0.filePath, MEM_FILE, 'filePath 应原样带上（工作区相对路径形态）');
  assert.strictEqual(e0.fileDate, '2026-09-20', 'fileDate 应从文件名推导');
  assert.strictEqual(e0.order, 0, '第一条的 order 应为 0');

  const e1 = entries[1];
  assert.strictEqual(e1.id, '#0008', '第二条编号应为 #0008');
  assert.strictEqual(e1.kind, 'lesson', '「## 经验」下的条目 kind 应为 lesson');
  assert.strictEqual(e1.priority, 'medium', '第二条优先级应为 medium');
  assert.deepStrictEqual(toHost(e1.relatedJournal), ['J-20260918-1542'], '「关联日志」应按列表解析');
  assert.strictEqual(e1.source, '实测', '「来源」应解析为自由文本');
  assert.strictEqual(e1.order, 1, '第二条的 order 应为 1');
});

test('parseMemoryFile：缩进续行以 \\n 拼进「详细」', () => {
  const text = ['## 经验', '- [#0008] 多行详细', '  - 详细：第一行', '    第二行', '    第三行'].join('\n');
  const { entries } = assertSameMemoryEntries(text, MEM_FILE, '续行样例');
  assert.strictEqual(entries.length, 1, '应解析出 1 条条目');
  assert.strictEqual(entries[0].detail, '第一行\n第二行\n第三行', '续行应按原顺序用换行拼接，且去掉续行缩进');
});

test('parseMemoryFile：缺字段按缺省值补齐', () => {
  // 注意：这里刻意不在条目与下一个 H2 之间留空行——空行会被记成一条空的 orphanNotes（真实行为），
  // 那属于"空行终止条目"的用例，不该混进缺省值用例。
  const text = ['## 约定', '- [#0021] 只有标题的条目', '## 经验', '- [#0022] 另一条只有标题'].join('\n');
  const { entries } = assertSameMemoryEntries(text, MEM_FILE, '缺字段样例');
  assert.strictEqual(entries.length, 2, '两条只有标题的条目都应解析出来');

  const e = entries[0];
  assert.strictEqual(e.status, 'active', '状态缺省应为 active');
  assert.strictEqual(e.pinned, false, '置顶缺省应为 false');
  assert.strictEqual(e.priority, 'high', '约定 的类型默认优先级应为 high');
  assert.strictEqual(e.confidence, 'observed', '置信度缺省应为 observed');
  assert.strictEqual(e.created, '2026-09-20', '创建缺省应取文件名日期');
  assert.strictEqual(e.updated, '2026-09-20', '更新缺省应取文件名日期');
  assert.strictEqual(e.expiresAt, '永久', '有效至缺省应为 永久');
  assert.deepStrictEqual(toHost(e.tags), [], '标签缺省应为空数组');
  assert.deepStrictEqual(toHost(e.aliases), [], '别名缺省应为空数组');
  assert.deepStrictEqual(toHost(e.related), [], '关联缺省应为空数组');
  assert.deepStrictEqual(toHost(e.supersedes), [], '取代缺省应为空数组');
  assert.strictEqual(e.supersededBy, null, '取代者缺省应为 null');
  assert.deepStrictEqual(toHost(e.relatedJournal), [], '关联日志缺省应为空数组');
  assert.strictEqual(e.source, '', '来源缺省应为空串');
  assert.strictEqual(e.detail, '', '详细缺省应为空串');
  assert.strictEqual(e.archivedAt, null, '归档时间缺省应为 null');
  assert.strictEqual(e.archivedReason, null, '归档原因缺省应为 null');
  assert.strictEqual(e.archivedStatusBefore, null, '归档前状态缺省应为 null');
  assert.deepStrictEqual(toHost(e.unknownFields), [], '未知字段缺省应为空数组');
  assert.deepStrictEqual(toHost(e.presentFields), [], '已出现字段缺省应为空数组');
  assert.deepStrictEqual(toHost(e.orphanNotes), [], '孤儿备注缺省应为空数组');
  assert.strictEqual(e.raw, '- [#0021] 只有标题的条目', 'raw 应保留该条目在源文件里的原文片段');

  assert.strictEqual(entries[1].priority, 'medium', '经验 的类型默认优先级应为 medium');
  assert.strictEqual(entries[1].kind, 'lesson', '第二条 kind 应为 lesson');
});

test('parseMemoryFile：日期缺省取文件名；文件名不合规时回退本地今天且不抛错', () => {
  const ok = assertSameMemoryEntries('## 事实\n- [#0031] 文件名带日期', 'D:/proj/memory/M-2026-09-20.md', 'M-YYYY-MM-DD 文件名');
  assert.strictEqual(ok.entries[0].created, '2026-09-20', '创建应取文件名里的日期');

  const bad = assertSameMemoryEntries('## 事实\n- [#0032] 文件名不合规', 'D:/proj/memory/INDEX.md', '非 M-YYYY-MM-DD 文件名');
  assert.strictEqual(bad.entries.length, 1, '非 M-YYYY-MM-DD 文件名也必须正常解析出条目');
  assert.strictEqual(bad.entries[0].created, bad.entries[0].updated, '创建与更新缺省应同源');
  assert.match(bad.entries[0].created, /^\d{4}-\d{2}-\d{2}$/, '取不到文件日期时应回退为 YYYY-MM-DD');
  assert.strictEqual(bad.entries[0].created, real.todayLocal(), '取不到文件日期时应回退为本地今天');
});

test('parseMemoryFile：空文本、纯空行、没有条目行的正文都不抛错并返回 0 条', () => {
  const empty = assertSameMemoryEntries('', MEM_FILE, '空文本');
  assert.deepStrictEqual(toHost(empty.entries), [], '空文本应解析出 0 条条目');

  const blanks = assertSameMemoryEntries('\n\n   \n\t\n\n', MEM_FILE, '纯空行');
  assert.deepStrictEqual(toHost(blanks.entries), [], '纯空行应解析出 0 条条目');

  const onlyH1 = assertSameMemoryEntries('# 记忆 · 2026-09-20\n\n这里只有说明文字。\n', MEM_FILE, '无 H2 且无条目');
  assert.deepStrictEqual(toHost(onlyH1.entries), [], '没有条目行的正文应解析出 0 条条目');
  assert.ok(toHost(onlyH1.preamble).includes('这里只有说明文字。'), '首个条目之前的正文应保留在 preamble 里');
});

test('parseMemoryFile：条目出现在任何 H2 之前时按 fact 暂存，不丢条目', () => {
  const { entries } = assertSameMemoryEntries('- [#0041] 无分节条目', MEM_FILE, 'H2 之前的条目');
  assert.strictEqual(entries.length, 1, 'H2 之前出现的条目仍应被解析出来');
  assert.strictEqual(entries[0].kind, 'fact', '无分节时 kind 应回退为 fact');
  assert.strictEqual(entries[0].title, '无分节条目', '标题应逐字保留');
});

test('parseMemoryFile：同一文件内重复编号的两条都保留', () => {
  const text = ['## 约定', '- [#0007] 第一条', '- [#0007] 第二条'].join('\n');
  const { entries } = assertSameMemoryEntries(text, MEM_FILE, '重复编号');
  assert.strictEqual(entries.length, 2, '重复编号的两条都应保留，不能去重丢内容');
  assert.deepStrictEqual(pluck(entries, 'id'), ['#0007', '#0007'], '两条编号都应规范化为 #0007');
  assert.deepStrictEqual(pluck(entries, 'title'), ['第一条', '第二条'], '标题应分别保留且顺序不变');
});

test('parseMemoryFile：无法识别的 H2 分节按 fact 处理', () => {
  const text = ['## 杂项', '- [#0051] 未知分节下的条目'].join('\n');
  const { entries } = assertSameMemoryEntries(text, MEM_FILE, '未知分节');
  assert.strictEqual(entries.length, 1, '未知分节下的条目不应丢失');
  assert.strictEqual(entries[0].kind, 'fact', '无法识别的分节应回退为 fact');
});

test('parseMemoryFile：活动文件里的 archived 条目按 archived 解析，不落进 active 桶', () => {
  const text = ['## 事实', '- [#0092] 活动文件里的归档条', '  - 状态：archived', '  - 归档前状态：active'].join('\n');
  const mine = assertSameMemoryEntries(text, MEM_FILE, '活动文件里的 archived 条目');
  assert.strictEqual(mine.entries.length, 1, '应解析出 1 条条目');
  assert.strictEqual(mine.entries[0].status, 'archived', '「状态：archived」应解析为 archived');
  assert.strictEqual(mine.entries[0].archivedStatusBefore, 'active', '「归档前状态」应解析出来');
  assert.strictEqual(mine.entries[0].filePath, MEM_FILE, 'filePath 应是传入的活动文件路径');

  const grouped = api.groupByStatus(mine.entries);
  assert.strictEqual(grouped.active.length, 0, '归档条目不得落进 active 桶（否则面板会出现「计数里有、列表里没有」）');
  assert.deepStrictEqual(pluck(grouped.archived, 'id'), ['#0092'], '归档条目应落进 archived 桶');
});

test('parseMemoryFile：归档目录路径 memory/archive/M-*.md 也能正常解析', () => {
  const text = ['## 事实', '- [#0093] 归档文件里的条目', '  - 状态：archived'].join('\n');
  const mine = assertSameMemoryEntries(text, ARCHIVE_FILE, '归档目录路径');
  assert.strictEqual(mine.entries.length, 1, '应解析出 1 条条目');
  assert.strictEqual(mine.entries[0].filePath, ARCHIVE_FILE, 'filePath 应保留 memory/archive/ 前缀');
  assert.strictEqual(mine.entries[0].fileDate, '2026-09-20', 'fileDate 应仍从文件名推导（与目录无关）');
});

test('parseMemoryFile：畸形输入绝不抛错，且已解析到的条目一条不丢', () => {
  const cases = [
    ['无编号条目', ['## 约定', '- 忘了写编号的一条'].join('\n')],
    ['半截字段行', ['## 约定', '- [#0061] 半截字段', '  - 状态', '  - ：空字段名'].join('\n')],
    ['缩进的条目行（不算条目）', ['## 约定', '  - [#0062] 缩进的条目行'].join('\n')],
    ['未知字段', ['## 约定', '- [#0063] 未知字段', '  - 来源备注：人工添加'].join('\n')],
    ['非法枚举值', ['## 约定', '- [#0064] 非法值', '  - 状态：不存在的状态', '  - 优先级：urgent', '  - 置信度：maybe'].join('\n')],
    ['无冒号的行', ['## 约定', '- [#0065] 无冒号', '  这行既不是字段也不是续行'].join('\n')],
    ['只有 H2 与空行', ['## 约定', '', '## 经验', ''].join('\n')],
  ];
  for (const [label, text] of cases) {
    const mine = assertSameMemoryEntries(text, MEM_FILE, label);
    assert.ok(Array.isArray(mine.entries), `${label}：必须返回 entries 数组而不是抛错`);
  }

  const noId = api.parseMemoryFile(cases[0][1], MEM_FILE).entries;
  assert.strictEqual(noId.length, 1, '没有编号的条目也必须保留');
  assert.strictEqual(noId[0].id, null, '没有编号时 id 应为 null');
  assert.strictEqual(noId[0].title, '忘了写编号的一条', '无编号条目的标题仍需解析出来');

  const indented = api.parseMemoryFile(cases[2][1], MEM_FILE).entries;
  assert.strictEqual(indented.length, 0, '缩进的列表行不算条目（顶格才算）');
});

// ────────────────────────── parseJournalFile ──────────────────────────

test('parseJournalFile：日志编号、标题、content、字段解析正确，并与 src/parse.js 交叉验证', () => {
  const mine = assertSameJournalEntries(JOURNAL_SAMPLE, JOURNAL_FILE, '日志样例');
  assert.strictEqual(mine.entries.length, 2, '应解析出 2 条日志');

  const j0 = mine.entries[0];
  assert.strictEqual(j0.id, 'J-20260920-1432', '日志编号应取 H2 里的 J-YYYYMMDD-HHMM');
  assert.strictEqual(j0.title, '确认记忆插件的项目边界', '日志标题应取「·」之后的文本');
  assert.strictEqual(j0.content, '移除 scope 字段，项目边界由会话工作区根决定。', 'content 应取「详细」字段');
  assert.deepStrictEqual(
    pluck(j0.fields, 'name'),
    ['时间', '结果', '决策', '详细', '后续', '关联记忆'],
    '日志字段应按出现顺序原样保留',
  );
  assert.strictEqual(j0.date, '2026-09-20', '日志归属日期应取文件名日期');
  assert.strictEqual(j0.filePath, JOURNAL_FILE, 'filePath 应原样带上（工作区相对路径形态）');
  assert.strictEqual(j0.order, 0, '第一条日志的 order 应为 0');

  const j1 = mine.entries[1];
  assert.strictEqual(j1.id, 'J-20260920-1510', '第二条日志编号应正确');
  assert.ok(pluck(j1.fields, 'name').includes('证据'), '第二条日志的「证据」字段应保留');
  assert.strictEqual(j1.content, 'patch 修改可热加载；依赖清单变化仍需重启 profile。', '无「详细」时 content 应回退到「结果」');
});

test('parseJournalFile：字段续行拼进上一字段；空文本与非日志 H2 不产出条目', () => {
  const text = ['## J-20260920-1600 · 续行样例', '- 时间：2026-09-20 16:00', '- 结果：第一行', '  第二行'].join('\n');
  const mine = assertSameJournalEntries(text, JOURNAL_FILE, '日志续行样例');
  assert.strictEqual(mine.entries.length, 1, '应解析出 1 条日志');
  const result = mine.entries[0].fields.find((/** @type {any} */ f) => f.name === '结果');
  assert.ok(result, '「结果」字段应存在');
  assert.strictEqual(result.value, '第一行\n第二行', '续行应以 \\n 拼进上一字段');

  const empty = api.parseJournalFile('', JOURNAL_FILE);
  assert.deepStrictEqual(toHost(empty.entries), [], '空文本应解析出 0 条日志');

  const badHeading = api.parseJournalFile('## 不是日志标题\n- 时间：2026-09-20 16:00', JOURNAL_FILE);
  assert.deepStrictEqual(toHost(badHeading.entries), [], '不符合 J-YYYYMMDD-HHMM 的 H2 不应产出日志条目');
});

test('parseJournalFile：日志条目缺内容时，与 src/parse.js 同样给出 journal-no-content', () => {
  const text = ['## J-20260920-1600 · 只有时间没有内容', '- 时间：2026-09-20 16:00'].join('\n');
  const mine = assertSameJournalEntries(text, JOURNAL_FILE, '日志缺内容');
  assert.strictEqual(mine.entries.length, 1, '应解析出 1 条日志');
  assert.strictEqual(mine.entries[0].content, '', '缺内容时 content 应为空串');
  assert.ok(
    warningCodesOf(mine).includes('journal-no-content'),
    '内容为空的日志条目应产出 journal-no-content 告警（客户端曾缺这个分支）',
  );
});

test('parseJournalFile：同一文件内重复日志编号时，与 src/parse.js 同样给出 duplicate-journal-id', () => {
  const text = [
    '## J-20260920-1432 · 第一次',
    '- 结果：甲',
    '',
    '## J-20260920-1432 · 第二次',
    '- 结果：乙',
  ].join('\n');
  const mine = assertSameJournalEntries(text, JOURNAL_FILE, '日志编号重复');
  assert.strictEqual(mine.entries.length, 2, '同编号的两条日志都应保留（编号唯一性由写入方保证）');
  assert.deepStrictEqual(pluck(mine.entries, 'id'), ['J-20260920-1432', 'J-20260920-1432'], '两条编号应相同且都保留');
  assert.ok(
    warningCodesOf(mine).includes('duplicate-journal-id'),
    '同一文件内重复的日志编号应产出 duplicate-journal-id 告警（客户端曾缺这个分支）',
  );
});

// ────────────────────────── groupByStatus ──────────────────────────

test('groupByStatus：按四类状态分桶，空输入四桶皆空', () => {
  assert.deepStrictEqual(
    toHost(api.groupByStatus([])),
    { active: [], candidate: [], superseded: [], archived: [] },
    '空输入应返回四个空桶',
  );

  const entries = [
    mk({ id: '#0001', status: 'candidate' }),
    mk({ id: '#0002', status: 'active' }),
    mk({ id: '#0003', status: 'archived' }),
    mk({ id: '#0004', status: 'superseded' }),
    mk({ id: '#0005', status: 'active' }),
  ];
  const grouped = api.groupByStatus(entries);
  assert.deepStrictEqual(
    Object.keys(toHost(grouped)).sort(),
    ['active', 'archived', 'candidate', 'superseded'],
    '分桶键应固定为 active/candidate/superseded/archived 四类',
  );
  assert.deepStrictEqual(pluck(grouped.active, 'id'), ['#0002', '#0005'], 'active 桶应含全部 active 条目且保持原顺序');
  assert.deepStrictEqual(pluck(grouped.candidate, 'id'), ['#0001'], 'candidate 桶应正确');
  assert.deepStrictEqual(pluck(grouped.superseded, 'id'), ['#0004'], 'superseded 桶应正确');
  assert.deepStrictEqual(pluck(grouped.archived, 'id'), ['#0003'], 'archived 桶应正确');
  assert.strictEqual(
    grouped.active.length + grouped.candidate.length + grouped.superseded.length + grouped.archived.length,
    entries.length,
    '四条状态的条目都应各归其桶，不丢不重',
  );
});

test('groupByStatus：状态取值异常时不抛错', () => {
  assert.doesNotThrow(
    () => api.groupByStatus([mk({ id: '#0001', status: 'expired' }), mk({ id: '#0002', status: '' })]),
    '未知/空状态不应让 groupByStatus 抛错',
  );
});

// ────────────────────────── sortForDisplay ──────────────────────────

test('sortForDisplay：置顶优先于状态权重', () => {
  const entries = [
    mk({ id: '#0001', status: 'active', created: '2026-09-01', pinned: false }),
    mk({ id: '#0002', status: 'archived', created: '2026-09-30', pinned: true }),
    mk({ id: '#0003', status: 'candidate', created: '2026-09-15', pinned: false }),
  ];
  const sorted = api.sortForDisplay(entries);
  assert.deepStrictEqual(pluck(sorted, 'id'), ['#0002', '#0001', '#0003'], '置顶条目必须排最前，其余按 active>candidate');
  assert.strictEqual(sorted.length, entries.length, '排序不得丢条目');
});

test('sortForDisplay：无置顶时按 active > candidate > superseded > archived', () => {
  const entries = [
    mk({ id: '#0001', status: 'archived' }),
    mk({ id: '#0002', status: 'superseded' }),
    mk({ id: '#0003', status: 'candidate' }),
    mk({ id: '#0004', status: 'active' }),
  ];
  const sorted = api.sortForDisplay(entries);
  assert.deepStrictEqual(
    pluck(sorted, 'id'),
    ['#0004', '#0003', '#0002', '#0001'],
    '状态权重应为 active > candidate > superseded > archived',
  );
});

test('sortForDisplay：同权重时创建日期倒序，再相同时编号升序', () => {
  const byCreated = [
    mk({ id: '#0001', status: 'active', created: '2026-09-01' }),
    mk({ id: '#0002', status: 'active', created: '2026-09-20' }),
    mk({ id: '#0003', status: 'active', created: '2026-09-10' }),
  ];
  assert.deepStrictEqual(
    pluck(api.sortForDisplay(byCreated), 'id'),
    ['#0002', '#0003', '#0001'],
    '创建日期应倒序（新者优先）',
  );

  const tie = [
    mk({ id: '#0003', status: 'active', created: '2026-09-20' }),
    mk({ id: '#0001', status: 'active', created: '2026-09-20' }),
    mk({ id: '#0002', status: 'active', created: '2026-09-20' }),
  ];
  assert.deepStrictEqual(
    pluck(api.sortForDisplay(tie), 'id'),
    ['#0001', '#0002', '#0003'],
    '创建日期相同时应按编号升序',
  );
});

test('sortForDisplay：可直接用于 parseMemoryFile 的解析结果', () => {
  const { entries } = api.parseMemoryFile(MEM_SAMPLE, MEM_FILE);
  const sorted = api.sortForDisplay(entries);
  assert.strictEqual(sorted.length, entries.length, '排序后条目不丢');
  assert.deepStrictEqual(
    toHost(sorted.map(project)),
    toHost(entries.map(project)),
    '本条夹具的文档顺序本身就满足排序规则，排序应为恒等',
  );
  assert.strictEqual(sorted[0].id, '#0007', '置顶的 #0007 应排在 #0008 之前');
});

// ────────────────────────── buildActionLine ──────────────────────────

test('buildActionLine：archive 带原因时拼成 /memory archive #编号 原因，编号带不带 # 都规范化', () => {
  assert.strictEqual(
    api.buildActionLine('archive', '#0012', '重复条目'),
    '/memory archive #0012 重复条目',
    'archive 带原因时应输出 /memory archive #0012 重复条目',
  );
  assert.strictEqual(
    api.buildActionLine('archive', '0012', '重复条目'),
    '/memory archive #0012 重复条目',
    "不带 # 的编号 '0012' 应补上 #",
  );
  assert.match(
    api.buildActionLine('archive', '12', '重复条目'),
    /^\/memory archive #0*12 重复条目$/,
    "编号 '12' 应规范化为 '#12' 或 '#0012'（契约只规定输出带 # 的规范形）",
  );
});

test('buildActionLine：archive 无原因时不带尾随空格', () => {
  const line = api.buildActionLine('archive', '#0012');
  assert.strictEqual(line, '/memory archive #0012', '无原因时不应多出一个尾随空格');
  assert.ok(!line.endsWith(' '), '无原因时整行不得以空格结尾');
});

test('buildActionLine：restore 形态固定且忽略原因', () => {
  assert.strictEqual(api.buildActionLine('restore', '#0012'), '/memory restore #0012', 'restore 应输出 /memory restore #0012');
  assert.strictEqual(
    api.buildActionLine('restore', '0012', '随便什么原因'),
    '/memory restore #0012',
    'restore 即使带了原因，输出仍应是 /memory restore #0012（原因被忽略）',
  );
});

test('buildActionLine：未知 action 与非法编号都抛错（实际实现行为，已报 Lead 核对契约）', () => {
  assert.throws(
    () => api.buildActionLine('unknown-action', '#0012'),
    /未知动作/,
    '未知 action 应抛出带「未知动作」的异常，而不是返回字符串',
  );
  assert.throws(
    () => api.buildActionLine('archive', '没有数字'),
    /编号/,
    '编号里取不到数字时应抛错，避免生成指向错误编号的命令行',
  );
});

// ────────────────────────── 交叉验证：夹具电池 ──────────────────────────

test('交叉验证：合法与畸形长期记忆夹具的 entries 全字段 + warnings code 都与 src/parse.js 一致', () => {
  const battery = [
    ['§5 形状样例', MEM_SAMPLE, MEM_FILE],
    ['只有标题', '## 约定\n- [#0021] 只有标题', MEM_FILE],
    ['重复编号', '## 约定\n- [#0007] 一\n- [#0007] 二', MEM_FILE],
    ['未知分节', '## 杂项\n- [#0051] 未知分节', MEM_FILE],
    ['缩进续行', '## 经验\n- [#0008] 续行\n  - 详细：第一行\n    第二行', MEM_FILE],
    ['续行挂在非 detail 字段上', '## 事实\n- [#0009] 非 detail 续行\n  - 标签：甲\n    乙', MEM_FILE],
    ['无编号条目', '## 约定\n- 忘了写编号', MEM_FILE],
    ['顶格已知字段（无列表标记）', '## 约定\n- [#0061] 顶格字段\n状态：candidate', MEM_FILE],
    ['顶格列表行会被当成新条目', '## 约定\n- [#0062] 第一条\n- 状态：candidate', MEM_FILE],
    ['H2 之前的条目', '- [#0041] 先于分节', MEM_FILE],
    ['CRLF 文本', '## 约定\r\n- [#0071] 回车换行\r\n  - 状态：candidate\r\n', MEM_FILE],
    ['Tab 缩进字段', '## 约定\n- [#0072] Tab 缩进\n\t- 状态：candidate', MEM_FILE],
    ['全角空格缩进字段', '## 约定\n- [#0073] 全角缩进\n\u3000\u3000- 状态：candidate', MEM_FILE],
    ['未知字段', '## 约定\n- [#0074] 未知字段\n  - 来源备注：人工', MEM_FILE],
    ['中英文顿号混用的列表', '## 事实\n- [#0082] 顿号\n  - 标签：甲、乙，丙', MEM_FILE],
    ['非法枚举值', '## 事实\n- [#0083] 非法值\n  - 状态：不存在的状态\n  - 优先级：urgent\n  - 置信度：maybe', MEM_FILE],
    ['空文本', '', MEM_FILE],
    ['纯空行', '\n\n   \n\t\n', MEM_FILE],
    ['非 M-YYYY-MM-DD 文件名', '## 事实\n- [#0081] 文件名不合规', 'D:/proj/memory/INDEX.md'],
    ['裸文件名（历史形态）', '## 事实\n- [#0084] 裸文件名', 'M-2026-09-20.md'],
    ['活动文件里的 archived 条目', '## 事实\n- [#0092] 活动文件里的归档条\n  - 状态：archived\n  - 归档前状态：active', MEM_FILE],
    ['归档目录路径', '## 事实\n- [#0093] 归档文件条目\n  - 状态：archived', ARCHIVE_FILE],
    ['空行切断条目', '## 约定\n- [#0094] 被空行切开\n  - 详细：前半\n\n  后半行', MEM_FILE],
    ['归档三字段', '## 事实\n- [#0091] 已归档\n  - 状态：archived\n  - 归档时间：2026-09-20 10:00\n  - 归档原因：被取代\n  - 归档前状态：active', MEM_FILE],
  ];
  for (const [label, text, filePath] of battery) {
    assertSameMemoryEntries(text, filePath, label);
  }

  const archived = api.parseMemoryFile(battery[battery.length - 1][1], MEM_FILE).entries[0];
  assert.strictEqual(archived.status, 'archived', '归档条目状态应解析为 archived');
  assert.strictEqual(archived.archivedAt, '2026-09-20 10:00', '归档时间应解析出来');
  assert.strictEqual(archived.archivedReason, '被取代', '归档原因应解析出来');
  assert.strictEqual(archived.archivedStatusBefore, 'active', '归档前状态应解析出来');
});

test('交叉验证：合法与畸形日志夹具的 entries 全字段 + warnings code 都与 src/parse.js 一致', () => {
  const battery = [
    ['日志样例', JOURNAL_SAMPLE, JOURNAL_FILE],
    ['缺内容', '## J-20260920-1600 · 只有时间\n- 时间：2026-09-20 16:00', JOURNAL_FILE],
    ['同编号重复', '## J-20260920-1432 · A\n- 结果：x\n\n## J-20260920-1432 · B\n- 结果：y', JOURNAL_FILE],
    ['畸形 H2', '## 不是日志标题\n- 时间：2026-09-20 17:00', JOURNAL_FILE],
    ['空文本', '', JOURNAL_FILE],
    ['纯空行', '\n\n \n', JOURNAL_FILE],
    ['字段续行', '## J-20260920-1800 · 续行\n- 结果：第一行\n  第二行', JOURNAL_FILE],
    ['无标题', '## J-20260920-1900', JOURNAL_FILE],
    ['裸文本行', '## J-20260920-2000 · 裸行\n就是一行正文', JOURNAL_FILE],
    ['重复字段名', '## J-20260920-2100 · 重复字段\n- 结果：甲\n- 结果：乙', JOURNAL_FILE],
    ['非日志目录的文件名', '## J-20260920-2200 · 文件名不合规\n- 结果：r', 'D:/proj/memory/notes.md'],
    ['裸文件名（历史形态）', '## J-20260920-2300 · 裸文件名\n- 结果：r', 'JOURNAL-2026-09-20.md'],
  ];
  for (const [label, text, filePath] of battery) {
    assertSameJournalEntries(text, filePath, label);
  }
});
