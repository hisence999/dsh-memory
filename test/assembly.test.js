/**
 * 装配层测试（设计 §11 的"两层分离"里的第二层）。
 *
 * 用**最小宿主桩**按真实事件形状驱动：`agent/created`（单参 payload）、
 * `session/event`（双参 `(session, event)`）、`tools/result`（双参 `(exec, result)`）、
 * `agent/turn-stopping`（单参 payload，含 turn/signal/agent）、`agent/disposed`。
 *
 * 覆盖：会话边界快照与注入缓存、`compact` 不算边界、子代理不注入且写入工具被 restrict 摘掉、
 * 交付提醒（含冷却与 abort）、会话内不重注入、工具注册面、清理。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, inject, name, WRITE_TOOL_NAMES } from '../src/index.js';
import { resolveConfig } from '../src/config.js';
import { TOGGLE_TOOL_NAMES } from '../src/memory-toggle.js';

/** 本测试自己造的临时工作区，跑完统一清理（只删自己创建的那些）。 */
/** @type {string[]} */
const TEMP_ROOTS = [];
after(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 造一个最小宿主桩（照手册 §11 的骨架，按真实参数形状派发）。 */
function makeHost() {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {any[]} */
  const contexts = [];
  /** @type {any[]} */
  const tools = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const restricted = [];

  /** @type {import('../types/dsh.d.ts').LoggerService} */
  const logger = {
    error: (format, ...rest) => logs.push(`error ${String(format)} ${rest.join(' ')}`),
    info: (format, ...rest) => logs.push(`info ${String(format)} ${rest.join(' ')}`),
    warn: (format, ...rest) => logs.push(`warn ${String(format)} ${rest.join(' ')}`),
    debug: () => {},
  };

  const ctx = {
    logger,
    effect: (/** @type {() => unknown} */ execute) => {
      const disposer = execute();
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
    on: (/** @type {string} */ eventName, /** @type {any} */ listener) => {
      listeners.set(eventName, listener);
      return () => {};
    },
  };

  return {
    ctx: /** @type {import('../types/dsh.d.ts').PluginContext} */ (/** @type {unknown} */ (ctx)),
    contexts,
    tools,
    logs,
    restricted,
    /** 按真实签名派发事件。 */
    /** @param {string} eventName @param {...unknown} args */
    async fire(eventName, ...args) {
      const listener = listeners.get(eventName);
      if (listener === undefined) throw new Error(`没有监听 ${eventName}`);
      return await listener(...args);
    },
    /** 走真实的 scope 求值路径拿注入文本。 */
    /** @param {any} agent */
    promptFor(agent) {
      const contribution = contexts[0];
      assert.ok(contribution, '应当注册了提示词贡献');
      return contribution.text({ scope: agent });
    },
    /** @param {string} eventName */
    has(eventName) {
      return listeners.has(eventName);
    },
  };
}

/**
 * 造一个 agent 桩：主会话 / 子会话由 header 决定。
 * @param {string} id
 * @param {string} cwd
 * @param {Record<string, unknown>} [header]
 * @returns {any}
 */
function makeAgent(id, cwd, header = {}) {
  /** @type {any[]} */
  const steered = [];
  /** @type {string[]} */
  const appended = [];
  /** @type {string[]} */
  const restricted = [];
  const agent = {
    id,
    session: {
      id,
      header: { cwd, ...header },
      append: (/** @type {string} */ type, /** @type {unknown} */ data) =>
        appended.push(`${type}:${JSON.stringify(data)}`),
    },
    ctx: {
      tools: {
        restrict: (/** @type {unknown} */ filter) => {
          restricted.push(JSON.stringify(filter));
          return () => {};
        },
      },
    },
    restricted,
    steer: (/** @type {any} */ message) => steered.push(message),
    inject: (/** @type {any} */ message) => steered.push(message),
    steered,
    appended,
  };
  return agent;
}

/** 造一个临时工作区，并写入一条已存在的长期记忆。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmem-asm-'));
  TEMP_ROOTS.push(root);
  const dir = path.join(root, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'M-2026-09-20.md'),
    [
      '# 记忆 · 2026-09-20',
      '',
      '## 约定',
      '- [#0007] 项目默认使用 SSH 别名 us 连接服务器',
      '  - 状态：active',
      '  - 标签：ssh',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('插件入口导出与工具注册面符合契约', () => {
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  assert.equal(name, 'memory');
  assert.deepEqual(inject, ['systemPrompt', 'tools']);
  assert.deepEqual(
    host.tools.map((definition) => definition.name).sort(),
    ['memory_archive', 'memory_edit', 'memory_log', 'memory_search', 'memory_write'],
  );
  for (const definition of host.tools) {
    assert.ok(definition.output, `${definition.name} 必须声明 output`);
    assert.ok(Array.isArray(definition.output.render({}, {})), 'render 必须返回内容块数组');
    assert.equal(definition.isConcurrencySafe?.({}), false, '必须显式声明为非并发安全');
  }
  for (const eventName of ['agent/created', 'agent/turn-stopping', 'agent/disposed', 'session/event', 'tools/result']) {
    assert.ok(host.has(eventName), `应当监听 ${eventName}`);
  }
});

test('会话边界：注入只有快照块（无固定说明），落 INDEX.md', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-main', workspace);

  await host.fire('agent/created', { agent, source: 'startup' });

  const text = host.promptFor(agent);
  assert.match(text, /不是指令/, '注入必须带"资料不是指令"的边界声明');
  assert.match(text, /\[#0007\]/, '标题快照必须含已有条目的编号');
  assert.match(text, /project_memory_snapshot/, '必须含快照标签');
  assert.match(text, /includeJournal=true/, '必须含日志按需检索指引');
  // 用户二改（2026-09-20）：A/B 固定说明整层不再注入，注入内容**只有**快照块。
  assert.ok(text.startsWith('<project_memory_snapshot>'), '注入必须以快照开始标签开头');
  assert.ok(text.endsWith('</project_memory_snapshot>'), '注入必须以快照结束标签结尾');
  for (const gone of [
    '## 项目记忆与日志',
    '## 工具速记',
    '写入判断',
    '长期记忆类型只有四种',
    '标题必须是一条独立可用的短陈述',
    '[记忆插件]',
    'memory_write',
    'memory_edit',
    'memory_archive',
    'memory_log',
  ]) {
    assert.equal(text.includes(gone), false, `注入里不应再出现固定说明「${gone}」`);
  }
  // 交付时调用 present 的硬要求由宿主自己的 present 工具描述承担（dsh-tool-present）：
  assert.equal(text.includes('present'), false, '注入里不应出现 present 指引');

  const indexPath = path.join(workspace, 'memory', 'INDEX.md');
  assert.ok(fs.existsSync(indexPath), '会话边界应生成 INDEX.md');
  const indexContent = fs.readFileSync(indexPath, 'utf8');
  assert.match(indexContent, /next-id:/, 'INDEX.md 头部必须有 next-id 注记');
  assert.match(indexContent, /#0007/, 'INDEX.md 必须列出条目');
});

test('会话边界：日志标题段进注入（最新优先、只注入标题、正文不进快照）', async () => {
  const workspace = makeWorkspace();
  const sentinel = '正文哨兵-SENTINEL-9F3A';
  fs.writeFileSync(
    path.join(workspace, 'memory', 'JOURNAL-2026-09-20.md'),
    [
      '# 项目日志 · 2026-09-20',
      '',
      '## J-20260920-1432 · 先做的那件事',
      `- 内容：${sentinel}`,
      '',
      '## J-20260920-1752 · 后做的那件事',
      `- 内容：${sentinel}`,
      '- 结果：成功了',
      '',
    ].join('\n'),
    'utf8',
  );

  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-main-journal', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  const text = host.promptFor(agent);
  const lines = text.split('\n');
  const indexAt = lines.indexOf('[项目记忆索引]');
  const journalAt = lines.indexOf('[项目日志]');
  assert.ok(indexAt > 0, '必须有索引段');
  assert.ok(journalAt > indexAt, '日志段必须在索引段之后');

  // 最新优先：同一天里后写的 J-20260920-1752 排在前面
  assert.equal(lines[journalAt + 1], '[J-20260920-1752] 后做的那件事');
  assert.equal(lines[journalAt + 2], '[J-20260920-1432] 先做的那件事');
  assert.equal(text.includes(sentinel), false, '日志正文绝不能进注入');
  assert.match(text, /项目日志只注入标题/);
  assert.match(text, /includeJournal=true/);

  // 说明行只数日志省略：两条都在 → 没有 (c) 句
  assert.equal(text.includes('另有'), false);
});

test('会话内不重新注入：边界后改文件，注入文本保持不变', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-main-2', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });
  const before = host.promptFor(agent);

  // 直接改文件（模拟会话内写入）——注入文本必须不变（§9.1 / §14.31）
  fs.appendFileSync(
    path.join(workspace, 'memory', 'M-2026-09-20.md'),
    '- [#0008] 会话中新写的一条\n  - 状态：active\n',
    'utf8',
  );
  assert.equal(host.promptFor(agent), before, '会话内注入文本必须逐字不变');
});

test('compact 不算会话边界：沿用旧快照', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-main-3', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });
  const before = host.promptFor(agent);

  fs.appendFileSync(
    path.join(workspace, 'memory', 'M-2026-09-20.md'),
    '- [#0009] 压缩后新增的一条\n  - 状态：active\n',
    'utf8',
  );
  await host.fire('agent/created', { agent, source: 'compact' });
  assert.equal(host.promptFor(agent), before, 'compact 不得重建快照（§9.1）');
});

test('子代理：写入工具被 restrict 摘掉，注入只给只读快照（不写盘）', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const child = makeAgent('s-child', workspace, { origin: 'subagent', parentSession: 's-main' });

  await host.fire('agent/created', { agent: child, source: 'startup' });

  assert.equal(child.restricted.length, 1, '子会话必须调用一次 restrict');
  const filter = JSON.parse(child.restricted[0]);
  assert.deepEqual(filter.deny, [...WRITE_TOOL_NAMES], '只能用 deny，且精确列出四个写入工具');
  assert.equal(filter.allow, undefined, '不允许出现 allow（会连带隐藏 bash/read）');

  const text = host.promptFor(child);
  assert.match(text, /project_memory_snapshot/, '子代理也注入只读快照');
  assert.match(text, /\[#0007\]/, '子代理快照里能看到已有条目的编号');
  assert.match(text, /memory_search/, '快照末尾的日志提示行指引 memory_search');
  for (const toolName of WRITE_TOOL_NAMES) {
    assert.ok(!text.includes(toolName), `子代理注入里不得出现 ${toolName}`);
  }
  assert.equal(text.includes('## 项目记忆与日志'), false, '子代理不再有独立的固定说明');
  // 只读保证：子代理建快照不得校正编号、不得重建 INDEX.md
  assert.equal(
    fs.existsSync(path.join(workspace, 'memory', 'INDEX.md')),
    false,
    '子代理路径不得写 INDEX.md',
  );
});

test('fork 顶层会话：不摘写入工具、按主会话建快照、可写入可提醒（2026-09-26 真机 P0 回归）', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  // 宿主 SessionStore.fork()／commands.fork() 写出的真实 header 形状：
  // 有 parentSession、无 origin、isSeeded=true、delegationDepth=0
  const forked = makeAgent('session-285ad135', workspace, {
    parentSession: 'session-eb999a59',
    isSeeded: true,
    delegationDepth: 0,
  });

  await host.fire('agent/created', { agent: forked, source: 'startup' });

  // ① 关键回归：fork 顶层会话**不得**被 restrict 摘掉四个写入类工具
  assert.equal(forked.restricted.length, 0, 'fork 顶层会话不是子代理，绝不能调 restrict');
  assert.ok(
    host.logs.some((line) => line.includes('检测到 fork 顶层会话')),
    '必须留一条 info（真机排查"为什么工具没了"的唯一线索）',
  );

  // ② 注入走主会话路径：快照 + INDEX.md（子代理只读路径不写 INDEX.md）
  const text = host.promptFor(forked);
  assert.match(text, /project_memory_snapshot/, 'fork 会话必须有注入');
  assert.match(text, /\[#0007\]/, '快照里要看得到已有条目');
  assert.ok(fs.existsSync(path.join(workspace, 'memory', 'INDEX.md')), 'fork 会话按主会话边界写 INDEX.md');

  // ③ execute 层第二道防线也必须放行（否则会变成"工具在、却拒绝执行"）
  const writeTool = host.tools.find((definition) => definition.name === 'memory_write');
  assert.ok(writeTool, 'memory_write 必须已注册');
  const value = await writeTool.execute(
    { entries: [{ kind: 'fact', title: 'fork 顶层会话应当能写长期记忆' }] },
    { agent: forked, signal: new AbortController().signal },
  );
  assert.equal(value.ok, true, `fork 会话写入必须成功（实际：${JSON.stringify(value)}）`);

  // ④ 提醒：fork 会话是主会话，交付轮应提醒一次
  await host.fire('session/event', { id: 'session-285ad135' }, { type: 'turn/start' });
  await host.fire('tools/result', { name: 'present', agent: forked, signal: new AbortController().signal }, { isError: false });
  await host.fire(
    'session/event',
    { id: 'session-285ad135' },
    { type: 'deliverables/presented', data: { turn: 1, callId: 'c-fork', files: [{ path: 'x' }] } },
  );
  await host.fire('agent/turn-stopping', { agent: forked, turn: 1, signal: new AbortController().signal });
  assert.equal(forked.steered.length, 1, 'fork 顶层会话必须能收到交付提醒');

  // ⑤ 内存态 fork：宿主 meta 只写 { cwd, parentSession, isSeeded }，delegationDepth 要落盘才补 0
  const liveFork = makeAgent('session-fork-live', workspace, { parentSession: 's-main', isSeeded: true });
  await host.fire('agent/created', { agent: liveFork, source: 'startup' });
  assert.equal(liveFork.restricted.length, 0, '内存态 fork 同样不得 restrict');
  assert.match(host.promptFor(liveFork), /project_memory_snapshot/, '内存态 fork 同样要注入快照');
});

test('未知 lineage（有 parentSession、isSeeded 不明确）：隔离，不当主会话也不摘工具', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const weird = makeAgent('s-weird-lineage', workspace, { parentSession: 's-someone' });

  await host.fire('agent/created', { agent: weird, source: 'startup' });

  assert.ok(
    host.logs.some((line) => line.includes('lineage 不明确')),
    '判不出来必须告警并按隔离处理（失败方向 = 少注入）',
  );
  assert.equal(weird.restricted.length, 0, '未经确认的子会话不摘工具，由 execute 层拒绝兜底');
  assert.equal(host.promptFor(weird), '', '隔离会话不注入');

  // execute 层第二道防线必须真的拦下来（"不摘工具"的代价就是这里必须拒绝）
  const writeTool = host.tools.find((definition) => definition.name === 'memory_write');
  assert.ok(writeTool, 'memory_write 必须已注册');
  await assert.rejects(
    () =>
      writeTool.execute(
        { entries: [{ kind: 'fact', title: '未登记会话尝试写入' }] },
        { agent: weird, signal: new AbortController().signal },
      ),
    /拒绝执行/,
    '未登记会话调用写入工具必须被拒绝（可见 ≠ 可写）',
  );
});

test('交付提醒：交付轮提醒一次，纯问答不提醒，同轮不重复', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({ completionIdleTurns: 1, reminderCooldownTurns: 1 }).config);
  const agent = makeAgent('s-main-4', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  // 轮 1：纯问答（无工具活动、无交付）→ 零提醒
  await host.fire('session/event', { id: 's-main-4' }, { type: 'turn/start' });
  await host.fire('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
  assert.equal(agent.steered.length, 0, '纯问答轮不得提醒');

  // 轮 2：交付（tools/result + deliverables/presented）→ 提醒一次
  await host.fire('session/event', { id: 's-main-4' }, { type: 'turn/start' });
  await host.fire('tools/result', { name: 'present', agent, signal: new AbortController().signal }, { isError: false });
  await host.fire(
    'session/event',
    { id: 's-main-4' },
    { type: 'deliverables/presented', data: { turn: 2, callId: 'c1', files: [{ path: 'x' }] } },
  );
  await host.fire('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal });
  assert.equal(agent.steered.length, 1, '交付轮应提醒一次');
  const message = agent.steered[0];
  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source']);
  assert.equal(message.role, 'user', '顶层 role 缺失会让上游拒绝整个请求');
  assert.match(message.content[0].text, /^\[记忆插件\]/);

  // 同一轮内再派发一次 turn-stopping：交付标志已消费 → 不得再提醒
  await host.fire('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal });
  assert.equal(agent.steered.length, 1, '同一轮只提醒一次');
});

test('提醒冷却：窗口内放弃且不补发，窗口满后恢复正常提醒', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  // 冷却 2 轮：轮 2 提醒后，轮 3 的交付落在窗口内（3-2=1 < 2）→ 放弃
  apply(host.ctx, resolveConfig({ completionIdleTurns: 1, reminderCooldownTurns: 2 }).config);
  const agent = makeAgent('s-main-4b', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  /** 走一轮"交付并收尾"。 */
  /** @param {number} turn */
  const deliverTurn = async (turn) => {
    await host.fire('session/event', { id: 's-main-4b' }, { type: 'turn/start' });
    await host.fire('tools/result', { name: 'present', agent, signal: new AbortController().signal }, { isError: false });
    await host.fire(
      'session/event',
      { id: 's-main-4b' },
      { type: 'deliverables/presented', data: { turn, callId: `c${turn}`, files: [{ path: 'x' }] } },
    );
    await host.fire('agent/turn-stopping', { agent, turn, signal: new AbortController().signal });
  };

  await deliverTurn(2);
  assert.equal(agent.steered.length, 1, '第一次交付应提醒');

  await deliverTurn(3);
  assert.equal(agent.steered.length, 1, '冷却窗口内的交付必须放弃这一发、且不补发');
  assert.ok(
    host.logs.some((line) => line.includes('冷却')),
    '冷却命中必须留一条 warn（否则无法排查"为什么没提醒"）',
  );

  await deliverTurn(4);
  assert.equal(agent.steered.length, 2, '冷却窗口满后新的交付应恢复提醒（不是永久静默）');
});

