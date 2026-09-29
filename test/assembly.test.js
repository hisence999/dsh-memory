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
