/**
 * `memory_edit` 的验收测试（设计 §7.2、§14.47）。
 *
 * 覆盖：`detail: null` 清空详细、`tags: []` 清空标签、`expiresAt: null` 改回永久、
 * 早于今天的 `expiresAt` 被拒、`title: null` 非法、改 kind 移动分节并报告、
 * 归档条目被拒（提示先 restore）、按标题兜底匹配的多条命中拒绝、
 * 以及子代理调用被拒。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../src/config.js';
import * as parse from '../src/parse.js';
import * as dedicatedDedup from '../src/dedup.js';
import * as dedicatedSensitive from '../src/sensitive.js';
import * as dedicatedErrors from '../src/errors.js';
import { applyBatch, loadProject, recordUsage } from '../src/store.js';
import { createEditTool } from '../src/tools/edit.js';

const NOW = new Date('2026-09-20T14:32:00');
const TODAY = parse.todayLocal(NOW);
const YESTERDAY = parse.addDays(TODAY, -1);

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
 * @returns {any}
 */
function makeExec(workspace) {
  return {
    agent: { id: 'session-1', session: { id: 'session-1', header: { cwd: workspace } } },
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
 * @param {string} workspace
 * @param {string} date
 * @param {string} body
 * @returns {string}
 */
function seedMemory(workspace, date, body) {
  const memoryDir = path.join(workspace, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, `M-${date}.md`);
  writeFileSync(file, `# 记忆 · ${date}\n\n${body}`);
  return file;
}

/**
 * @param {string} workspace
 * @param {string} date
 * @param {string} body
 * @returns {string}
 */
function seedArchived(workspace, date, body) {
  const archiveDir = path.join(workspace, 'memory', 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const file = path.join(archiveDir, `M-${date}.md`);
  writeFileSync(file, `# 记忆 · ${date}\n\n${body}`);
  return file;
}

/**
 * @param {string} workspace
 * @param {string} date
 * @returns {string}
 */
function fileText(workspace, date) {
  return readFileSync(path.join(workspace, 'memory', `M-${date}.md`), 'utf8');
}

/**
 * 一条带详细与标签的既有记忆
 *
 * @param {string} workspace
 * @returns {string} 文件路径
 */
function seed0007(workspace) {
  return seedMemory(
    workspace,
    '2026-09-19',
    ['## 经验', '- [#0007] DSH bundle 成员变化后必须重启 profile', '  - 详细：原始详细内容。', '  - 标签：bundle, restart', '  - 创建：2026-09-19', ''].join(
      '\n',
    ),
  );
}

describe('memory_edit：detail 写入约束（§7.1／§5.5 第 5 条）', () => {
  test('detail 含空行、或用 -／* 项目符号分行，都必须被拒', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const exec = makeExec(workspace);
    const before = fileText(workspace, '2026-09-19');

    /** @type {Array<[string, RegExp]>} */
    const cases = [
      ['第一段\n\n第二段', /不能包含空行/],
      ['口径如下：\n- 第一条', /不能用 -／\* 项目符号分行/],
      ['口径如下：\n* 第一条', /不能用 -／\* 项目符号分行/],
    ];
    for (const [detail, pattern] of cases) {
      const { value, text } = await run(tool, { edits: [{ id: '#0007', detail }] }, exec);
      assert.equal(value?.ok, false, `必须当场拒绝：${detail}`);
      assert.match(text, pattern);
    }
    assert.equal(fileText(workspace, '2026-09-19'), before, '被拒时文件必须一字未改');
  });
});

describe('memory_edit：清空语义（§7.2）', () => {
  test('detail: null 清空详细；tags: [] 清空标签；编号与创建日期不变', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ id: '#0007', detail: null, tags: [] }] }, makeExec(workspace));

    assert.equal(value.ok, true, text);
    assert.match(text, /\[memory_edit 完成\]/);
    assert.match(text, /详细已清空/);
    assert.match(text, /标签已清空/);
    const content = fileText(workspace, '2026-09-19');
    assert.ok(!content.includes('详细'), '详细应被移除');
    assert.ok(!content.includes('标签'), '标签应被移除');
    assert.match(content, /\[#0007\]/);
    assert.match(content, /创建：2026-09-19/);
  });

  test('expiresAt: null 改回永久；早于今天被拒并给出设计原话', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const exec = makeExec(workspace);

    const past = await run(tool, { edits: [{ id: '#0007', expiresAt: YESTERDAY }] }, exec);
    assert.equal(past.value.ok, false);
    assert.match(past.text, /有效至不得早于今天；如需记录历史结论，请留空（永久）并在/);
    assert.ok(!fileText(workspace, '2026-09-19').includes('有效至'), '被拒时不得改动文件');

    const cleared = await run(tool, { edits: [{ id: '#0007', expiresAt: null }] }, exec);
    assert.equal(cleared.value.ok, true);
    assert.match(cleared.text, /有效至改回永久/);
    assert.ok(!fileText(workspace, '2026-09-19').includes('有效至'), 'null = 移除该字段，回落到永久');
  });

  test('title: null / id: null 一律非法；没有字段可改也拒绝', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const exec = makeExec(workspace);

    const badTitle = await run(tool, { edits: [{ id: '#0007', title: null }] }, exec);
    assert.equal(badTitle.value.ok, false);
    assert.match(badTitle.text, /title 不能被清空/);

    const badId = await run(tool, { edits: [{ id: null, detail: 'x' }] }, exec);
    assert.equal(badId.value.ok, false);
    assert.match(badId.text, /id/);

    const nothing = await run(tool, { edits: [{ id: '#0007' }] }, exec);
    assert.equal(nothing.value.ok, false);
    assert.match(nothing.text, /没有要修改的字段/);
  });
});

