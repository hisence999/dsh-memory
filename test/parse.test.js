/**
 * parse.js 的单元测试。
 *
 * 覆盖设计 §5.5 的 11 条语法契约判定、§5.2 字段表、§5.3 缺省值、§4.2 派生状态、
 * §5.4 日志、§8.1 规范化，以及"绝不丢内容"的保真要求（§14.6）。
 * 纯函数测试，不碰文件系统。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  defaultPriority,
  effectiveStatus,
  fileDateOf,
  isExpired,
  makeJournalId,
  measureEntry,
  normalize,
  parseJournalFile,
  parseMemoryFile,
  renderEntry,
  renderJournalFile,
  renderMemoryFile,
  splitList,
  timeLocal,
  todayLocal,
} from '../src/parse.js';

const FILE = 'D:/proj/memory/M-2026-09-20.md';

/** 组装一个记忆文件正文。 */
/** @param {string} body */
function mem(body) {
  return `# 记忆 · 2026-09-20\n\n${body}\n`;
}

test('标题行：带编号与不带编号都能解析', () => {
  const { entries, warnings } = parseMemoryFile(mem('## 约定\n- [#0007] 项目默认用 pnpm\n- 忘了写编号的一条\n'), FILE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, '#0007');
  assert.equal(entries[0].title, '项目默认用 pnpm');
  assert.equal(entries[0].kind, 'convention');
  assert.equal(entries[1].id, null);
  assert.equal(entries[1].title, '忘了写编号的一条');
  assert.equal(warnings.length, 0);
});

test('字段表：全部已知字段都能解析，缺省值按 §5.3', () => {
  const body = [
    '## 事实',
    '- [#0011] web profile 监听 3180 端口',
    '  - 状态：candidate',
    '  - 置顶：true',
    '  - 优先级：low',
    '  - 置信度：confirmed',
    '  - 创建：2026-01-02',
    '  - 更新：2026-01-03',
    '  - 有效至：2026-12-31',
    '  - 标签：port, web',
    '  - 别名：监听端口',
    '  - 关联：#0007',
    '  - 取代：#0009',
    '  - 取代者：#0012',
    '  - 关联日志：J-20260918-1542',
    '  - 来源：实测',
    '  - 详细：第一段',
    '    第二段',
    '  - 归档时间：2026-09-19 10:00',
    '  - 归档原因：过期',
    '  - 归档前状态：active',
  ].join('\n');
  const { entries, warnings } = parseMemoryFile(mem(body), FILE);
  const entry = entries[0];
  assert.equal(entry.status, 'candidate');
  assert.equal(entry.pinned, true);
  assert.equal(entry.priority, 'low');
  assert.equal(entry.confidence, 'confirmed');
  assert.equal(entry.created, '2026-01-02');
  assert.equal(entry.updated, '2026-01-03');
  assert.equal(entry.expiresAt, '2026-12-31');
  assert.deepEqual(entry.tags, ['port', 'web']);
  assert.deepEqual(entry.aliases, ['监听端口']);
  assert.deepEqual(entry.related, ['#0007']);
  assert.deepEqual(entry.supersedes, ['#0009']);
  assert.equal(entry.supersededBy, '#0012');
  assert.deepEqual(entry.relatedJournal, ['J-20260918-1542']);
  assert.equal(entry.source, '实测');
  assert.equal(entry.detail, '第一段\n第二段');
  assert.equal(entry.archivedAt, '2026-09-19 10:00');
  assert.equal(entry.archivedReason, '过期');
  assert.equal(entry.archivedStatusBefore, 'active');
  assert.equal(warnings.length, 0, '按契约写法应当零告警');
});

test('缺省值：未写的字段取文件日期与默认档位', () => {
  const { entries } = parseMemoryFile(mem('## 经验\n- [#0008] bundle 变化要重启 profile\n'), FILE);
  const entry = entries[0];
  assert.equal(entry.status, 'active');
  assert.equal(entry.pinned, false);
  assert.equal(entry.priority, defaultPriority('lesson'));
  assert.equal(entry.confidence, 'observed');
  assert.equal(entry.created, '2026-09-20');
  assert.equal(entry.updated, '2026-09-20');
  assert.equal(entry.expiresAt, '永久');
  assert.deepEqual(entry.presentFields, []);
});