test('提醒：signal 已 abort 或轮次号非法时不 steer', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-main-5', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });
  await host.fire('session/event', { id: 's-main-5' }, { type: 'turn/start' });
  await host.fire(
    'session/event',
    { id: 's-main-5' },
    { type: 'deliverables/presented', data: { turn: 1, callId: 'c', files: [] } },
  );

  const aborted = new AbortController();
  aborted.abort();
  await host.fire('agent/turn-stopping', { agent, turn: 1, signal: aborted.signal });
  assert.equal(agent.steered.length, 0, 'abort 后不得 steer');

  await host.fire('agent/turn-stopping', { agent, turn: /** @type {any} */ ('x'), signal: new AbortController().signal });
  assert.equal(agent.steered.length, 0, '非法轮次号不得 steer');
  assert.ok(host.logs.some((line) => line.includes('轮次号')), '非法轮次号必须告警');
});

test('agent/disposed 后不再注入、不再提醒', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-main-6', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });
  await host.fire('agent/disposed', { agent });

  assert.equal(host.promptFor(agent), '', '清理后该会话不应再有注入');
  await host.fire('session/event', { id: 's-main-6' }, { type: 'turn/start' });
  await host.fire(
    'session/event',
    { id: 's-main-6' },
    { type: 'deliverables/presented', data: { turn: 1, callId: 'c', files: [] } },
  );
  await host.fire('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
  assert.equal(agent.steered.length, 0, '已清理的会话不得再提醒');
});

