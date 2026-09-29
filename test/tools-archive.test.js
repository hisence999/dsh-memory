/**
 * `memory_archive` 的验收测试（设计 §7.3、§6.2、§6.4、§14.15／§14.48／§14.72）。
 *
 * 覆盖：归档只影响单条、归档不是删除（措辞与文件位置）、恢复回填归档前状态并删除三字段、
 * 恢复不存在/已存在的编号、正常/过期条目的恢复提示、参数校验与子代理拒绝。
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
import { createArchiveTool } from '../src/tools/archive.js';

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
 * @returns {void}
 */
function seedMemory(workspace, date, body) {
  const memoryDir = path.join(workspace, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, `M-${date}.md`), `# 记忆 · ${date}\n\n${body}`);
}

/**
 * 三个条目的夹具：同一天里 #0012 要被归档，另外两条必须原样留下（§14.15）。
 *
 * @param {string} workspace
 * @returns {void}
 */
function seedThree(workspace) {
  seedMemory(
    workspace,
    '2026-09-19',
    [
      '## 事实',
      '- [#0011] 同一天的第一条',
      '  - 创建：2026-09-19',
      '',
      '- [#0012] 已经被 #0018 取代的那条',
      '  - 标签：port',
      '  - 详细：这条会被归档。',
      '  - 创建：2026-09-19',
      '',
      '- [#0013] 同一天的第三条',
      '  - 创建：2026-09-19',
      '',
    ].join('\n'),
  );
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
 * @param {string} workspace
 * @param {string} date
 * @returns {string}
 */
function archivedText(workspace, date) {
  return readFileSync(path.join(workspace, 'memory', 'archive', `M-${date}.md`), 'utf8');
}

describe('memory_archive：归档（§6.2／§6.4）', () => {
  test('归档单条：活动文件移出、归档文件保留正文与编号、措辞不说"已删除"', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());

    const { value, text } = await run(
      tool,
      { action: 'archive', ids: ['#0012'], reason: '已被 #0018 取代' },
      makeExec(workspace),
    );

    assert.equal(value.ok, true, text);
    assert.match(text, /\[memory_archive 完成\]/);
    assert.match(text, /不是删除|仍可追溯/);
    assert.ok(!text.includes('已删除'), '归档不是删除，措辞必须避开"已删除"');

    const active = fileText(workspace, '2026-09-19');
    assert.ok(!active.includes('[#0012]'), '活动文件里应移除该条');
    assert.match(active, /\[#0011\]/);
    assert.match(active, /\[#0013\]/, '同一天的其他条目不受影响（§14.15）');

    const archive = archivedText(workspace, '2026-09-19');
    assert.match(archive, /\[#0012\]/);
    assert.match(archive, /已经被 #0018 取代的那条/);
    assert.match(archive, /状态：archived/);
    assert.match(archive, /归档前状态：active/);
    assert.match(archive, /归档时间：2026-09-20/);
    assert.match(archive, /归档原因：已被 #0018 取代/);
  });

  test('归档不存在的编号 → not_found', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const { value, text } = await run(tool, { action: 'archive', ids: ['#0999'] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /not_found/);
    assert.match(text, /#0999/);
  });

  test('对已归档的编号再归档 → not_found', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const exec = makeExec(workspace);
    await run(tool, { action: 'archive', ids: ['#0012'] }, exec);
    const again = await run(tool, { action: 'archive', ids: ['#0012'] }, exec);
    assert.equal(again.value.ok, false);
    assert.match(again.text, /已归档/);
  });
});

describe('memory_archive：恢复（§6.2）', () => {
  test('恢复回填归档前状态并删除三个归档字段', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const exec = makeExec(workspace);

    await run(tool, { action: 'archive', ids: ['#0012'], reason: '临时隐藏' }, exec);
    const { value, text } = await run(tool, { action: 'restore', ids: ['#0012'] }, exec);

    assert.equal(value.ok, true, text);
    assert.match(text, /归档前状态/);
    const restored = fileText(workspace, '2026-09-19');
    assert.match(restored, /\[#0012\]/);
    assert.ok(!restored.includes('归档时间'), '归档时间应被移除');
    assert.ok(!restored.includes('归档原因'), '归档原因应被移除');
    assert.ok(!restored.includes('归档前状态'), '归档前状态应被移除');
    assert.ok(!restored.includes('状态：archived'), '状态应回填成 active');
  });

  test('恢复时 reason 被忽略并告警', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const exec = makeExec(workspace);
    await run(tool, { action: 'archive', ids: ['#0012'] }, exec);
    const { value, text } = await run(tool, { action: 'restore', ids: ['#0012'], reason: '恢复原因不该写' }, exec);
    assert.equal(value.ok, true);
    assert.match(text, /reason 被忽略/);
    assert.ok(!fileText(workspace, '2026-09-19').includes('恢复原因不该写'));
  });

  test('恢复归档区里没有的编号 → not_found', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const { value, text } = await run(tool, { action: 'restore', ids: ['#0012'] }, makeExec(workspace));
    assert.equal(value.ok, false);
    assert.match(text, /归档区里没有编号 #0012/);
  });

  test('恢复已过期条目：正常恢复并附加"已过期"提示', async () => {
    const workspace = makeWorkspace();
    const archiveDir = path.join(workspace, 'memory', 'archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      path.join(archiveDir, 'M-2026-09-01.md'),
      [
        '# 记忆 · 2026-09-01',
        '',
        '## 事实',
        '- [#0015] 一条已经过期的历史结论',
        '  - 状态：archived',
        '  - 归档前状态：active',
        '  - 归档时间：2026-09-10 10:00',
        '  - 有效至：2026-09-15',
        '  - 创建：2026-09-01',
        '',
      ].join('\n'),
    );
    const tool = createArchiveTool(makeDeps());
    const { value, text } = await run(tool, { action: 'restore', ids: ['#0015'] }, makeExec(workspace));

    assert.equal(value.ok, true, text);
    assert.match(text, /已过期/);
    assert.match(text, /有效至/);
  });
});

describe('memory_archive：参数校验与权限', () => {
  test('action 非法 / ids 为空 抛错；编号形态非法给三段式失败文本', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const exec = makeExec(workspace);

    await assert.rejects(() => tool.execute({ action: 'delete', ids: ['#0012'] }, exec), /action 只接受/);
    await assert.rejects(() => tool.execute({ action: 'archive', ids: [] }, exec), /ids 必须是/);
    await assert.rejects(() => tool.execute({ action: 'archive' }, exec), /ids 必须是/);

    const bad = await run(tool, { action: 'archive', ids: ['零号'] }, exec);
    assert.equal(bad.value.ok, false);
    assert.match(bad.text, /编号非法/);
    assert.match(bad.text, /做了什么：/);
  });

  test('归档原因命中敏感信息 → 拒绝（不回显原文）', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps());
    const { value, text } = await run(
      tool,
      { action: 'archive', ids: ['#0012'], reason: 'Authorization: Bearer abc123' },
      makeExec(workspace),
    );
    assert.equal(value.ok, false);
    assert.match(text, /敏感信息/);
    assert.ok(!text.includes('abc123'));
    assert.match(fileText(workspace, '2026-09-19'), /\[#0012\]/, '拒绝时不得改动文件');
  });

  test('子代理调用被拒；工具定义 output 必填、isConcurrencySafe=false', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const tool = createArchiveTool(makeDeps({ allowed: false }));
    await assert.rejects(() => tool.execute({ action: 'archive', ids: ['#0012'] }, makeExec(workspace)), /拒绝执行/);
    assert.equal(tool.name, 'memory_archive');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.isConcurrencySafe(), false);
    assert.ok(existsSync(path.join(workspace, 'memory')));
  });
});
