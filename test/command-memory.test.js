/**
 * 宿主命令 `/memory` 的验收测试（task-1）。
 *
 * 三层：
 *   1. 纯解析单测：`parseMemoryCommand` 的三态（usage / invalid / op）；
 *   2. 装配层：命令注册走 `ctx.inject(['commands'], …)`（可选注入），旧宿主线降级不崩；
 *   3. 一致性：`/memory` 命令路径与 `memory_archive` 工具路径**同一份实现**——返回文本与落盘文件逐字一致。
 *
 * 桩风格照手册 §11 与 `test/assembly.test.js`；夹具全部造在系统临时目录里，绝不碰仓库 `memory/`。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, inject } from '../src/index.js';
import { DEFAULTS, resolveConfig } from '../src/config.js';
import { TOGGLE_TOOL_NAMES, createToggleState } from '../src/memory-toggle.js';
import {
  MEMORY_COMMAND_USAGE,
  TOGGLE_STATUS_OFF_TEXT,
  TOGGLE_STATUS_ON_TEXT,
  createMemoryCommand,
  parseMemoryCommand,
} from '../src/tools/archive.js';

/** 本测试自己造的临时工作区，跑完只清理自己创建的那些。 */
/** @type {string[]} */
const TEMP_ROOTS = [];
after(() => {
  for (const root of TEMP_ROOTS) {
    if (path.basename(root).startsWith('dshmem-cmd-')) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** @type {number} */
let seq = 0;

/**
 * 模拟真实 cordis 的 `ctx.inject`：它是 Context 上的**方法**，实现体为 `this.plugin({…})`
 * （`@deepseek-ai/cordis/lib/index.js:1599-1605`）。桩故意也依赖 `this`：若插件把
 * `ctx.inject` 解引用后直接调用（丢 `this`），这里会拿到空对象，命令注册不上 → 用例变红。
 *
 * @this {any}
 * @param {string[]} deps
 * @param {Function} callback
 * @returns {{ dispose: () => void }}
 */
function stubInject(deps, callback) {
  const childCtx = { ...this };
  if (!deps.includes('commands')) delete childCtx.commands;
  callback(childCtx);
  return { dispose: () => {} };
}

/**
 * 最小宿主桩：手册 §11 骨架 + cordis 的 `ctx.inject(deps, cb)`（可选注入）。
 *
 * @param {{ inject?: boolean, commands?: boolean }} [options] 缺省都有；`inject:false` 模拟旧宿主线
 * @returns {any}
 */
function makeHost(options = {}) {
  const wantInject = options.inject !== false;
  const wantCommands = options.commands !== false;

  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {any[]} */
  const contexts = [];
  /** @type {any[]} */
  const tools = [];
  /** @type {any[]} */
  const commands = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {any[]} */
  const effectDisposers = [];
  let unregistered = 0;

  const logger = {
    error: (/** @type {unknown} */ format, /** @type {unknown[]} */ ...rest) => logs.push(`error ${String(format)} ${rest.join(' ')}`),
    info: (/** @type {unknown} */ format, /** @type {unknown[]} */ ...rest) => logs.push(`info ${String(format)} ${rest.join(' ')}`),
    warn: (/** @type {unknown} */ format, /** @type {unknown[]} */ ...rest) => logs.push(`warn ${String(format)} ${rest.join(' ')}`),
    debug: () => {},
  };

  /** @type {any} */
  const ctx = {
    logger,
    effect: (/** @type {() => unknown} */ execute) => {
      const disposer = execute();
      effectDisposers.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    systemPrompt: {
      context: (/** @type {any} */ contribution) => {
        contexts.push(contribution);
        return () => {};
      },
    },
    tools: {
      register: (/** @type {any} */ definition) => {
        tools.push(definition);
        return () => {};
      },
      restrict: () => () => {},
    },
    on: (/** @type {string} */ eventName, /** @type {Function} */ listener) => {
      listeners.set(eventName, listener);
      return () => {};
    },
  };

  if (wantCommands) {
    ctx.commands = {
      register: (/** @type {any} */ definition) => {
        commands.push(definition);
        // 真实的 `CommandRuntime.register` 返回"注销该定义"的 disposer。
        return () => {
          unregistered += 1;
        };
      },
    };
  }

  if (wantInject) {
    // cordis：依赖就绪时回调被调用，缺席时回调永不执行（`registry.d.ts:185`）。桩里同步回调一次。
    ctx.inject = stubInject;
  }

  return {
    ctx: /** @type {import('../types/dsh.d.ts').PluginContext} */ (/** @type {unknown} */ (ctx)),
    contexts,
    tools,
    commands,
    logs,
    /** 卸载整棵 effect 树（验证注册确实走 ctx.effect）。 */
    disposeAll() {
      for (const disposer of effectDisposers) {
        if (typeof disposer === 'function') disposer();
      }
    },
    /** @returns {number} */
    unregisteredCount() {
      return unregistered;
    },
    /** 按真实签名派发事件。 */
    /** @param {string} eventName @param {...unknown} args */
    async fire(eventName, ...args) {
      const listener = listeners.get(eventName);
      if (listener === undefined) throw new Error(`没有监听 ${eventName}`);
      return await listener(...args);
    },
  };
}

/**
 * agent 桩：主会话 / 子会话由 header 决定（照 `test/assembly.test.js`）。
 *
 * @param {string} id
 * @param {string} cwd
 * @param {Record<string, unknown>} [header]
 * @returns {any}
 */
function makeAgent(id, cwd, header = {}) {
  return {
    id,
    session: { id, header: { cwd, ...header }, append: () => {} },
    ctx: { tools: { restrict: () => () => {} } },
    steer: () => {},
    inject: () => {},
  };
}

/**
 * 带 restrict 记录的 agent 桩（记忆开关测试用）。
 *
 * `restrict` 记录实参并返回**真实撤销器**，于是"/memory off 施加 → /memory on 撤销"
 * 这条时序链可以被逐字验证，而不是只看到"调用过一次"。
 *
 * @param {string} id
 * @param {string} cwd
 * @param {Record<string, unknown>} [header]
 * @returns {any}
 */
function makeScopedAgent(id, cwd, header = {}) {
  const agent = makeAgent(id, cwd, header);
  /** @type {Array<{ filter: any, live: boolean }>} */
  const restrictions = [];
  agent.ctx = {
    tools: {
      restrict: (/** @type {any} */ filter) => {
        const record = { filter, live: true };
        restrictions.push(record);
        return () => {
          record.live = false;
        };
      },
    },
  };
  agent.restrictions = restrictions;
  /** @returns {number} */
  agent.liveRestrictions = () => restrictions.filter((item) => item.live).length;
  return agent;
}

/** @returns {string} 一个干净的临时工作区。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmem-cmd-'));
  TEMP_ROOTS.push(root);
  return root;
}

/**
 * 三个条目的夹具：同一天里 #0012 要被归档，另外两条必须原样留下（沿用 tools-archive 的夹具）。
 *
 * @param {string} workspace
 * @returns {void}
 */
function seedThree(workspace) {
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'memory', 'M-2026-09-19.md'),
    [
      '# 记忆 · 2026-09-19',
      '',
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
    'utf8',
  );
}

/** @param {string} filePath @returns {string} */
function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '<缺失>';
}

/**
 * 把工作区绝对路径从文本里抹掉，便于两个不同临时目录的结果做逐字比较。
 *
 * @param {string} text
 * @param {string} workspace
 * @returns {string}
 */
function normalize(text, workspace) {
  return text.split(workspace).join('<ws>');
}

/**
 * 造一个已登记的宿主 + 主会话 agent（命令与工具走同一套会话闸门）。
 *
 * @param {string} workspace
 * @returns {Promise<{ host: any, agent: any }>}
 */
async function makeReadyHost(workspace) {
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent(`s-${(seq += 1)}`, workspace);
  await host.fire('agent/created', { agent, source: 'startup' });
  return { host, agent };
}

/**
 * 走工具路径。
 *
 * @param {string} workspace
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function viaTool(workspace, args) {
  const { host, agent } = await makeReadyHost(workspace);
  const tool = host.tools.find((/** @type {any} */ definition) => definition.name === 'memory_archive');
  assert.ok(tool, 'memory_archive 必须已注册');
  const value = await tool.execute(args, { agent, signal: new AbortController().signal });
  const blocks = /** @type {Array<{ text: string }>} */ (tool.output.render(args, value));
  return { ok: value.ok === true, text: blocks.map((raw) => raw.text).join('\n') };
}