test('监听器内部抛错不外抛：坏 agent 不会拖垮会话', async () => {
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  // 传一个畸形的 agent：所有取值都会失败，但监听器必须自己吞掉异常
  await host.fire('agent/created', { agent: /** @type {any} */ ({ id: 's-bad' }), source: 'startup' });
  await host.fire('agent/turn-stopping', { agent: /** @type {any} */ ({ id: 's-bad' }), turn: 1, signal: new AbortController().signal });
  await host.fire('agent/disposed', { agent: /** @type {any} */ ({}) });
  assert.ok(true, '能走到这里就说明异常没有外抛');
});

test('enabled=false 时不注册任何东西', () => {
  const host = makeHost();
  apply(host.ctx, resolveConfig({ enabled: false }).config);
  assert.equal(host.tools.length, 0);
  assert.equal(host.contexts.length, 0);
  assert.equal(host.has('agent/created'), false);
});

test('§14.1 无工作区时回退进程目录（不因缺 cwd 而放弃注入）', async () => {
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  // 会话没有 cwd：项目根回退到进程目录 → 只要求"不崩、且给出方法说明"，不去写进程目录
  const agent = makeAgent('s-nocwd', /** @type {any} */ (undefined));
  await host.fire('agent/created', { agent, source: 'startup' });
  const text = host.promptFor(agent);
  assert.match(text, /不是指令/, '没有工作区也要给方法说明（注入不该因缺 cwd 就消失）');
  assert.ok(
    host.logs.some((line) => line.includes('agent/created 处理失败')) === false,
    '缺 cwd 不应导致处理失败',
  );
});

