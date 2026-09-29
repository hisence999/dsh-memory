/**
 * `memory_log` 的验收测试（设计 §7.5、§14.22～§14.24）。
 *
 * 覆盖：只追加到当天日志、编号唯一且同分钟加序号、**不做长期记忆查重**、
 * 仍走敏感信息检测、`relatedMemoryIds` 引用不存在只告警但照写、日志不进 `INDEX.md`。
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
import { createLogTool } from '../src/tools/log.js';

const NOW = new Date('2026-09-20T14:32:00');
const TODAY = parse.todayLocal(NOW);
const STAMP = TODAY.replace(/-/g, '');

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
 * @returns {string}
 */
function journalText(workspace) {
  return readFileSync(path.join(workspace, 'memory', `JOURNAL-${TODAY}.md`), 'utf8');
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

describe('memory_log：追加写入（§14.22／§14.23）', () => {
  test('落到当天 JOURNAL-YYYY-MM-DD.md，编号 J-YYYYMMDD-HHMM，字段完整', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());

    const { value, text } = await run(
      tool,
      {
        entries: [
          {
            title: '验证依赖热加载行为',
            content: '改了 profile patch，patch 修改可热加载；依赖清单变化仍需重启 profile。',
            result: '确认需要重启 profile',
            tags: ['bundle', 'restart'],
            relatedMemoryIds: ['#0008'],
          },
        ],
      },
      makeExec(workspace),
    );

    assert.equal(value.ok, true, text);
    assert.match(text, /\[memory_log 完成\]/);
    assert.match(text, /J-\d{8}-\d{4}/);
    assert.ok(existsSync(path.join(workspace, 'memory', `JOURNAL-${TODAY}.md`)));

    const content = journalText(workspace);
    assert.match(content, new RegExp(`## J-${STAMP}-1432 · 验证依赖热加载行为`));
    assert.match(content, /结果：确认需要重启 profile/);
    assert.match(content, /标签：bundle, restart/);
    assert.match(content, /关联记忆：#0008/);
  });

  test('同分钟多条：编号自动加序号且唯一', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());
    const exec = makeExec(workspace);

    await run(tool, { entries: [{ title: '第一条日志', content: '内容一' }] }, exec);
    const second = await run(tool, { entries: [{ title: '第二条日志', content: '内容二' }] }, exec);
    const third = await run(tool, { entries: [{ title: '第三条日志', content: '内容三' }] }, exec);

    assert.match(second.text, new RegExp(`J-${STAMP}-1432-2`));
    assert.match(third.text, new RegExp(`J-${STAMP}-1432-3`));
    const content = journalText(workspace);
    assert.match(content, new RegExp(`## J-${STAMP}-1432 · 第一条日志`));
    assert.match(content, new RegExp(`## J-${STAMP}-1432-2 · 第二条日志`));
    assert.match(content, new RegExp(`## J-${STAMP}-1432-3 · 第三条日志`));
  });

  test('只追加：人工写的其它内容不被吃掉', async () => {
    const workspace = makeWorkspace();
    const memoryDir = path.join(workspace, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      path.join(memoryDir, `JOURNAL-${TODAY}.md`),
      [`# 项目日志 · ${TODAY}`, '', '人工写在最前面的备注。', '', `## J-${STAMP}-0900 · 早上的一条`, '', '- 内容：早上记的东西', ''].join('\n'),
    );
    const tool = createLogTool(makeDeps());
    const { value } = await run(tool, { entries: [{ title: '下午新增的一条', content: '下午的内容' }] }, makeExec(workspace));
    assert.equal(value.ok, true);

    const content = journalText(workspace);
    assert.match(content, /人工写在最前面的备注。/);
    assert.match(content, new RegExp(`## J-${STAMP}-0900 · 早上的一条`));
    assert.match(content, /下午新增的一条/);
  });
});

