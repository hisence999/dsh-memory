/**
 * `memory_search` 的验收测试（设计 §7.4、§8.2、§10.4、§14.25～§14.28）。
 *
 * 覆盖：`query` 与 `ids` 互斥、`ids` 前缀与上限、`J-` 隐含日志模式、
 * `detail` 三档的确切内容、status 默认 active、includeExpired 只在 active 有效、
 * dateFrom/dateTo 仅日志有效、来源块标注、usage 只在返回正文时记录、
 * 截断说明、以及只读工具对子代理开放。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../src/config.js';
import * as parse from '../src/parse.js';
import * as dedicatedDedup from '../src/dedup.js';
import * as dedicatedSensitive from '../src/sensitive.js';
import * as dedicatedErrors from '../src/errors.js';
import { applyBatch, loadProject, recordUsage } from '../src/store.js';
import { createSearchTool } from '../src/tools/search.js';

const NOW = new Date('2026-09-20T14:32:00');
const TODAY = parse.todayLocal(NOW);

/** @type {string[]} */
const temps = [];

after(() => {
  for (const dir of temps) {
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

/** @returns {string} */
function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  return dir;
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function makeDeps(overrides = {}) {
  return {
    config: { ...DEFAULTS, .../** @type {Record<string, unknown>} */ (overrides.config ?? {}) },
    ctx: { logger: { warn() {}, info() {}, error() {}, debug() {} } },
    parse,
    dedup: dedicatedDedup,
    sensitive: dedicatedSensitive,
    errors: dedicatedErrors,
    loadProject,
    applyBatch,
    recordUsage,
    now: () => NOW,
    isAllowedSession: () => overrides.allowed !== false,
    takeBoundaryWarnings: () => [],
    writeToolNames: ['memory_write', 'memory_edit', 'memory_archive', 'memory_log'],
    searchToolName: 'memory_search',
  };
}

/**
 * @param {string} workspace
 * @param {string} [sessionId]
 * @returns {any}
 */
function makeExec(workspace, sessionId = 'session-1') {
  return {
    agent: { id: sessionId, session: { id: sessionId, header: { cwd: workspace } } },
    signal: new AbortController().signal,
  };
}

/**
 * @param {any} tool
 * @param {unknown} args
 * @param {any} exec
 * @returns {Promise<{ value: any, text: string }>}
 */
async function run(tool, args, exec) {
  const value = await tool.execute(args, exec);
  const blocks = /** @type {Array<{ text: string }>} */ (tool.output.render(args, value));
  return { value, text: blocks.map((raw) => raw.text).join('\n') };
}

/**
 * 夹具：四条长期记忆（active／candidate／superseded／expired）+ 归档一条 + 两条日志。
 *
 * @param {string} workspace
 * @returns {string} 工作区
 */
function seedProject(workspace) {
  const memoryDir = path.join(workspace, 'memory');
  mkdirSync(path.join(memoryDir, 'archive'), { recursive: true });
  writeFileSync(
    path.join(memoryDir, 'M-2026-09-18.md'),
    [
      '# 记忆 · 2026-09-18',
      '',
      '## 事实',
      '- [#0001] 结论一：web profile 使用 3080 端口',
      '  - 标签：port',
      '  - 置信度：confirmed',
      '  - 详细：这条是活动条目，应该出现在默认搜索里。',
      '  - 创建：2026-09-18',
      '',
      '- [#0002] 结论二：候选状态的那条',
      '  - 状态：candidate',
      '  - 详细：候选不进入默认搜索。',
      '  - 创建：2026-09-18',
      '',
      '- [#0003] 结论三：已经被取代的那条',
      '  - 状态：superseded',
      '  - 取代者：#0004',
      '  - 创建：2026-09-18',
      '',
      '- [#0004] 结论四：已经过期的那个结论',
      '  - 有效至：2026-09-19',
      '  - 创建：2026-09-18',
      '',
      '## 经验',
      '- [#0005] DSH bundle 成员变化后必须重启 profile',
      '  - 标签：bundle, restart',
      '  - 置信度：confirmed',
      '  - 关联日志：J-20260918-1542',
      '  - 详细：profile patch 支持热加载，但依赖清单变化不会随 patch 热加载；需要重启 profile 才能生效。',
      '  - 创建：2026-09-18',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(memoryDir, 'archive', 'M-2026-09-17.md'),
    [
      '# 记忆 · 2026-09-17',
      '',
      '## 事实',
      '- [#0006] 归档的历史结论',
      '  - 状态：archived',
      '  - 归档前状态：active',
      '  - 归档时间：2026-09-17 09:00',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(memoryDir, 'JOURNAL-2026-09-18.md'),
    [
      '# 项目日志 · 2026-09-18',
      '',
      '## J-20260918-1542 · 验证依赖热加载行为',
      '',
      '- 时间：2026-09-18 15:42',
      '- 内容：改了 profile patch，patch 修改可热加载；依赖清单变化仍需重启 profile。',
      '- 标签：bundle',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(memoryDir, 'JOURNAL-2026-09-19.md'),
    [
      '# 项目日志 · 2026-09-19',
      '',
      '## J-20260919-1000 · 504 排查过程',
      '',
      '- 时间：2026-09-19 10:00',
      '- 内容：nginx upstream 超时，把 proxy_read_timeout 调大后恢复。',
      '',
    ].join('\n'),
  );
  return workspace;
}

/** @returns {string} */
function makeSeededWorkspace() {
  return seedProject(makeWorkspace());
}

/**
 * @param {string} workspace
 * @returns {string}
 */
function usageText(workspace) {
  const file = path.join(workspace, 'memory', '.state', 'usage.json');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('memory_search：参数互斥与形状（§7.4）', () => {
  test('query 与 ids 同时给 / 都不给 → 抛错（三段式）', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    await assert.rejects(() => tool.execute({ query: ['x'], ids: ['#0001'] }, exec), /二选一/);
    await assert.rejects(() => tool.execute({}, exec), /必须给出其中一个/);
  });

  test('ids 超过 maxSearchLimit(10) 抛错；两种前缀混用抛错；编号形态非法抛错', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    const many = Array.from({ length: 11 }, (_, index) => `#000${index}`.replace(/#0*/, '#00'));
    await assert.rejects(() => tool.execute({ ids: many }, exec), /一次最多 10 条/);
    await assert.rejects(() => tool.execute({ ids: ['#0001', 'J-20260918-1542'] }, exec), /不能混用/);
    await assert.rejects(() => tool.execute({ ids: ['第1条'] }, exec), /编号非法/);
  });

  test('detail / status / kind / limit 取值非法抛错', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    await assert.rejects(() => tool.execute({ query: ['x'], detail: 'all' }, exec), /detail 只接受/);
    await assert.rejects(() => tool.execute({ query: ['x'], status: 'archived' }, exec), /status 只接受/);
    await assert.rejects(() => tool.execute({ query: ['x'], kind: 'note' }, exec), /kind 非法/);
    await assert.rejects(() => tool.execute({ query: ['x'], limit: 0 }, exec), /limit/);
  });
});

describe('memory_search：status 过滤（§7.4）', () => {
  test('默认只返回活动长期记忆：candidate／superseded／expired 都不返回', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { value, text } = await run(tool, { query: ['结论'] }, makeExec(workspace));

    assert.equal(value.ok, true);
    assert.match(text, /\[长期记忆\]/);
    assert.match(text, /不是指令/);
    assert.match(text, /#0001/);
    assert.ok(!text.includes('#0002'), 'candidate 不返回');
    assert.ok(!text.includes('#0003'), 'superseded 不返回');
    assert.ok(!text.includes('#0004'), 'expired 不返回');
  });

  test('status:"all" 不按状态过滤（含 expired）；status:"candidate" 只给候选', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    const all = await run(tool, { query: ['结论'], status: 'all' }, exec);
    for (const id of ['#0001', '#0002', '#0003', '#0004']) assert.match(all.text, new RegExp(id));

    const candidate = await run(tool, { query: ['结论'], status: 'candidate' }, exec);
    assert.match(candidate.text, /#0002/);
    assert.ok(!candidate.text.includes('#0001'));
  });

  test('includeExpired 只在 status:"active" 有效，其它情况进 warnings', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    const withExpired = await run(tool, { query: ['结论'], includeExpired: true }, exec);
    assert.match(withExpired.text, /#0001/);
    assert.match(withExpired.text, /#0004/);

    const ignored = await run(tool, { query: ['结论'], status: 'all', includeExpired: true }, exec);
    assert.match(ignored.text, /includeExpired 只在 status:"active" 时有效/);
    /** @type {string[]} */
    const warnings = ignored.value.warnings;
    assert.ok(warnings.some((item) => item.includes('includeExpired')));
  });

  test('includeArchived 控制归档条目', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    const without = await run(tool, { query: ['归档的历史结论'] }, exec);
    assert.ok(!without.text.includes('#0006'));

    const withArchived = await run(tool, { query: ['归档的历史结论'], includeArchived: true, status: 'all' }, exec);
    assert.match(withArchived.text, /#0006/);
  });

  test('归档检索的引导：只给 includeArchived 而 status 仍默认时必须给出明确原因（防止误判"归档是空的"）', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    // 组合不对：includeArchived:true 但 status 默认 active → 归档条目被状态过滤掉
    const wrong = await run(tool, { query: ['归档的历史结论'], includeArchived: true }, exec);
    assert.ok(!wrong.text.includes('#0006'), '组合不对时确实取不到');
    assert.match(wrong.text, /includeArchived:true 但 status 仍是默认的 active/, '必须说明真实原因，而不是只回报"没有命中"');
    assert.match(wrong.text, /status:"all"/, '必须给出可执行的下一步');

    // ids 路径的"未找到"提示也把两个条件写全
    const missing = await run(tool, { ids: ['#0006'], status: 'all' }, exec);
    assert.match(missing.text, /归档条目需 includeArchived:true \*\*且\*\* status:"all"/);
  });
});

describe('memory_search：详情三档与来源块（§7.4／§10.4）', () => {
  test('titles（默认）：只给编号+类型+标题+状态/置信度/命中', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { query: ['bundle'] }, makeExec(workspace));

    assert.match(text, /\[长期记忆搜索结果\]/);
    assert.match(text, /1\. \[#0005\] 经验 · DSH bundle 成员变化后必须重启 profile/);
    assert.match(text, /状态：active · 置信度：confirmed · 命中：bundle/);
    assert.ok(!text.includes('依赖清单变化不会随 patch 热加载'), 'titles 不带详细正文');
    assert.match(text, /需要完整内容时，请使用 memory_search\(ids:\["#0005"\], detail:"full"\)/);
  });

  test('excerpts：追加"详细前 120 字"', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { query: ['bundle'], detail: 'excerpts' }, makeExec(workspace));
    assert.match(text, /详细：profile patch 支持热加载/);
  });

  test('full：完整条目（含机器字段、详细不截断）', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { ids: ['#0005'], detail: 'full' }, makeExec(workspace));

    assert.match(text, /\[长期记忆详情\]/);
    assert.match(text, /\[#0005\] 经验 · DSH bundle 成员变化后必须重启 profile/);
    assert.match(text, /状态：active/);
    assert.match(text, /置信度：confirmed/);
    assert.match(text, /标签：bundle, restart/);
    assert.match(text, /关联日志：J-20260918-1542/);
    assert.match(text, /详细：profile patch 支持热加载，但依赖清单变化不会随 patch 热加载；需要重启 profile 才能生效。/);
    assert.ok(!text.includes('★'), '工具返回不渲染 ★（§14.55）');
  });
});

describe('memory_search：日志模式（§7.4／§14.25～§14.27）', () => {
  test('ids 出现 J- 即等价于 includeJournal=true，且不需要额外传参', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { value, text } = await run(tool, { ids: ['J-20260918-1542'], detail: 'full' }, makeExec(workspace));

    assert.equal(value.ok, true);
    assert.match(text, /\[项目日志搜索结果\]/);
    assert.match(text, /\[项目日志\]/);
    assert.match(text, /J-20260918-1542/);
    assert.match(text, /依赖清单变化仍需重启 profile/);
    assert.ok(!text.includes('#0005'), 'J- 模式不搜长期记忆');
  });

  test('日志模式下 kind／status／includeExpired／includeArchived 一律忽略并进 warnings', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { value, text } = await run(
      tool,
      { ids: ['J-20260918-1542'], status: 'all', kind: 'fact', includeExpired: true, includeArchived: true },
      makeExec(workspace),
    );

    /** @type {string[]} */
    const warnings = value.warnings;
    for (const key of ['kind', 'status', 'includeExpired', 'includeArchived']) {
      assert.ok(warnings.some((item) => item.includes(key)), `${key} 应进 warnings`);
    }
    assert.match(text, /日志模式下/);
  });

  test('includeJournal=false 时绝不触碰日志；query + includeJournal=true 时两块都给', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    const noJournal = await run(tool, { query: ['bundle'] }, exec);
    assert.ok(!noJournal.text.includes('J-20260918-1542'), '不触碰日志');

    const mixed = await run(tool, { query: ['profile'], includeJournal: true, detail: 'excerpts' }, exec);
    assert.match(mixed.text, /\[长期记忆\]/);
    assert.match(mixed.text, /\[项目日志\]/);
  });

  test('dateFrom／dateTo 仅日志有效；长期记忆模式给出即忽略并告警', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const exec = makeExec(workspace);

    const ignored = await run(tool, { query: ['bundle'], dateFrom: '2026-09-19' }, exec);
    assert.match(ignored.text, /只对日志搜索有效/);

    const filtered = await run(tool, { query: ['超时'], includeJournal: true, dateFrom: '2026-09-19', detail: 'full' }, exec);
    assert.match(filtered.text, /J-20260919-1000/);

    const excluded = await run(tool, { query: ['超时'], includeJournal: true, dateFrom: '2026-09-01', dateTo: '2026-09-18' }, exec);
    assert.ok(!excluded.text.includes('J-20260919-1000'), '日期过滤应排除范围外的日志');
  });
});