test('§14.67 未知 source：无快照时兜底一次并告警；已有快照时不动', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = makeAgent('s-weird', workspace);

  await host.fire('agent/created', { agent, source: /** @type {any} */ ('mystery') });
  assert.ok(
    host.logs.some((line) => line.includes('未知的会话来源')),
    '未知来源必须告警（不能静默当成新会话）',
  );
  const afterFirst = host.promptFor(agent);
  assert.match(afterFirst, /project_memory_snapshot/, '无快照时按新会话兜底一次');

  fs.appendFileSync(
    path.join(workspace, 'memory', 'M-2026-09-20.md'),
    '- [#0031] 兜底之后新增的一条\n  - 状态：active\n',
    'utf8',
  );
  await host.fire('agent/created', { agent, source: /** @type {any} */ ('mystery') });
  assert.equal(host.promptFor(agent), afterFirst, '已有快照时不得因未知来源重建');
});

test('§14.62 子代理永不提醒：即使它有交付信号也不 steer', async () => {
  const workspace = makeWorkspace();
  const host = makeHost();
  apply(host.ctx, resolveConfig({}).config);
  const child = makeAgent('s-child-remind', workspace, { origin: 'subagent', parentSession: 's-main-x' });
  await host.fire('agent/created', { agent: child, source: 'startup' });

  await host.fire('session/event', { id: 's-child-remind' }, { type: 'turn/start' });
  await host.fire(
    'session/event',
    { id: 's-child-remind' },
    { type: 'deliverables/presented', data: { turn: 1, callId: 'c', files: [] } },
  );
  await host.fire('agent/turn-stopping', { agent: child, turn: 1, signal: new AbortController().signal });
  assert.equal(child.steered.length, 0, '子代理不得收到提醒');
});