/**
 * 走命令路径（handler 的入参按 `CommandInvocation` 真实形状给）。
 *
 * @param {string} workspace
 * @param {string} rawInput
 * @returns {Promise<{ kind: string, ok: boolean, text: string }>}
 */
async function viaCommand(workspace, rawInput) {
  const { host, agent } = await makeReadyHost(workspace);
  const definition = host.commands[0];
  assert.ok(definition, '/memory 命令必须已注册');
  const result = await definition.handler({
    commandId: 'c-1',
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.ok(result.kind === 'success' || result.kind === 'error', `kind 必须是 success/error，实际 ${String(result.kind)}`);
  return { kind: result.kind, ok: result.kind === 'success', text: result.text ?? '' };
}

// ───────────────────────────── 1. 参数解析（单测） ─────────────────────────────

describe('/memory：子命令解析（parseMemoryCommand）', () => {
  test('空输入 / 纯空白 → usage（成功语义由 handler 决定，解析层不抛错）', () => {
    for (const raw of ['', '   ', '\n\t ']) {
      const parsed = /** @type {any} */ (parseMemoryCommand(raw));
      assert.equal(parsed.kind, 'usage', `「${JSON.stringify(raw)}」应当是 usage`);
      assert.match(parsed.text, /\/memory archive <#NNNN>/, '用法说明必须含 archive 语法');
      assert.match(parsed.text, /\/memory restore <#NNNN>/, '用法说明必须含 restore 语法');
    }
  });

  test('未知子命令 → usage（按 task-1：成功返回用法说明，绝不抛错）', () => {
    for (const raw of ['bogus', 'delete #0012', '/memory archive #0012']) {
      const parsed = /** @type {any} */ (parseMemoryCommand(raw));
      assert.equal(parsed.kind, 'usage', `「${raw}」应当是 usage`);
    }
  });

  test('已知子命令但缺编号 → invalid', () => {
    for (const raw of ['archive', 'restore', '  archive   ']) {
      const parsed = /** @type {any} */ (parseMemoryCommand(raw));
      assert.equal(parsed.kind, 'invalid', `「${raw}」应当是 invalid`);
      assert.match(parsed.text, /用法/, 'invalid 也要给用法说明');
    }
  });

  test('archive 带编号与原因；子命令大小写不敏感；rawInput 的前导空白被吃掉', () => {
    const parsed = /** @type {any} */ (parseMemoryCommand('  Archive #0012 已被 #0018 取代  '));
    assert.equal(parsed.kind, 'op');
    assert.equal(parsed.action, 'archive');
    assert.equal(parsed.id, '#0012');
    assert.equal(parsed.reason, '已被 #0018 取代');
  });

  test('无原因时 reason 缺省（不是空串）', () => {
    const parsed = /** @type {any} */ (parseMemoryCommand('archive #0012'));
    assert.equal(parsed.kind, 'op');
    assert.equal(parsed.action, 'archive');
    assert.equal(parsed.id, '#0012');
    assert.equal(parsed.reason, undefined);
  });

  test('restore 的多余文本透传为 reason（共享实现会按 §7.3 报"reason 被忽略"）', () => {
    const parsed = /** @type {any} */ (parseMemoryCommand('restore #0012 顺手收起'));
    assert.equal(parsed.kind, 'op');
    assert.equal(parsed.action, 'restore');
    assert.equal(parsed.id, '#0012');
    assert.equal(parsed.reason, '顺手收起');
  });

  test('on / off → {kind:"toggle"}，大小写与前后空白都吃（动词判定走共享契约 toggleVerbOf）', () => {
    const on = /** @type {any} */ (parseMemoryCommand('on'));
    assert.equal(on.kind, 'toggle');
    assert.equal(on.on, true);

    const off = /** @type {any} */ (parseMemoryCommand('  OFF  '));
    assert.equal(off.kind, 'toggle');
    assert.equal(off.on, false);

    // 多写的尾巴不影响判定（与 archive 的 reason 透传同风格：不静默丢信息，但也不报错）
    const noisy = /** @type {any} */ (parseMemoryCommand('Off 本会话先别记'));
    assert.equal(noisy.kind, 'toggle');
    assert.equal(noisy.on, false);
  });

  test('status → {kind:"status"}（只读查询，解析层不碰状态、不带 text）', () => {
    const parsed = /** @type {any} */ (parseMemoryCommand('status'));
    assert.equal(parsed.kind, 'status');
    assert.equal(parsed.on, undefined, 'status 不是开关，不得带 on 字段');
    assert.equal(parsed.text, undefined, 'status 的文案由 handler 按当时状态生成，解析层不预置');

    const upper = /** @type {any} */ (parseMemoryCommand('  STATUS '));
    assert.equal(upper.kind, 'status', '子命令大小写不敏感');
  });

  test('开关三子命令写进用法说明（on/off/status 都能被用户发现）', () => {
    assert.match(MEMORY_COMMAND_USAGE, /\/memory on/);
    assert.match(MEMORY_COMMAND_USAGE, /\/memory off/);
    const parsed = /** @type {any} */ (parseMemoryCommand('bogus'));
    assert.equal(parsed.kind, 'usage');
    assert.match(parsed.text, /\/memory on/, '用法说明里必须能看到开关用法');
  });
});

// ───────────────────────────── 2. 注册与降级（装配） ─────────────────────────────

describe('/memory：命令注册与降级（装配）', () => {
  test('注册一条 name=memory 的命令；inject 仍只有两项（可选注入，不写进 inject）', () => {
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);

    assert.deepEqual(inject, ['systemPrompt', 'tools'], '可选服务不进 inject（否则旧宿主线加载即失败）');
    assert.equal(host.commands.length, 1, '应当注册恰好一条命令');
    const definition = host.commands[0];
    assert.equal(definition.name, 'memory', '命令名必须是小写、无前导斜杠的 memory');
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 0, 'description 必填（发现 UI 用）');
    assert.equal(typeof definition.handler, 'function');
    assert.equal(definition.input?.hint?.includes('archive'), true, 'input.hint 应广告 archive 语法');
    assert.equal(host.tools.length, 5, '五个工具照常注册');
  });

  test('注册走 ctx.effect：卸载 effect 树时命令被注销', () => {
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);
    assert.equal(host.commands.length, 1);
    assert.equal(host.unregisteredCount(), 0, '未卸载前不应注销');
    host.disposeAll();
    assert.equal(host.unregisteredCount(), 1, 'dispose 后必须调用 register 返回的 disposer');
  });

  test('旧宿主线（没有 ctx.inject）→ 不崩、留告警、五个工具照常', () => {
    const host = makeHost({ inject: false });
    apply(host.ctx, resolveConfig({}).config);
    assert.equal(host.commands.length, 0, '拿不到 commands 就不注册命令');
    assert.equal(host.tools.length, 5, '工具面绝不受影响');
    assert.ok(
      host.logs.some((/** @type {string} */ line) => line.includes('ctx.inject')),
      '必须留一条 warn（否则真机上看不出"为什么没有 /memory"）',
    );
  });

  test('有 ctx.inject 但没有 commands 服务 → 不崩、留告警', () => {
    const host = makeHost({ commands: false });
    apply(host.ctx, resolveConfig({}).config);
    assert.equal(host.commands.length, 0);
    assert.equal(host.tools.length, 5);
    assert.ok(
      host.logs.some((/** @type {string} */ line) => line.includes('commands 服务不可用')),
      '服务缺席时回调里要留告警',
    );
  });

  test('enabled=false 时命令也不注册', () => {
    const host = makeHost();
    apply(host.ctx, resolveConfig({ enabled: false }).config);
    assert.equal(host.commands.length, 0);
    assert.equal(host.tools.length, 0);
  });
});

// ───────────────────────────── 3. handler 的返回与安全 ─────────────────────────────

describe('/memory handler：返回形状与安全', () => {
  test('未知子命令 → {kind:success} + 用法说明，且不动任何文件', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const before = readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md'));
    const result = await viaCommand(workspace, 'bogus #0012');

    assert.equal(result.kind, 'success', 'task-1：未知子命令返回成功 + 用法');
    assert.match(result.text, /用法/);
    assert.equal(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), before, '用法路径不得改文件');
    assert.equal(fs.existsSync(path.join(workspace, 'memory', 'archive')), false, '不得创建 archive 目录');
  });

  test('缺编号 → {kind:error} + 用法说明，且不动任何文件', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const result = await viaCommand(workspace, 'archive');
    assert.equal(result.kind, 'error');
    assert.match(result.text, /用法/);
    assert.match(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), /\[#0012\]/, '不得改动文件');
  });

  test('子代理（未登记会话）走命令路径 → {kind:error} 拒绝执行，且不动文件', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);
    const child = makeAgent(`s-child-${(seq += 1)}`, workspace, { origin: 'subagent', parentSession: 's-main' });
    await host.fire('agent/created', { agent: child, source: 'startup' });

    const definition = host.commands[0];
    const result = await definition.handler({
      commandId: 'c-child',
      agent: child,
      rawInput: 'archive #0012 子代理不该能归档',
      attachments: [],
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'error', '子代理必须被拒（与工具层同一口径，设计 §7.0）');
    assert.match(String(result.text), /拒绝执行/);
    assert.match(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), /\[#0012\]/, '拒绝时不得改动文件');
  });

  test('命令路径的归档原因也过敏感信息扫描：拒绝且不回显原文', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const before = readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md'));

    const result = await viaCommand(workspace, 'archive #0012 Authorization: Bearer abc123');

    assert.equal(result.kind, 'error', '命中敏感信息必须失败');
    assert.match(result.text, /敏感信息/);
    assert.ok(!result.text.includes('abc123'), '绝不回显命中原文');
    assert.equal(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), before, '拒绝时不得改动文件');
  });

  test('restore 带原因 → 成功但给出"reason 被忽略"告警，且原因不落盘', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const archived = await viaCommand(workspace, 'archive #0012 临时隐藏');
    assert.equal(archived.kind, 'success', archived.text);

    const restored = await viaCommand(workspace, 'restore #0012 恢复原因不该写');
    assert.equal(restored.kind, 'success', restored.text);
    assert.match(restored.text, /reason 被忽略/, '与工具路径逐字同口径（§7.3）');
    assert.ok(
      !readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')).includes('恢复原因不该写'),
      '恢复原因不得落盘',
    );
  });

  test('rawInput 畸形（undefined / 非字符串）→ 仍返回合法 CommandResult，绝不抛错', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);
    const agent = makeAgent(`s-malformed-${(seq += 1)}`, workspace);
    await host.fire('agent/created', { agent, source: 'startup' });
    const definition = host.commands[0];

    for (const rawInput of [undefined, null, 12345, {}]) {
      const result = await definition.handler({
        commandId: 'c-malformed',
        agent,
        rawInput: /** @type {any} */ (rawInput),
        attachments: [],
        signal: new AbortController().signal,
      });
      assert.ok(
        result.kind === 'success' || result.kind === 'error',
        `rawInput=${JSON.stringify(rawInput)} 时必须返回合法 CommandResult，实际 ${JSON.stringify(result)}`,
      );
    }
    assert.match(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), /\[#0012\]/, '畸形输入不得改动文件');
  });

  test('handler 内部异常不外抛：落盘失败 → {kind:error} 且带原因', async () => {
    const workspace = makeWorkspace();
    seedThree(workspace);
    const agent = makeAgent('s-throw', workspace);
    const command = createMemoryCommand({
      config: { ...DEFAULTS },
      loadProject: async () => {
        throw new Error('磁盘炸了');
      },
      applyBatch: async () => ({ ok: false }),
      now: () => new Date('2026-09-20T14:32:00'),
      isAllowedSession: () => true,
      takeBoundaryWarnings: () => [],
    });

    const result = await command.handler({
      commandId: 'c-throw',
      agent,
      rawInput: 'archive #0012',
      attachments: [],
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'error', '异常必须转成 error 结果，绝不外抛');
    assert.match(String(result.text), /磁盘炸了/);
  });

  test('非对象入参也不外抛（rawInput 畸形 → 仍返回 CommandResult）', async () => {
    const workspace = makeWorkspace();
    const definition = createMemoryCommand({
      config: { ...DEFAULTS },
      loadProject: async () => ({ entries: [], warnings: [] }),
      applyBatch: async () => ({ ok: true, warnings: [], result: {} }),
      now: () => new Date('2026-09-20T14:32:00'),
      isAllowedSession: () => true,
      takeBoundaryWarnings: () => [],
    });
    const result = await definition.handler(/** @type {any} */ ({ agent: makeAgent('s-x', workspace) }));
    assert.ok(result.kind === 'success' || result.kind === 'error', '必须返回合法 CommandResult');
  });
});