describe('memory_edit：改 kind 移动分节（§14.47）', () => {
  test('报告"已从「经验」分节移动到「事实」分节"，且文件里落在目标分节下', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ id: '#0007', kind: 'fact' }] }, makeExec(workspace));

    assert.equal(value.ok, true, text);
    assert.match(text, /已从「经验」分节移动到「事实」分节/);
    const content = fileText(workspace, '2026-09-19');
    const sectionIndex = content.indexOf('## 事实');
    const entryIndex = content.indexOf('[#0007]');
    assert.ok(sectionIndex >= 0 && entryIndex > sectionIndex, '条目必须在 ## 事实 之下');
    assert.ok(!content.includes('## 经验'), '空分节不再渲染');
  });

  test('改 kind 时若与目标类型的既有条目精确重复 → 拒绝', async () => {
    const workspace = makeWorkspace();
    seedMemory(
      workspace,
      '2026-09-19',
      ['## 事实', '- [#0002] 同样的标题', '', '## 经验', '- [#0007] 同样的标题', '  - 创建：2026-09-19', ''].join('\n'),
    );
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ id: '#0007', kind: 'fact' }] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /duplicate/);
    assert.match(text, /#0002/);
  });
});

describe('memory_edit：目标定位（编号 / 标题兜底）', () => {
  test('归档编号 → not_found 并提示先 restore', async () => {
    const workspace = makeWorkspace();
    seedArchived(
      workspace,
      '2026-09-19',
      ['## 事实', '- [#0012] 已归档的一条', '  - 状态：archived', '  - 归档前状态：active', '  - 归档时间：2026-09-19 10:00', ''].join('\n'),
    );
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ id: '#0012', detail: '试图改归档条目' }] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /#0012 已归档/);
    assert.match(text, /restore/);
  });

  test('编号不存在 → not_found', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ id: '#0999', detail: 'x' }] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /not_found/);
    assert.match(text, /#0999/);
  });

  test('按标题精确匹配兜底：命中一条 → 成功；标题未被改写', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(
      tool,
      { edits: [{ title: 'DSH bundle 成员变化后必须重启 profile', confidence: 'confirmed' }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, true, text);
    assert.match(text, /#0007/);
    assert.match(text, /置信度：observed → confirmed/);
    assert.match(fileText(workspace, '2026-09-19'), /DSH bundle 成员变化后必须重启 profile/);
  });

  test('按标题匹配到多条 → 拒绝并返回命中编号列表', async () => {
    const workspace = makeWorkspace();
    seedMemory(
      workspace,
      '2026-09-19',
      ['## 事实', '- [#0003] 重复标题的一条', '', '- [#0004] 重复标题的一条', ''].join('\n'),
    );
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ title: '重复标题的一条', detail: 'x' }] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /#0003/);
    assert.match(text, /#0004/);
    assert.match(text, /匹配到多条/);
  });

  test('按标题匹配不到 → not_found', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const { value, text } = await run(tool, { edits: [{ title: '根本不存在的标题', detail: 'x' }] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /not_found/);
  });
});

describe('memory_edit：整批与权限', () => {
  test('批量中一条失败 → 整批不写入，并逐条给原因', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps());
    const before = fileText(workspace, '2026-09-19');

    const { value, text } = await run(
      tool,
      { edits: [{ id: '#0007', detail: '这条本来合法' }, { id: '#0007', expiresAt: YESTERDAY }] },
      makeExec(workspace),
    );

    assert.equal(value.ok, false);
    assert.match(text, /第 2 条/);
    assert.equal(fileText(workspace, '2026-09-19'), before, '整批不写入');
  });

  test('子代理调用被拒', async () => {
    const workspace = makeWorkspace();
    seed0007(workspace);
    const tool = createEditTool(makeDeps({ allowed: false }));
    await assert.rejects(
      () => tool.execute({ edits: [{ id: '#0007', detail: 'x' }] }, makeExec(workspace)),
      /拒绝执行/,
    );
  });

  test('工具定义：output 必填、isConcurrencySafe 恒 false', () => {
    const tool = createEditTool(makeDeps());
    assert.equal(tool.name, 'memory_edit');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.isConcurrencySafe(), false);
  });
});