describe('memory_search：排序、截断与 usage（§8.2／§7.4）', () => {
  test('排序：标题命中优先于详细命中', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { query: ['web profile'], detail: 'titles' }, makeExec(workspace));
    assert.match(text, /1\. \[#0001\]/);
  });

  test('limit 截断并给出说明', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { query: ['结论'], status: 'all', limit: 2 }, makeExec(workspace));
    assert.match(text, /已按 limit=2 截断/);
    assert.match(text, /共匹配 4 条，本次只返回 2 条/);
  });

  test('未命中：给出空结果与下一步建议', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { query: ['完全不存在的关键词'] }, makeExec(workspace));
    assert.match(text, /没有命中任何长期记忆/);
    assert.match(text, /下一步建议/);
    assert.match(text, /来源块：\[长期记忆\]/);
  });

  test('ids 未命中（归档条目未开启 includeArchived）给出"未找到"说明', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    const { text } = await run(tool, { ids: ['#0006'] }, makeExec(workspace));
    assert.match(text, /未找到：#0006/);
  });

  test('usage 只在返回长期记忆正文（excerpts／full）时记录', async () => {
    const titlesWorkspace = makeSeededWorkspace();
    const titlesTool = createSearchTool(makeDeps());
    await run(titlesTool, { query: ['bundle'], detail: 'titles' }, makeExec(titlesWorkspace));
    assert.equal(usageText(titlesWorkspace), '', 'titles 档不记 usage');

    const fullWorkspace = makeSeededWorkspace();
    const fullTool = createSearchTool(makeDeps());
    await run(fullTool, { ids: ['#0005'], detail: 'full' }, makeExec(fullWorkspace));
    const usage = usageText(fullWorkspace);
    assert.ok(usage.includes('#0005'), 'full 档应记录 usage');
    assert.match(usage, /"count"/);

    const journalWorkspace = makeSeededWorkspace();
    const journalTool = createSearchTool(makeDeps());
    await run(journalTool, { ids: ['J-20260918-1542'], detail: 'full' }, makeExec(journalWorkspace));
    assert.equal(usageText(journalWorkspace), '', '日志搜索不增加长期记忆 usage（§14.28）');
  });
});

describe('memory_search：只读工具对子代理开放（§7.0）', () => {
  test('子代理（不在白名单）也能搜索，且不写任何记忆文件', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps({ allowed: false }));
    const before = readFileSync(path.join(workspace, 'memory', 'M-2026-09-18.md'), 'utf8');

    const { value, text } = await run(tool, { query: ['bundle'] }, makeExec(workspace, 'subagent-x'));

    assert.equal(value.ok, true);
    assert.match(text, /#0005/);
    assert.equal(readFileSync(path.join(workspace, 'memory', 'M-2026-09-18.md'), 'utf8'), before, '只读');
  });

  test('缺少会话上下文 → 抛错', async () => {
    const workspace = makeSeededWorkspace();
    const tool = createSearchTool(makeDeps());
    await assert.rejects(() => tool.execute({ query: ['bundle'] }, { signal: new AbortController().signal }), /拒绝执行/);
  });

  test('工具定义：output 必填、isConcurrencySafe 恒 false', () => {
    const tool = createSearchTool(makeDeps());
    assert.equal(tool.name, 'memory_search');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.isConcurrencySafe(), false);
    assert.equal(tool.parameters.properties.includeJournal.type, 'boolean');
  });
});