test('未知字段：原样保留，且按锚点回写（§5.5 第 6 条）', () => {
  const body = [
    '## 约定',
    '- [#0007] 用 pnpm',
    '  - 备注：这是我加的',
    '  - 状态：active',
    '  - 我的备注二：在状态之后',
  ].join('\n');
  const { entries } = parseMemoryFile(mem(body), FILE);
  const entry = entries[0];
  assert.deepEqual(
    entry.unknownFields.map((item) => [item.name, item.anchor]),
    [
      ['备注', null],
      ['我的备注二', '状态'],
    ],
  );
  const rendered = renderEntry(entry).join('\n');
  assert.match(rendered, /- \[#0007\] 用 pnpm\n {2}- 备注：这是我加的\n {2}- 状态：active\n {2}- 我的备注二：在状态之后/);
});

test('顶格字段行：按字段处理并告警（§5.5 第 7 条第 1 项）', () => {
  const body = '## 约定\n- [#0007] 用 pnpm\n状态：candidate\n';
  const { entries, warnings } = parseMemoryFile(mem(body), FILE);
  assert.equal(entries[0].status, 'candidate');
  assert.ok(warnings.some((item) => item.code === 'field-no-indent'));
});

test('顶格列表行：视为新条目（§5.5 第 7 条第 2 项）', () => {
  const body = '## 约定\n- [#0007] 第一条\n- [#0008] 第二条\n';
  const { entries } = parseMemoryFile(mem(body), FILE);
  assert.deepEqual(entries.map((item) => item.id), ['#0007', '#0008']);
});

test('游离顶格行：原样保留为备注并告警（§5.5 第 7 条第 3 项）', () => {
  const body = '## 约定\n- [#0007] 用 pnpm\n这行既不是字段也不是列表项\n';
  const { entries, warnings } = parseMemoryFile(mem(body), FILE);
  assert.ok(warnings.some((item) => item.code === 'free-field'));
  assert.deepEqual(entries[0].orphanNotes, ['这行既不是字段也不是列表项']);
  assert.match(renderEntry(entries[0]).join('\n'), /这行既不是字段也不是列表项/);
});

test('缩进归一：Tab 与全角空格都表示"更深一级"（§5.5 第 4 条）', () => {
  const body = '## 约定\n- [#0007] 用 pnpm\n\t- 详细：Tab 缩进\n\u3000- 别名：全角缩进\n';
  const { entries } = parseMemoryFile(mem(body), FILE);
  assert.equal(entries[0].detail, 'Tab 缩进');
  assert.deepEqual(entries[0].aliases, ['全角缩进']);
});

test('空行终止条目且内容不丢（§5.5 第 5 条）', () => {
  const body = '## 约定\n- [#0007] 用 pnpm\n  - 详细：第一段\n\n  空行后的缩进行\n- [#0008] 第二条\n';
  const { entries, warnings } = parseMemoryFile(mem(body), FILE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].detail, '第一段');
  assert.ok(entries[0].orphanNotes.some((line) => line.includes('空行后的缩进行')));
  assert.ok(warnings.some((item) => item.code === 'entry-blank-line'), '空行之后仍有内容才告警');
});

test('空文件与"有内容但无条目"要分开：只剩标题的正常文件不得告警', () => {
  // 回归（用户真机测试发现）：当天文件刚创建、或条目全被归档后只剩 H1 头部，
  // 早期实现会反复报 empty-file（正常状态被当成损坏）。
  const onlyHeader = parseMemoryFile('# 记忆 · 2026-09-20\n\n', FILE);
  assert.equal(onlyHeader.entries.length, 0);
  assert.deepEqual(onlyHeader.warnings, [], '只剩标题的文件是正常状态，不该告警');

  const garbage = parseMemoryFile('# 记忆 · 2026-09-20\n\n这不是条目也不是字段的孤立内容\n', FILE);
  assert.ok(garbage.warnings.some((item) => item.code === 'empty-file'), '真正解析不出内容时才告警');
});

test('分节之间的空行不告警（插件自产文件重新解析必须零告警）', () => {
  // 回归（用户真机测试发现）：渲染产物在分节之间本来就有空行，早期实现会把它误判成
  // "条目内含空行"，导致每次扫描都反复报同一条告警。
  const { entries } = parseMemoryFile(mem('## 事实\n- [#0001] 第一条\n\n## 流程\n- [#0002] 第二条\n'), FILE);
  const rendered = renderMemoryFile('2026-09-20', entries);
  const reparsed = parseMemoryFile(rendered, FILE);
  assert.deepEqual(reparsed.warnings, [], '自产文件重新解析不得有任何告警');
  assert.equal(reparsed.entries.length, 2);
});

test('分节归属：类型以 H2 为准；H2 之前的条目告警（§4.1、§5.5 第 10 条）', () => {
  const body = '- [#0001] 出现在分节之前\n\n## 流程\n- [#0002] 改 patch 后先 dump-config\n\n## 不认识的节\n- [#0003] 未知分节下的条目\n';
  const { entries, warnings } = parseMemoryFile(mem(body), FILE);
  assert.deepEqual(
    entries.map((item) => [item.id, item.kind]),
    [
      ['#0001', 'fact'],
      ['#0002', 'procedure'],
      ['#0003', 'fact'],
    ],
  );
  assert.ok(warnings.some((item) => item.code === 'entry-before-section'));
  assert.ok(warnings.some((item) => item.code === 'unknown-section'));
});

test('派生状态：过期判定与优先序（§4.2）', () => {
  const { entries } = parseMemoryFile(mem('## 事实\n- [#0011] 端口 3180\n  - 有效至：2026-09-19\n'), FILE);
  const entry = entries[0];
  assert.equal(isExpired(entry, '2026-09-20'), true);
  assert.equal(effectiveStatus(entry, '2026-09-20'), 'expired');
  assert.equal(effectiveStatus(entry, '2026-09-18'), 'active');
  entry.status = 'superseded';
  assert.equal(effectiveStatus(entry, '2026-09-20'), 'superseded', 'superseded 压过 expired');
  entry.status = 'archived';
  assert.equal(effectiveStatus(entry, '2026-09-20'), 'archived', 'archived 最高优先');
});

test('规范化与列表拆分（§8.1）', () => {
  assert.equal(normalize('PORT ３１８０\\a'), 'port 3180/a');
  assert.deepEqual(splitList('ssh, server，端口、web'), ['ssh', 'server', '端口', 'web']);
});

test('日期工具：本地日期、加减、文件名解析', () => {
  assert.match(todayLocal(new Date(2026, 8, 20, 23, 30)), /^2026-09-20$/);
  assert.equal(addDays('2026-09-20', -1), '2026-09-19');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(fileDateOf('D:/proj/memory/M-2026-09-20.md'), '2026-09-20');
  assert.equal(fileDateOf('D:/proj/memory/JOURNAL-2026-09-20.md'), '2026-09-20');
  assert.equal(fileDateOf('D:/proj/memory/INDEX.md'), null);
  assert.match(timeLocal(new Date(2026, 8, 20, 9, 5)), /^09:05$/);
});

test('日志：ID、字段、内容与重复编号告警（§5.4）', () => {
  const body = [
    '# 项目日志 · 2026-09-20',
    '',
    '## J-20260920-1432 · 确认记忆插件的项目边界',
    '- 时间：2026-09-20 14:32',
    '- 结果：确认插件只读写项目根下的 memory/',
    '- 关联记忆：#0008',
    '',
    '## J-20260920-1432 · 同一分钟的第二条',
    '- 内容：故意重复编号',
    '',
  ].join('\n');
  const { entries, warnings } = parseJournalFile(body, 'D:/proj/memory/JOURNAL-2026-09-20.md');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'J-20260920-1432');
  assert.equal(entries[0].title, '确认记忆插件的项目边界');
  assert.equal(entries[0].date, '2026-09-20');
  assert.ok(entries[0].content.includes('memory/'));
  assert.ok(warnings.some((item) => item.code === 'duplicate-journal-id'));
});