// ─────────────────── 每会话「记忆开关」的闸门（task-1 宿主侧） ───────────────────

/**
 * 造一个**能真的记住 restrict 调用**的宿主桩（记忆开关测试专用）。
 *
 * 与 `makeHost` 的区别有两处：
 *   1. `restrict` 记录实参并返回**真实的撤销器**（撤销时把记录标记为已解除），
 *      于是"关闭 → 施加 / 开启 → 撤销"这条时序链可以在测试里被逐字验证；
 *   2. 补上 `ctx.inject(['commands'], …)` 与 `commands.register`，让 `/memory` 命令注册起来
 *      （`makeHost` 是旧宿主线形状，没有这两个东西，命令面根本不注册）。
 */
function makeToggleHost() {
  const base = makeHost();
  /** @type {Array<{ target: string, filter: any, live: boolean }>} */
  const restrictions = [];
  /** @type {any[]} */
  const commands = [];

  /**
   * @param {string} target 记录来源（会话 id）
   * @returns {{ tools: { restrict: (filter: any) => () => void } }}
   */
  const scopedToolsOf = (target) => ({
    tools: {
      restrict: (filter) => {
        const record = { target, filter, live: true };
        restrictions.push(record);
        return () => {
          record.live = false;
        };
      },
    },
  });

  // 与 `test/command-memory.test.js` 同形的 inject 桩：`inject` 是 Context 上的方法，
  // 实现体用 `this`；解引用后直接调用会丢 `this`，命令就注册不上。
  const ctx = /** @type {any} */ (base.ctx);
  ctx.commands = {
    register: (definition) => {
      commands.push(definition);
      return () => {};
    },
  };
  ctx.inject = function stubInject(deps, callback) {
    const childCtx = { ...this };
    if (!deps.includes('commands')) delete childCtx.commands;
    callback(childCtx);
    return { dispose: () => {} };
  };

  return {
    ...base,
    restrictions,
    commands,
    /** 用带记录能力的 ctx 重建一个主会话 agent。 */
    /** @param {string} id @param {string} cwd @param {Record<string, unknown>} [header] */
    makeScopedAgent(id, cwd, header = {}) {
      const agent = makeAgent(id, cwd, header);
      agent.ctx = scopedToolsOf(id);
      return agent;
    },
    /** 该会话当前活着的限制条数。 */
    /** @param {string} target */
    liveCount(target) {
      return restrictions.filter((item) => item.target === target && item.live).length;
    },
    /** 该会话历史上一共施加过几次限制。 */
    /** @param {string} target */
    totalCount(target) {
      return restrictions.filter((item) => item.target === target).length;
    },
  };
}