// ───────────────── 4. 命令路径与 memory_archive 工具路径结果一致（装配） ─────────────────

describe('/memory 与 memory_archive：同一份实现，结果一致', () => {
  test('归档：返回文本与落盘文件逐字一致', async () => {
    const wsTool = makeWorkspace();
    const wsCmd = makeWorkspace();
    seedThree(wsTool);
    seedThree(wsCmd);

    const tool = await viaTool(wsTool, { action: 'archive', ids: ['#0012'], reason: '已被 #0018 取代' });
    const command = await viaCommand(wsCmd, 'archive #0012 已被 #0018 取代');

    assert.equal(tool.ok, true, tool.text);
    assert.equal(command.ok, true, command.text);
    assert.equal(
      normalize(command.text, wsCmd),
      normalize(tool.text, wsTool),
      '命令返回文本必须与工具返回文本逐字一致',
    );
    assert.equal(
      readIfExists(path.join(wsCmd, 'memory', 'M-2026-09-19.md')),
      readIfExists(path.join(wsTool, 'memory', 'M-2026-09-19.md')),
      '活动文件结果必须一致',
    );
    assert.equal(
      readIfExists(path.join(wsCmd, 'memory', 'archive', 'M-2026-09-19.md')),
      readIfExists(path.join(wsTool, 'memory', 'archive', 'M-2026-09-19.md')),
      '归档文件结果必须一致（含编号水位/字段顺序）',
    );
    assert.equal(
      normalize(readIfExists(path.join(wsCmd, 'memory', 'INDEX.md')), wsCmd),
      normalize(readIfExists(path.join(wsTool, 'memory', 'INDEX.md')), wsTool),
      'INDEX.md 重建结果必须一致（命令层没有另写一套文件操作）',
    );
  });

  test('失败（编号不存在）：{kind:error} 与工具 ok:false 的文本一致', async () => {
    const wsTool = makeWorkspace();
    const wsCmd = makeWorkspace();
    seedThree(wsTool);
    seedThree(wsCmd);

    const tool = await viaTool(wsTool, { action: 'archive', ids: ['#0999'] });
    const command = await viaCommand(wsCmd, 'archive #0999');

    assert.equal(tool.ok, false);
    assert.equal(command.kind, 'error', '工具失败必须映射成命令的 error 结果');
    assert.match(command.text, /not_found/);
    assert.equal(normalize(command.text, wsCmd), normalize(tool.text, wsTool), '失败文本也要逐字一致');
    assert.equal(
      readIfExists(path.join(wsCmd, 'memory', 'M-2026-09-19.md')),
      readIfExists(path.join(wsTool, 'memory', 'M-2026-09-19.md')),
      '失败时两边都不得改动文件',
    );
  });

  test('restore 往返：命令归档→恢复的结果与工具路径逐字一致；重复恢复报 not_found', async () => {
    const wsTool = makeWorkspace();
    const wsCmd = makeWorkspace();
    seedThree(wsTool);
    seedThree(wsCmd);

    const archTool = await viaTool(wsTool, { action: 'archive', ids: ['#0012'], reason: '临时隐藏' });
    const archCmd = await viaCommand(wsCmd, 'archive #0012 临时隐藏');
    assert.equal(archTool.ok, true, archTool.text);
    assert.equal(archCmd.kind, 'success', archCmd.text);
    assert.ok(
      !readIfExists(path.join(wsCmd, 'memory', 'M-2026-09-19.md')).includes('[#0012]'),
      '归档后活动文件不应再有该条',
    );

    const backTool = await viaTool(wsTool, { action: 'restore', ids: ['#0012'] });
    const backCmd = await viaCommand(wsCmd, 'restore #0012');
    assert.equal(backTool.ok, true, backTool.text);
    assert.equal(backCmd.kind, 'success', backCmd.text);
    assert.equal(normalize(backCmd.text, wsCmd), normalize(backTool.text, wsTool), '恢复文本必须一致');

    const activeCmd = readIfExists(path.join(wsCmd, 'memory', 'M-2026-09-19.md'));
    const activeTool = readIfExists(path.join(wsTool, 'memory', 'M-2026-09-19.md'));
    assert.equal(activeCmd, activeTool, '往返回来的活动文件必须与工具路径逐字一致');
    assert.match(activeCmd, /\[#0012\]/, '恢复后应回到活动文件');
    assert.ok(!activeCmd.includes('归档时间'), '归档时间字段应被移除');
    assert.ok(!activeCmd.includes('归档原因'), '归档原因字段应被移除');
    assert.ok(!activeCmd.includes('归档前状态'), '归档前状态字段应被移除');

    const again = await viaCommand(wsCmd, 'restore #0012');
    assert.equal(again.kind, 'error', '不在归档区的编号恢复必须失败');
    assert.match(again.text, /归档区里没有编号 #0012/);
  });
});

// ───────────────────── 5. /memory on|off|status：开关状态与工具面联动 ─────────────────────

/**
 * 造一个"命令 + 开关表"齐备的宿主（不注册 store 夹具，开关路径不碰文件）。
 *
 * @returns {Promise<{ host: any, agent: any, definition: any }>}
 */
async function makeToggleCommandHost() {
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeScopedAgent(`s-toggle-${(seq += 1)}`, makeWorkspace());
  await host.fire('agent/created', { agent, source: 'startup' });
  const definition = host.commands[0];
  assert.ok(definition, '/memory 命令必须已注册');
  return { host, agent, definition };
}

/** 走一次命令并断言返回形状合法。 */
async function runCommand(definition, agent, rawInput) {
  const result = await definition.handler({
    commandId: `c-${String(rawInput)}`,
    agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.ok(result.kind === 'success' || result.kind === 'error', `kind 必须合法，实际 ${String(result.kind)}`);
  return { kind: result.kind, text: result.text ?? '' };
}

describe('/memory on|off：开关状态与工具面联动', () => {
  test('/memory off：返回成功文案、状态变为关闭、以五个工具名施加 restrict', async () => {
    const { agent, definition } = await makeToggleCommandHost();

    const off = await runCommand(definition, agent, 'off');
    assert.equal(off.kind, 'success', off.text);
    assert.ok(off.text.includes('已为本会话关闭记忆功能'), '必须明说关了什么');
    assert.ok(off.text.includes('一个字都没动'), '必须说清记忆文件未被改动');
    assert.ok(off.text.includes('其他工具'), '必须说清不影响其他工具');

    assert.equal(agent.liveRestrictions(), 1, '关闭必须施加恰好一条 restrict');
    const filter = agent.restrictions[0].filter;
    assert.deepEqual(filter.deny, [...TOGGLE_TOOL_NAMES], '必须以五个记忆工具名 deny');
    assert.equal(filter.allow, undefined, '不得出现 allow');
  });

  test('/memory off 幂等：重复关闭返回 noop 文案，且不叠加 restrict', async () => {
    const { agent, definition } = await makeToggleCommandHost();

    const first = await runCommand(definition, agent, 'off');
    const second = await runCommand(definition, agent, 'off');

    assert.equal(second.kind, 'success', second.text);
    assert.notEqual(second.text, first.text, '重复关闭文案必须与首次不同，否则用户无法判断有没有生效（review P2-3）');
    assert.ok(second.text.includes('原本就是关闭状态'), 'noop 文案必须明说未做改动');
    assert.equal(agent.restrictions.length, 1, '重复关闭不得再叠一条限制（restrict 的限制层取交集）');
    assert.equal(agent.liveRestrictions(), 1, '闸门仍然活着');
  });

  test('/memory on：状态恢复，调用施加时的 disposer 撤销 restrict（不叠加）', async () => {
    const { agent, definition } = await makeToggleCommandHost();

    await runCommand(definition, agent, 'off');
    assert.equal(agent.liveRestrictions(), 1);

    const on = await runCommand(definition, agent, 'on');
    assert.equal(on.kind, 'success', on.text);
    assert.ok(on.text.includes('已为本会话开启记忆功能'), '必须明说开了什么');
    assert.equal(agent.liveRestrictions(), 0, '开启必须撤销闸门');
    assert.equal(agent.restrictions.length, 1, '撤销不得再叠加新的限制层');
  });

  test('/memory on 在从未关闭过的会话上：返回 noop 文案，且不碰工具面', async () => {
    const { agent, definition } = await makeToggleCommandHost();

    const on = await runCommand(definition, agent, 'on');
    assert.equal(on.kind, 'success', on.text);
    assert.ok(on.text.includes('原本就是开启状态'), '重复开启必须明说没做改动');
    assert.equal(agent.restrictions.length, 0, '没关过就不得 restrict');
  });

  test('/memory status 只读：返回约定的状态标记，调用前后状态与工具面都不变', async () => {
    const { agent, definition } = await makeToggleCommandHost();

    // ① 默认开启态
    const before = await runCommand(definition, agent, 'status');
    assert.equal(before.kind, 'success', before.text);
    assert.ok(before.text.includes(TOGGLE_STATUS_ON_TEXT), `status 必须含机器可判定标记「${TOGGLE_STATUS_ON_TEXT}」`);
    assert.ok(before.text.includes('/memory off'), 'text 里要带用法提示（开启态建议 off）');
    assert.equal(agent.restrictions.length, 0, 'status 不得施加 restrict');
    assert.equal(agent.liveRestrictions(), 0);

    // ② 关闭后再查
    await runCommand(definition, agent, 'off');
    const after = await runCommand(definition, agent, 'status');
    assert.ok(after.text.includes(TOGGLE_STATUS_OFF_TEXT), `关闭后必须含「${TOGGLE_STATUS_OFF_TEXT}」`);
    assert.ok(!after.text.includes(TOGGLE_STATUS_ON_TEXT), '两个标记互斥，不得同时出现');
    assert.ok(after.text.includes('/memory on'), 'text 里要带用法提示（关闭态建议 on）');

    // ③ 幂等无副作用：连查三次，文本逐字一致、工具面不变
    const again = await runCommand(definition, agent, 'status');
    const third = await runCommand(definition, agent, 'status');
    assert.equal(again.text, after.text, 'status 必须幂等（同状态同文本）');
    assert.equal(third.text, after.text, 'status 必须幂等（同状态同文本）');
    assert.equal(agent.restrictions.length, 1, 'status 不得追加 restrict');
    assert.equal(agent.liveRestrictions(), 1, 'status 不得撤销已有的 restrict');
  });

  test('/memory status 不碰任何文件（只读的硬要求）', async () => {
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);
    const workspace = makeWorkspace();
    seedThree(workspace);
    const agent = makeScopedAgent(`s-status-${(seq += 1)}`, workspace);
    await host.fire('agent/created', { agent, source: 'startup' });
    const definition = host.commands[0];

    const before = readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md'));
    const beforeIndex = readIfExists(path.join(workspace, 'memory', 'INDEX.md'));
    const result = await runCommand(definition, agent, 'status');

    assert.equal(result.kind, 'success', result.text);
    assert.equal(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), before, 'status 不得改记忆文件');
    assert.equal(readIfExists(path.join(workspace, 'memory', 'INDEX.md')), beforeIndex, 'status 不得改 INDEX.md');
    assert.equal(fs.existsSync(path.join(workspace, 'memory', 'archive')), false, 'status 不得创建 archive 目录');
  });

  test('开关子命令的闸门：on/off 被拒（写入类），status 只读放行且不改状态、不动工具面', async () => {
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);
    const workspace = makeWorkspace();
    const child = makeScopedAgent(`s-child-toggle-${(seq += 1)}`, workspace, { origin: 'subagent', parentSession: 's-main' });
    await host.fire('agent/created', { agent: child, source: 'startup' });
    const definition = host.commands[0];

    // 子代理在 agent/created 里本来就会被摘掉四个写入类工具（§7.0 的既有行为），
    // 所以这里量的是"命令有没有**额外**动工具面"。
    const before = child.restrictions.length;

    // 写入类：与工具路径同一套拒绝文案
    for (const rawInput of ['off', 'on']) {
      const result = await runCommand(definition, child, rawInput);
      assert.equal(result.kind, 'error', `子代理调 /memory ${rawInput} 必须被拒`);
      assert.match(result.text, /拒绝执行/, '与工具路径同一套拒绝文案');
    }

    // 只读类：客户端初始化开关 UI 要用它，必须总能拿到状态标记（与 memory_search 同一档）
    const status = await runCommand(definition, child, 'status');
    assert.equal(status.kind, 'success', 'status 是只读查询，必须放行');
    assert.ok(status.text.includes(TOGGLE_STATUS_ON_TEXT), '只读查询也要给出机器可判定的状态标记');

    assert.equal(child.restrictions.length, before, '被拒的开关与只读查询都不得额外改动工具面');

    // 状态也没被改：主会话视角下仍是"开"（子代理拒绝路径不写开关表）
    const main = makeScopedAgent(`s-main-${(seq += 1)}`, workspace);
    await host.fire('agent/created', { agent: main, source: 'startup' });
    const mainStatus = await runCommand(definition, main, 'status');
    assert.ok(mainStatus.text.includes(TOGGLE_STATUS_ON_TEXT), '被拒的开关不得留下关闭痕迹');
  });

  test('deps 缺 toggleState（旧装配线/单测桩）：退化为"一直开着"，命令不崩、不改状态', async () => {
    const workspace = makeWorkspace();
    const agent = makeScopedAgent('s-no-state', workspace);
    // 故意不给 toggleState / toggleRestrictors：失败方向必须是"不静默关掉用户记忆"
    const definition = createMemoryCommand({
      config: { ...DEFAULTS },
      loadProject: async () => ({ entries: [], warnings: [] }),
      applyBatch: async () => ({ ok: true, warnings: [], result: {} }),
      now: () => new Date('2026-09-20T14:32:00'),
      isAllowedSession: () => true,
      takeBoundaryWarnings: () => [],
    });

    const status = await runCommand(definition, agent, 'status');
    assert.equal(status.kind, 'success', status.text);
    assert.ok(status.text.includes(TOGGLE_STATUS_ON_TEXT), '没有开关表时按"开"处理（宁可照旧工作）');

    const off = await runCommand(definition, agent, 'off');
    assert.equal(off.kind, 'success', off.text);
    assert.equal(agent.restrictions.length, 0, '没有撤销器表时不得施加一个管不住的 restrict');
  });

  test('装配层真的把开关表注入 deps：off 之后同会话的 status 立刻变"已关闭"', async () => {
    const { agent, definition } = await makeToggleCommandHost();
    const off = await runCommand(definition, agent, 'off');
    assert.equal(off.kind, 'success', off.text);

    const status = await runCommand(definition, agent, 'status');
    assert.ok(
      status.text.includes(TOGGLE_STATUS_OFF_TEXT),
      'deps.toggleState 必须由装配层注入（否则命令改不动状态，客户端初始化也会读到错的开关位置）',
    );
  });

  test('装配层的开关表随插件实例独立：一个宿主关掉，不波及另一个宿主', async () => {
    const a = await makeToggleCommandHost();
    const b = await makeToggleCommandHost();
    await runCommand(a.definition, a.agent, 'off');

    const statusB = await runCommand(b.definition, b.agent, 'status');
    assert.ok(statusB.text.includes(TOGGLE_STATUS_ON_TEXT), '另一个插件实例的会话必须仍是开启态');
  });

  test('开关路径不碰文件：off/on 全程不改记忆目录', async () => {
    const host = makeHost();
    apply(host.ctx, resolveConfig({}).config);
    const workspace = makeWorkspace();
    seedThree(workspace);
    const agent = makeScopedAgent(`s-toggle-files-${(seq += 1)}`, workspace);
    await host.fire('agent/created', { agent, source: 'startup' });
    const definition = host.commands[0];

    const snapshotBefore = readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md'));
    const indexBefore = readIfExists(path.join(workspace, 'memory', 'INDEX.md'));
    await runCommand(definition, agent, 'off');
    await runCommand(definition, agent, 'on');
    await runCommand(definition, agent, 'status');

    assert.equal(readIfExists(path.join(workspace, 'memory', 'M-2026-09-19.md')), snapshotBefore, '开关不得改记忆文件');
    assert.equal(readIfExists(path.join(workspace, 'memory', 'INDEX.md')), indexBefore, '开关不得改 INDEX.md');
  });
});