test('日志编号生成：同分钟追加序号（§5.4）', () => {
  const taken = new Set(['J-20260920-1432']);
  const id = makeJournalId('2026-09-20', '14:32', taken);
  assert.equal(id, 'J-20260920-1432-2');
  assert.equal(makeJournalId('2026-09-20', '14:33', taken), 'J-20260920-1433');
});

test('保真：parse → render → parse 得到等价条目', () => {
  const body = [
    '## 约定',
    '- [#0007] 项目默认使用 SSH 别名 us 连接服务器',
    '  - 状态：active',
    '  - 置顶：true',
    '  - 优先级：high',
    '  - 置信度：confirmed',
    '  - 标签：ssh, server',
    '  - 别名：myserver, 服务器',
    '  - 详细：详见本项目的部署文档第 3 节。',
    '  - 我的备注：不应该丢',
    '',
    '## 经验',
    '- [#0008] DSH bundle 成员变化后必须重启 profile',
    '  - 来源：实测',
    '  - 关联日志：J-20260918-1542',
    '  - 详细：profile patch 支持热加载，但依赖清单变化不会随 patch 热加载。',
  ].join('\n');
  const first = parseMemoryFile(mem(body), FILE);
  const rendered = renderMemoryFile('2026-09-20', first.entries);
  const second = parseMemoryFile(rendered, FILE);

  /** @param {import('../src/parse.js').Entry} entry */
  const strip = (entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    status: entry.status,
    pinned: entry.pinned,
    priority: entry.priority,
    confidence: entry.confidence,
    tags: entry.tags,
    aliases: entry.aliases,
    detail: entry.detail,
    source: entry.source,
    relatedJournal: entry.relatedJournal,
    unknownFields: entry.unknownFields.map((item) => [item.name, item.value]),
  });
  assert.deepEqual(second.entries.map(strip), first.entries.map(strip));
  assert.deepEqual(
    second.warnings.filter((item) => item.code !== 'entry-blank-line'),
    [],
    '二次解析除"空行分隔条目"外不应产生新告警',
  );
});