test('记忆开关：关闭后注入为零（空串），且不再注入任何记忆内容', async () => {
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-off', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  const before = host.promptFor(agent);
  assert.match(before, /project_memory_snapshot/, '关闭前必须有注入（回归前提）');

  // 走命令关掉：注入必须立刻变成空串（零残渣）
  const definition = host.commands[0];
  assert.ok(definition, '/memory 命令必须已注册');
  const result = await definition.handler({
    commandId: 'c-off',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'success', String(result.text));
  assert.equal(host.promptFor(agent), '', '关闭后注入必须是空串（零注入，不留标签/空白残渣）');
  assert.ok(!host.promptFor(agent).includes('project_memory_snapshot'), '关闭后不得再有快照标签');
});

test('记忆开关：关闭后 agent.ctx.tools.restrict 被以五个工具名调用（deny，不带 allow）', async () => {
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-restrict', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  assert.equal(host.restrictions.length, 0, '未关闭前不得 restrict 记忆工具（回归：默认开启）');

  await host.commands[0].handler({
    commandId: 'c-off',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });

  const mine = host.restrictions.filter((item) => item.target === 's-toggle-restrict');
  assert.equal(mine.length, 1, '关闭必须恰好施加一次 restrict');
  assert.deepEqual(mine[0].filter.deny, [...TOGGLE_TOOL_NAMES], '必须以五个记忆工具名 deny');
  assert.equal(mine[0].filter.allow, undefined, '不得出现 allow（会连带隐藏 bash/read 等）');
  assert.equal(host.liveCount('s-toggle-restrict'), 1, '关闭后闸门必须是活的');
});

test('记忆开关：会话创建时已是关闭态 → agent/created 就施加 restrict（会话级闸门）', async () => {
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);

  // 先在一个会话里关掉，再让同 id 的会话走一次边界（宿主复用 id / 命令后再次边界）
  const first = host.makeScopedAgent('s-toggle-same-id', workspace);
  await host.fire('agent/created', { agent: first, source: 'startup' });
  await host.commands[0].handler({
    commandId: 'c-off',
    agent: first,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });

  const again = host.makeScopedAgent('s-toggle-same-id', workspace);
  await host.fire('agent/created', { agent: again, source: 'startup' });
  assert.equal(host.liveCount('s-toggle-same-id'), 1, '边界重入时仍应恰好一条活闸门（不叠加）');
  assert.equal(host.promptFor(again), '', '关闭态会话重入边界后依然零注入');
});