describe('memory_log：不查重、引用宽松（§7.5）', () => {
  test('同一标题可以重复记录（过程本来就会重复尝试）', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());
    const exec = makeExec(workspace);

    const first = await run(tool, { entries: [{ title: '再试一次', content: '第一次尝试失败' }] }, exec);
    const second = await run(tool, { entries: [{ title: '再试一次', content: '第二次成功了' }] }, exec);

    assert.equal(first.value.ok, true);
    assert.equal(second.value.ok, true, '日志不做长期记忆查重');
    assert.equal(journalText(workspace).match(/## J-/g)?.length, 2);
  });

  test('relatedMemoryIds 引用不存在的编号：告警但照写', async () => {
    const workspace = makeWorkspace();
    seedMemory(workspace, '2026-09-19', ['## 事实', '- [#0008] 存在的一条', ''].join('\n'));
    const tool = createLogTool(makeDeps());

    const { value, text } = await run(
      tool,
      { entries: [{ title: '引用笔误的日志', content: '内容', relatedMemoryIds: ['#9999'] }] },
      makeExec(workspace),
    );

    assert.equal(value.ok, true);
    assert.match(text, /#9999/);
    assert.match(text, /仍写入/);
    assert.match(journalText(workspace), /引用笔误的日志/);
  });

  test('relatedMemoryIds 形态非法 → 拒绝该批', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());
    const { value, text } = await run(
      tool,
      { entries: [{ title: '编号形态错了', content: '内容', relatedMemoryIds: ['八号'] }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, false);
    assert.match(text, /编号非法/);
    assert.ok(!existsSync(path.join(workspace, 'memory', `JOURNAL-${TODAY}.md`)));
  });
});

describe('memory_log：敏感信息与参数校验（§7.6）', () => {
  test('命中凭据类 → 拒绝该条，不回显原文', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());
    const { value, text } = await run(
      tool,
      { entries: [{ title: '记录一次调用', content: 'Authorization: Bearer abc123' }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, false);
    assert.match(text, /内容/);
    assert.match(text, /凭据|credential/);
    assert.ok(!text.includes('abc123'));
    assert.ok(!existsSync(path.join(workspace, 'memory', `JOURNAL-${TODAY}.md`)));
  });

  test('title / content 必填，且 title 单行', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());
    const exec = makeExec(workspace);

    const noContent = await run(tool, { entries: [{ title: '只有标题' }] }, exec);
    assert.equal(noContent.value.ok, false);
    assert.match(noContent.text, /第 1 条/);
    assert.match(noContent.text, /content 必填/);

    const noTitle = await run(tool, { entries: [{ content: '只有内容' }] }, exec);
    assert.equal(noTitle.value.ok, false);
    assert.match(noTitle.text, /title 必填/);

    const multiline = await run(tool, { entries: [{ title: '第一行\n第二行', content: '内容' }] }, exec);
    assert.equal(multiline.value.ok, false);
    assert.match(multiline.text, /单行/);
  });

  test('不接受日志之外的字段（如 priority / confidence）', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps());
    const { value, text } = await run(
      tool,
      { entries: [{ title: '日志不该有优先级', content: '内容', priority: 'high' }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, false);
    assert.match(text, /priority/);
  });
});

describe('memory_log：与长期记忆索引隔离 + 权限', () => {
  test('日志不进入 INDEX.md', async () => {
    const workspace = makeWorkspace();
    seedMemory(workspace, '2026-09-19', ['## 事实', '- [#0008] 长期记忆的一条', ''].join('\n'));
    const tool = createLogTool(makeDeps());
    await run(tool, { entries: [{ title: '只属于日志的标题', content: '内容' }] }, makeExec(workspace));

    const index = readFileSync(path.join(workspace, 'memory', 'INDEX.md'), 'utf8');
    assert.match(index, /#0008/);
    assert.ok(!index.includes('只属于日志的标题'), '日志不进入 INDEX.md（§14.24）');
  });

  test('子代理调用被拒；工具定义 output 必填、isConcurrencySafe=false', async () => {
    const workspace = makeWorkspace();
    const tool = createLogTool(makeDeps({ allowed: false }));
    await assert.rejects(
      () => tool.execute({ entries: [{ title: '子代理日志', content: '内容' }] }, makeExec(workspace)),
      /拒绝执行/,
    );
    assert.equal(tool.name, 'memory_log');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.isConcurrencySafe(), false);
  });
});