test('日志保真：parse → render → parse 一致', () => {
  const body = '# 项目日志 · 2026-09-20\n\n## J-20260920-1432 · 标题\n- 结果：成功了\n- 后续：无\n';
  const first = parseJournalFile(body, 'D:/proj/memory/JOURNAL-2026-09-20.md');
  const rendered = renderJournalFile('2026-09-20', first.entries);
  const second = parseJournalFile(rendered, 'D:/proj/memory/JOURNAL-2026-09-20.md');
  assert.deepEqual(second.entries[0].fields, first.entries[0].fields);
  assert.equal(second.entries[0].content, first.entries[0].content);
});

test('measureEntry：字符数按 Unicode 计数（§5.6）', () => {
  const { entries } = parseMemoryFile(mem('## 约定\n- [#0007] 标题\n  - 详细：内容\n'), FILE);
  const measure = measureEntry(entries[0]);
  assert.equal(measure.titleChars, 2);
  assert.equal(measure.detailChars, 2);
  assert.ok(measure.itemChars > measure.titleChars + measure.detailChars);
});

test('解析绝不抛错：异常输入降级为 damaged', () => {
  const result = parseMemoryFile(/** @type {any} */ ({ toString: () => { throw new Error('boom'); } }), FILE);
  assert.equal(result.damaged, true);
  assert.equal(result.entries.length, 0);
  assert.ok(result.warnings.some((item) => item.code === 'parse-damaged'));
});