test('记忆开关：restrict 失败必须 warn 且写明「工具仍然可见」（不得静默降级）', async () => {
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-fail', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  // 模拟真机上 restrict 抛错（例如名字未注册 / 上下文不对）
  agent.ctx.tools.restrict = () => {
    throw new Error('boom');
  };
  const result = await host.commands[0].handler({
    commandId: 'c-off-fail',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success', '工具面失败不得让用户看不到开关结果');
  assert.ok(
    host.logs.some((line) => line.startsWith('warn') && line.includes('工具仍然可见')),
    `restrict 失败必须 warn 且写明「工具仍然可见」（实际日志：${host.logs.join(' | ')}）`,
  );
  assert.equal(host.promptFor(agent), '', '注入面与工具面解耦：工具没摘掉也要停止注入');
});

test('记忆开关：agent.ctx 的服务属性访问抛错时不得逃出（真机 Proxy 陷阱，2026-10-08 冒烟抓出）', async () => {
  // 真机事实：`ctx` 是 cordis 的 Proxy，读一个该 fiber 没 inject 过的服务名会**抛错**而不是
  // 返回 undefined（`cordis/lib/index.js:676` 的 `cannot get property "..." without inject`）。
  // 早期写法 `if (scoped?.tools?.restrict === undefined)` 会把异常抛出函数体，真机上表现为
  // `/memory off` 变成 error 结果（"关不掉"）。这里用**会抛错的 getter** 复刻该形态。
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-throw', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  const realTools = agent.ctx.tools;
  Object.defineProperty(agent.ctx, 'tools', {
    configurable: true,
    get() {
      throw new Error('cannot get property "tools" without inject');
    },
  });

  const result = await host.commands[0].handler({
    commandId: 'c-off-throw',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success', '服务属性抛错时命令仍须返回成功（否则用户看不到任何反馈）');
  assert.ok(
    host.logs.some((line) => line.startsWith('warn') && line.includes('工具仍然可见')),
    `属性访问抛错必须被捕获并 warn（实际日志：${host.logs.join(' | ')}）`,
  );
  assert.equal(host.promptFor(agent), '', '注入面仍须按关闭处理（与工具面解耦）');

  Object.defineProperty(agent.ctx, 'tools', { configurable: true, writable: true, value: realTools });
});

test('记忆开关：取服务不得改用 ctx.inject 回调（回调是异步的，同步函数里拿不到）', async () => {
  // 真机事实：`ctx.inject(names, cb)` 返回 Fiber，**回调不在同步栈上执行**（实测要 await 后才跑到）。
  // 若把 disableMemoryTools 改成走 inject 回调，同步调用点拿到的 tools 恒为 undefined →
  // 闸门永远施加不上，且不报错（比抛错更隐蔽）。这里断言"施加闸门不依赖 inject 回调"：
  // 给 agent.ctx 装一个**回调永不执行**的 inject，闸门仍须生效。
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-inject', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  let injectCalled = false;
  agent.ctx.inject = () => {
    injectCalled = true;
    return Promise.resolve(); // 回调永不执行
  };

  const result = await host.commands[0].handler({
    commandId: 'c-off-inject',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'success');
  assert.equal(
    host.liveCount('s-toggle-inject'),
    1,
    '闸门必须真的施加（不得依赖 inject 回调，否则静默失效）',
  );
  assert.equal(
    injectCalled,
    false,
    '施加闸门不得走 ctx.inject（回调异步，同步函数里拿不到服务）',
  );
});

test('记忆开关：/memory on 撤销 restrict（用施加时的 disposer），注入恢复', async () => {
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-back', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  const before = host.promptFor(agent);
  const invoke = (/** @type {string} */ rawInput) =>
    host.commands[0].handler({
      commandId: `c-${rawInput}`,
      agent,
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    });

  await invoke('off');
  assert.equal(host.liveCount('s-toggle-back'), 1, '关闭后有一条活闸门');

  const back = await invoke('on');
  assert.equal(back.kind, 'success', String(back.text));
  assert.equal(host.liveCount('s-toggle-back'), 0, '开启必须调用 disposer 撤销闸门');
  assert.equal(host.promptFor(agent), before, '开启后注入恢复到关闭前的逐字文本');
  assert.equal(host.restrictions.length, 1, '撤销不得再叠加新的限制层');
});

test('记忆开关：未关闭的会话行为与改动前完全一致（回归）', async () => {
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-untouched', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  assert.equal(host.restrictions.length, 0, '没关过的会话不得被 restrict');
  assert.match(host.promptFor(agent), /project_memory_snapshot/, '没关过的会话照常注入');
  assert.ok(fs.existsSync(path.join(workspace, 'memory', 'INDEX.md')), '没关过的会话照常写 INDEX.md');
});

test('记忆开关：agent/disposed 撤销闸门，但**保留**开关状态（review P1-1 口径）', async () => {
  // 口径：用户要求"关闭后本会话就一直不生效"，而 `agent/disposed` 的触发面比"会话结束"窄得多
  // （只在 agent 自己的 fiber 被 dispose 时发出）。若在这里清状态，一旦发生"销毁后同 id 重建"
  // （恢复会话等），状态会静默回到开启、注入恢复，而客户端缓存仍显示"已关"——用户以为关着、
  // 实际在工作。所以：撤销器要清（避免死记录），状态**不清**。
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({}).config);
  const agent = host.makeScopedAgent('s-toggle-disposed', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });
  await host.commands[0].handler({
    commandId: 'c-off',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(host.liveCount('s-toggle-disposed'), 1);

  await host.fire('agent/disposed', { agent });

  assert.equal(host.liveCount('s-toggle-disposed'), 0, '销毁时必须撤销闸门（不留死记录）');

  // 同 id 重建：必须**仍是关闭态**（这是"本会话一直不生效"的直接体现）
  const revived = host.makeScopedAgent('s-toggle-disposed', workspace);
  await host.fire('agent/created', { agent: revived, source: 'startup' });
  assert.equal(host.promptFor(revived), '', '同 id 重建后仍须零注入（状态不随 agent 销毁丢失）');
  assert.equal(host.liveCount('s-toggle-disposed'), 1, '重建时必须重新施加闸门');
});

test('记忆开关：关闭后不得再收到交付提醒（review P0-1）', async () => {
  // 两个理由各自都足以致命：
  //   ① 口径要求"不注入任何记忆内容"——提醒是一条真实的 steer 用户消息，含当日记忆文件路径
  //      与"调用 memory_write / memory_log"的指令；
  //   ② 提醒点名的两个工具已被闸门摘掉，模型照着调用会撞 `unknown tool`（本仓库踩过同类 P0）。
  const workspace = makeWorkspace();
  const host = makeToggleHost();
  apply(host.ctx, resolveConfig({ completionIdleTurns: 1, reminderCooldownTurns: 1 }).config);
  const agent = host.makeScopedAgent('s-toggle-remind', workspace);
  await host.fire('agent/created', { agent, source: 'startup' });

  // 交付轮的三件套（照 test/assembly.test.js 既有提醒用例）：turn/start + tools/result + presented
  const deliverTurn = async (turn) => {
    await host.fire('session/event', { id: 's-toggle-remind' }, { type: 'turn/start' });
    await host.fire('tools/result', { name: 'present', agent, signal: new AbortController().signal }, { isError: false });
    await host.fire('session/event', { id: 's-toggle-remind' }, {
      type: 'deliverables/presented',
      data: { turn, callId: `c${turn}`, files: [{ path: 'x' }] },
    });
    await host.fire('agent/turn-stopping', { agent, turn, signal: new AbortController().signal });
  };

  // 对照组：未关闭的会话必须能收到提醒（证明测试本身有效，不是恒不提醒）
  await deliverTurn(2);
  assert.equal(agent.steered.length, 1, '未关闭的会话应正常收到交付提醒（对照组）');

  // 关闭记忆
  await host.commands[0].handler({
    commandId: 'c-off',
    agent,
    rawInput: 'off',
    attachments: [],
    signal: new AbortController().signal,
  });

  // 关闭后：即使再有完整交付信号，也不得 steer 任何提醒
  await deliverTurn(4);
  assert.equal(agent.steered.length, 1, '关闭记忆后不得再收到交付提醒（否则既违反零注入、又会导致 unknown tool）');

  // 重新开启后应恢复提醒（证明是"开关"而不是"永久静音"）
  await host.commands[0].handler({
    commandId: 'c-on',
    agent,
    rawInput: 'on',
    attachments: [],
    signal: new AbortController().signal,
  });
  await deliverTurn(6);
  assert.equal(agent.steered.length, 2, '重新开启后必须恢复提醒');
});
