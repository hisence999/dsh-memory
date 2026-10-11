/**
 * 客户端半边的**加载器契约测试**（不需要浏览器）。
 *
 * 守卫的是最容易漂移、且真机才暴露的三件事：
 *   1. 文件必须以 `window.__ModuleLoader__.load({ id, factory })` 形式注册，且 id = 包名；
 *   2. `factory(require)` 必须返回 Cordis 插件对象 `{ name, inject, apply }`；
 *   3. `apply(ctx)` 必须注册**两处** UI 贡献：
 *        - 「记忆」视图进 `conversation.view`，id='memory'、order=20；
 *        - 「记忆开关」chip 进 `conversation.input.left`，id='memory-toggle'、order=30
 *          （空白会话也渲染，是新建对话页唯一的记忆入口）；
 *      且注入面覆盖 slots / remote / remote.workspaceFiles / sessions。
 *
 * 开关口径（用户 2026-10-11 定稿）：**默认即"开" + 只有点击才触发**。
 *   - 悬停 / 聚焦 / 挂载都**不发任何命令**（早先版本在 hover 上探 `/memory status`，
 *     会在对话流留下可见节点）；
 *   - 状态靠"宿主默认值（缺席 = 开）+ `command/executed` 订阅"确定，零额外命令；
 *   - 因此 inject 面**不再需要** `remote.commands`（回读通路已整层移除）。
 *
 * 纯函数区的行为由 `test/panel-model.test.js` 覆盖（并与 `src/parse.js` 交叉验证），此处不重复。
 *
 * 注意（与 panel-model.test.js 同一个坑）：vm 沙箱里造出来的对象属于**另一个 realm**，
 * 跨 realm 的 `assert.deepStrictEqual` 会因原型不同而误判，所以比较前先 `Array.from` 搬回宿主 realm。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const CLIENT_PATH = new URL('../client/memory-panel.js', import.meta.url);
const SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');

/**
 * 在 vm 里按「浏览器 classic script」加载客户端半边。
 * @param {{ window?: boolean }} [options] window=false 时模拟 Node（无 window）
 * @returns {any} `{ registration, exports }`；沙箱取值一律按 any 处理
 */
function load(options = {}) {
  /** @type {any} */
  const sandbox = { module: { exports: {} } };
  if (options.window !== false) {
    sandbox.window = {
      __ModuleLoader__: {
        /** @param {any} registration */
        load(registration) {
          sandbox.__captured = registration;
        },
      },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/memory-panel.js' });
  return { registration: sandbox.__captured ?? null, exports: sandbox.module.exports };
}

/** 极简 React 桩：apply 阶段只需要构造闭包，组件本身不在此测试里渲染。 */
function fakeReact() {
  /** @param {any} initial */
  const useState = (initial) => [initial, () => {}];
  /** @param {any[]} args */
  const createElement = (...args) => ({ args });
  const useEffect = () => {};
  return { createElement, useState, useEffect };
}

/**
 * 能真的跑状态的迷你 React（只够跑本插件的组件）。
 *
 * 为什么需要它：开关 chip 的关键行为是「点击 → 发命令 → 本地状态跟随 → 文案/图标变」，
 * 用 `fakeReact()` 那种 setter 是空函数的桩根本测不到。这里实现最小可用的
 * useState/useEffect：setState 触发重渲染，effect 按依赖数组变化重跑并先执行上一轮清理。
 *
 * 与真实 React 的两处刻意对齐：
 *   - `Object.is` 相同值不触发重渲染（否则组件挂载时 `setOn(null)` 会自激成死循环）；
 *   - effect 的清理函数在依赖变化或卸载时执行（这里在重跑前执行）。
 *
 * @returns {{ React: any, render: (component: any, props: any) => any, flush: () => Promise<void>, renders: () => number }}
 */
function liveReact() {
  /** @type {any[]} state 槽的当前值（按 useState 调用顺序） */
  let stateCells = [];
  /** @type {any[]} ref 槽（useRef 的 .current 容器，跨渲染保持同一对象） */
  let refCells = [];
  /** @type {any[]} effect 槽的上次依赖（按 useEffect 调用顺序） */
  let effectDeps = [];
  /** @type {Array<Function|null>} effect 槽当前的清理函数 */
  let effectCleanups = [];
  /** @type {number} 渲染内的 hook 调用游标 */
  let cursor = 0;
  /** @type {number} 渲染内的 ref 游标 */
  let refCursor = 0;
  /** @type {number} 渲染内的 effect 游标 */
  let effectCursor = 0;
  /** @type {boolean} 有 setState 落地 → 需要再渲染一轮 */
  let dirty = false;
  /** @type {Array<() => any>} 本轮需要执行的 effect */
  let pendingEffects = [];
  let renderCount = 0;

  const React = {
    /** @param {any} type @param {any} props @param {...any} children */
    createElement(type, props, ...children) {
      return { type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity) };
    },
    /** @param {any} initial */
    useState(initial) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in stateCells)) stateCells[slot] = initial;
      const set = (/** @type {any} */ next) => {
        const value = typeof next === 'function' ? next(stateCells[slot]) : next;
        if (Object.is(value, stateCells[slot])) return;
        stateCells[slot] = value;
        dirty = true;
      };
      return [stateCells[slot], set];
    },
    /** @param {any} initial @returns {{current: any}} */
    useRef(initial) {
      const slot = refCursor;
      refCursor += 1;
      if (!(slot in refCells)) refCells[slot] = { current: initial };
      return refCells[slot];
    },
    /** @param {() => any} fn @param {any[]} [next] */
    useEffect(fn, next) {
      const slot = effectCursor;
      effectCursor += 1;
      const prev = effectDeps[slot];
      const changed =
        prev === undefined ||
        next === undefined ||
        next.length !== prev.length ||
        next.some((/** @type {any} */ value, /** @type {number} */ index) => !Object.is(value, prev[index]));
      if (changed) {
        effectDeps[slot] = next === undefined ? undefined : Array.from(next);
        pendingEffects.push(() => {
          const cleanup = effectCleanups[slot];
          if (typeof cleanup === 'function') cleanup();
          const result = fn();
          effectCleanups[slot] = typeof result === 'function' ? result : null;
        });
      }
    },
  };

  /** 渲染一轮（含 hook 游标复位与 effect 执行）。 */
  const renderOnce = (/** @type {any} */ component, /** @type {any} */ props) => {
    cursor = 0;
    refCursor = 0;
    effectCursor = 0;
    pendingEffects = [];
    renderCount += 1;
    const tree = component(props);
    for (const run of pendingEffects) run();
    return tree;
  };

  return {
    React,
    /**
     * 渲染到状态稳定，返回最后一次的树。
     * @param {any} component @param {any} props
     */
    render(component, props) {
      let tree = renderOnce(component, props);
      let guard = 0;
      while (dirty) {
        dirty = false;
        tree = renderOnce(component, props);
        guard += 1;
        if (guard > 20) throw new Error('渲染未收敛（疑似 setState 死循环）');
      }
      return tree;
    },
    /** 让已排队的 Promise 链全部落地。 */
    async flush() {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    /**
     * 模拟"组件被卸载后重新挂载"：丢掉所有 state 与 effect 记忆（真实 React 卸载时就是这样），
     * 但**不**动插件闭包（statusCache 等仍活着）。这是唯一能测出"重挂载退回未知态"的方式。
     */
    unmount() {
      stateCells = [];
      refCells = [];
      effectDeps = [];
      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') cleanup();
      }
      effectCleanups = [];
      cursor = 0;
      refCursor = 0;
      effectCursor = 0;
      pendingEffects = [];
      dirty = false;
    },
    /** 已发生的渲染轮数（断言"状态跟随"确实重渲染过）。 */
    renders() {
      return renderCount;
    },
  };
}

/** 在树里按 className 找第一个元素（只认 className，够用且不依赖 DOM）。 */
function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className);
      if (hit !== null) return hit;
    }
    return null;
  }
  const props = node.props ?? {};
  if (typeof props.className === 'string' && props.className.split(/\s+/).includes(className)) return node;
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className);
    if (hit !== null) return hit;
  }
  return null;
}

/** 把一棵元素树里的文本拼起来（tooltip / 按钮文案断言用）。 */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * 假的客户端 Cordis 上下文。
 * @typedef {object} FakeCtx
 * @property {any} remote
 * @property {any} sessions
 * @property {{ inject: (key: string, callback: () => any) => any, register: (options: any, component: any) => any }} slots
 * @property {(callback: () => any, label: string) => any} effect
 */

/** 调用记录。 */
function makeCalls() {
  return {
    /** @type {string[]} */
    effect: [],
    /** @type {string[]} */
    inject: [],
    /** @type {Array<{options: any, component: any}>} */
    register: [],
  };
}

test('加载器注册项：id 必须是包名 dsh-memory，且 factory 是函数', () => {
  const { registration } = load();
  assert.ok(registration !== null, '应当调用 window.__ModuleLoader__.load');
  assert.equal(registration.id, 'dsh-memory', '加载器的 id 必须是包名，否则宿主模块表对不上');
  assert.equal(typeof registration.factory, 'function', 'factory 必须是函数');
  assert.equal(registration.chunk, undefined, '本包没有分包，不应声明 chunk');
});

test('factory 返回的插件对象形状正确', () => {
  const { registration } = load();
  const requireStub = /** @type {(spec: string) => any} */ ((spec) => {
    assert.equal(spec, 'react', '客户端半边只允许 require 平台种子模块 react');
    return fakeReact();
  });
  const plugin = registration.factory(requireStub);
  assert.equal(typeof plugin, 'object', 'factory 必须返回插件对象');
  assert.equal(plugin.name, 'dsh-memory-panel');
  assert.equal(typeof plugin.apply, 'function');
  // vm 沙箱里的数组属于另一个 realm，直接 deepEqual 会因原型不同而失败，故先拷回本 realm
  assert.deepEqual(
    Array.from(plugin.inject),
    ['slots', 'remote', 'remote.workspaceFiles', 'sessions'],
    '注入面必须与实现一致：槽位注册 + 工作区文件远端 + 会话命令（开关已不再回读 status，故不需要 remote.commands）',
  );
});

test('apply 注册两处 UI：conversation.view（记忆视图）+ conversation.input.left（记忆开关）', () => {
  const { registration } = load();
  const plugin = registration.factory(() => fakeReact());

  const calls = makeCalls();
  /** @type {FakeCtx} */
  const ctx = {
    remote: { workspaceFiles: {}, commands: { execute: async () => ({ ok: true, value: undefined }) } },
    sessions: {},
    slots: {
      inject(key, callback) {
        calls.inject.push(key);
        return callback();
      },
      register(options, component) {
        calls.register.push({ options, component });
        return () => {};
      },
    },
    effect(callback, label) {
      calls.effect.push(label);
      return callback();
    },
  };

  plugin.apply(ctx);

  assert.deepEqual(
    calls.inject,
    ['conversation.view', 'conversation.input.left'],
    '必须注入两个槽：视图标签条 + 输入区开关',
  );
  assert.equal(calls.register.length, 2, '应当注册两条 UI（视图 + 开关）');
  assert.equal(calls.effect.length, 1, '注册必须挂在 ctx.effect 下，随插件卸载自动撤销');

  // ── 第一条：记忆视图 ──
  const view = calls.register[0];
  assert.equal(view.options.name, 'conversation.view');
  assert.equal(view.options.id, 'memory');
  assert.equal(view.options.order, 20, 'order=20 让它排在 chat(0) 与 trajectory(10) 之后，紧邻轨迹');
  assert.equal(typeof view.options.label, 'function');
  assert.equal(view.options.label(), '记忆');
  assert.equal(typeof view.component, 'function', '第二个参数必须是视图组件');

  // ── 第二条：输入区记忆开关 ──
  const toggle = calls.register[1];
  assert.equal(
    toggle.options.name,
    'conversation.input.left',
    '开关必须落在 conversation.input.left（list 槽，空白会话也渲染）',
  );
  assert.equal(toggle.options.id, 'memory-toggle', 'id 必须是 memory-toggle，不占用随附控件的 id');
  assert.equal(typeof toggle.options.order, 'number', 'order 必须是数字（list 槽按它升序排位）');
  assert.equal(typeof toggle.options.label, 'function');
  assert.equal(toggle.options.label(), '记忆开关');
  assert.equal(typeof toggle.component, 'function', '第二个参数必须是开关组件');
});

test('apply 的 effect 返回卸载函数，两个槽位都被撤销', () => {
  const { registration } = load();
  const plugin = registration.factory(() => fakeReact());

  /** @type {string[]} 被撤销的槽 */
  const disposed = [];
  /** @type {string[]} 被撤销的样式 */
  const styleRemoved = [];
  /** @type {any} */
  let teardown = null;

  /** @type {FakeCtx} */
  const ctx = {
    remote: { workspaceFiles: {}, commands: {} },
    sessions: {},
    slots: {
      inject(key, callback) {
        return callback();
      },
      register(options) {
        return () => disposed.push(options.name);
      },
    },
    effect(callback) {
      teardown = callback();
      return teardown;
    },
  };

  plugin.apply(ctx);
  assert.equal(typeof teardown, 'function', 'ctx.effect 的回调必须返回卸载函数');
  assert.deepEqual(disposed, [], '未卸载前不应撤销任何槽');

  teardown();
  assert.deepEqual(
    disposed.sort(),
    ['conversation.input.left', 'conversation.view'],
    '卸载时必须把两个槽位注册都撤销（否则插件禁用后开关还挂在输入区）',
  );
  assert.deepEqual(styleRemoved, [], '无 document 时不应尝试注入样式');
});

/**
 * 造一个可记录的 ctx：`session.command` 记进 `executed`。
 *
 * 开关口径（用户 2026-10-11 定稿）：**默认即开 + 只有点击才触发**，所以这里
 * **不再提供** `remote.commands` 的回读桩——那正是被移除的通路。若实现里还残留
 * `/memory status` 回读，用例会因为"命令条数不为 0"直接变红（这是刻意的守卫）。
 */
function makeToggleCtx(options = {}) {
  /** @type {Array<{via: string, sessionId: string, line: string}>} */
  const executed = [];
  /** @type {Array<{target: string, options: any}>} */
  const uses = [];
  /** @type {Array<{options: any, component: any}>} */
  const calls = [];
  /** @type {Array<(sessionId: string, commandName: string, result: any) => void>} */
  const commandExecutedListeners = [];
  /** 每次订阅被撤销时 +1（测 useEffect 清理：订阅泄漏 = 这个数不涨） */
  let unsubscribeCount = 0;
  /** @type {string} 宿主侧开关状态（模拟宿主开关表） */
  let hostOn = options.hostOn === undefined ? true : options.hostOn;
  /** 写命令是否被宿主识别（旧宿主 = false） */
  const matched = options.matched === undefined ? true : options.matched;
  /** 手动闸门：非 null 时写命令会等它 resolve（测 busy 时序） */
  const gate = options.gate === undefined ? null : options.gate;
  /** true 时写命令直接 reject（测失败路径必须清 busy） */
  const failWrite = options.failWrite === true;

  const ctx = {
    remote: { workspaceFiles: {} },
    sessions: {
      async using(target, opts, operation) {
        uses.push({ target, options: opts });
        return await operation({
          binding: {
            session: {
              getSnapshot: () => ({ openState: options.closed ? 'error' : 'open', openError: options.closed ? { message: 'boom' } : null }),
              async command(line) {
                executed.push({ via: 'session', sessionId: target, line });
                if (gate !== null) await gate;
                if (failWrite) throw new Error('write failed');
                if (line === '/memory off') hostOn = false;
                if (line === '/memory on') hostOn = true;
                return { ok: true, value: { matched: matched } };
              },
            },
          },
        });
      },
    },
    slots: {
      inject(key, callback) {
        return callback();
      },
      register(opts, component) {
        calls.push({ options: opts, component });
        return () => {};
      },
    },
    effect(callback) {
      return callback();
    },
    /** 事件订阅：本插件用 ctx.on('command/executed', listener) */
    on(event, listener) {
      if (event === 'command/executed') commandExecutedListeners.push(listener);
      return () => {
        unsubscribeCount += 1;
        // 同时把 listener 从"活跃表"里摘掉：换会话时必须重新订阅，
        // 否则旧会话的 listener 会继续挂在事件上（订阅泄漏）。
        const index = commandExecutedListeners.indexOf(listener);
        if (index !== -1) commandExecutedListeners.splice(index, 1);
      };
    },
  };

  return {
    ctx,
    calls,
    executed,
    uses,
    commandExecutedListeners,
    unsubscribeCount: () => unsubscribeCount,
    lines: () => executed.map((entry) => entry.line),
    statusCount: () => executed.filter((entry) => entry.line === '/memory status').length,
    hostOn: () => hostOn,
    /** 取开关组件 */
    component() {
      return calls.find((entry) => entry.options.id === 'memory-toggle').component;
    },
  };
}

test('记忆开关：默认即「开启」——挂载与多轮重渲染都不发任何命令', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();
  assert.ok(component !== undefined, '必须注册 memory-toggle');

  // 用户 2026-10-11 定稿：「默认就是开启状态」。
  // 宿主口径是"缺席 = 开"（src/memory-toggle.js 的 createToggleState），所以首屏按"开"渲染
  // 显示的就是**真值**，不需要先探一次；而每次探都是一条真实命令 + 一个对话流可见节点。
  let tree = env.render(component, { sessionId: 'session-1' });
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });
  env.render(component, { sessionId: 'session-1' });

  assert.deepEqual(harness.executed, [], '挂载与重渲染都不得产生任何命令');

  const chip = findByClass(tree, 'dshmem-tg');
  assert.ok(chip !== null, '必须渲染开关 chip');
  assert.equal(chip.props['aria-pressed'], true, '默认必须渲染成"开"（与宿主默认值一致）');
  assert.equal(textOf(chip), '记忆', '开启时文案是「记忆」');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, '开启态不画斜杠');
  // 未知态已随口径整层移除：既不该有 data-unknown，也不该有中性外观
  assert.equal(chip.props['data-unknown'], undefined, '默认即开，不得再有"未知态"标记');
  assert.ok(
    textOf(findByClass(tree, 'dshmem-tg-tip')).includes('点击关闭'),
    'tooltip 必须说明点击会关闭（这才是本开关的唯一触发方式）',
  );
});

test('记忆开关：悬停 / 键盘聚焦**不发任何命令**（用户定稿：只有点击才触发）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  const chip = findByClass(tree, 'dshmem-tg');
  // ⚠️ 这两条是本用例的核心：早先实现把 probe 挂在 onMouseEnter / onFocus 上，
  // 于是"鼠标划过就执行一次 /memory status"，在对话流里留下可见节点（宿主会写
  // command/run + command/done 两条会话事件）。现在这两个 handler 必须**不存在**。
  assert.equal(chip.props.onMouseEnter, undefined, '不得再挂 onMouseEnter（划过不该发命令）');
  assert.equal(chip.props.onFocus, undefined, '不得再挂 onFocus（聚焦不该发命令）');

  // 就算宿主把这两个事件真的派发下来（防御性：别的地方可能手工调用），也不该有任何命令。
  // 这里直接调 onClick 之外的路径无 handler 可调，所以改为断言"整轮渲染后零命令"。
  assert.deepEqual(harness.executed, [], '渲染与交互准备阶段不得有任何命令');
  assert.equal(harness.statusCount(), 0, '不得存在任何 /memory status 回读');
});

test('记忆开关：点击发 /memory off 与 /memory on，且本地状态跟随', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 'session-1' });
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });

  // ── 点一下：发 /memory off ──
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });

  const offCalls = harness.executed.filter((entry) => entry.line === '/memory off');
  assert.equal(offCalls.length, 1, '点击必须发一次 /memory off');
  assert.equal(offCalls[0].sessionId, 'session-1', '命令必须发给当前会话');
  assert.equal(offCalls[0].via, 'session', '写命令必须走 sessions.using → session.command 通路');
  assert.equal(harness.hostOn(), false, '宿主状态应当真的被改到（模拟）');
  assert.equal(harness.uses[0].options.source, 'memoryPanel', '必须沿用面板同款 source');

  const chipOff = findByClass(tree, 'dshmem-tg');
  assert.equal(chipOff.props['aria-pressed'], false, '切换后 chip 应变成未按下');
  assert.equal(textOf(chipOff), '记忆已关', '关闭时文案变「记忆已关」');
  assert.ok(findByClass(tree, 'dshmem-tg-bar') !== null, '关闭时图标上必须叠 45° 斜杠');
  assert.ok(
    textOf(findByClass(tree, 'dshmem-tg-tip')).includes('不注入记忆快照'),
    'tooltip 必须说明关闭后不注入记忆',
  );
  assert.ok(
    textOf(findByClass(tree, 'dshmem-tg-tip')).includes('memory_*'),
    'tooltip 必须说明五个 memory_* 工具不可见',
  );

  // ── 再点一下：发 /memory on 并回到开启 ──
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });

  assert.equal(harness.executed.filter((entry) => entry.line === '/memory on').length, 1, '再点必须发一次 /memory on');
  assert.equal(harness.hostOn(), true, '宿主状态应当恢复');
  const chipBack = findByClass(tree, 'dshmem-tg');
  assert.equal(chipBack.props['aria-pressed'], true, '恢复后 chip 回到按下态');
  assert.equal(textOf(chipBack), '记忆', '恢复后文案回到「记忆」');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, '恢复后斜杠必须消失');

  // ── 命令纪律：整个流程只有用户点出来的两条命令，没有任何回读 ──
  assert.deepEqual(
    harness.lines(),
    ['/memory off', '/memory on'],
    '命令序列必须恰好是「关 → 开」，不得多出任何 status 回读',
  );
  assert.equal(harness.statusCount(), 0, '不得有任何 /memory status');
});

test('记忆开关：busy 期间重复点击只发一次命令', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  // 第一次点击 → 进入 busy；中间渲染一轮（真实 React 会在两次点击之间重渲染）
  findByClass(tree, 'dshmem-tg').props.onClick();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props.disabled, true, 'busy 期间按钮必须 disabled');

  // busy 中再点两次：必须被守卫挡掉
  findByClass(tree, 'dshmem-tg').props.onClick();
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  assert.deepEqual(harness.lines(), ['/memory off'], 'busy 期间的重复点击不得重复发命令');
  assert.equal(
    harness.executed.filter((entry) => entry.line === '/memory off').length,
    1,
    '只允许一条 /memory off',
  );
  assert.equal(findByClass(tree, 'dshmem-tg').props.disabled, false, '落地后必须解除 disabled');
});

test('记忆开关：订阅 command/executed——用户手打 /memory off 时芯片要跟着变（用宿主真实文案）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  // 订阅装在 useEffect 里，所以必须渲染过一轮才会登记（这正是"渲染前不该有副作用"的正确行为）
  assert.equal(harness.commandExecutedListeners.length, 1, '渲染后必须订阅一次 command/executed');

  const emit = harness.commandExecutedListeners[0];
  // ⚠️ 这里刻意用**宿主真正产出的文案**（`toggleResultText`），而不是手写的理想字符串。
  // 早先的用例喂的是伪造的 `'状态：记忆已关闭'`，于是掩盖了一个真缺陷：
  // `/memory off` 的结果文案当时**不带**状态标记，订阅永远解析失败，
  // 用户手打关闭后芯片会一直显示"开启"（review P0-2 那类"骗用户"）。
  const host = await import('../src/memory-toggle.js');
  const offText = host.toggleResultText(false, true);
  const onText = host.toggleResultText(true, true);

  // 别的会话：不得影响本会话芯片
  emit('other-session', 'memory', { kind: 'success', text: offText });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '别的会话的事件不得改本会话');

  // 别的命令名：不得影响
  emit('s', 'export', { kind: 'success', text: offText });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '非 memory 命令不得改芯片');

  // 失败结果：不得改
  emit('s', 'memory', { kind: 'error', text: offText });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, 'kind!==success 不得改芯片');

  // 正例：用户手打 /memory off → 芯片变「记忆已关」
  emit('s', 'memory', { kind: 'success', text: offText });
  tree = env.render(component, { sessionId: 's' });
  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['aria-pressed'], false, '收到 success 事件后必须变"关"（宿主文案必须带状态标记）');
  assert.equal(textOf(chip), '记忆已关', '收到 success 事件后文案必须变「记忆已关」');
  assert.ok(findByClass(tree, 'dshmem-tg-bar') !== null, '收到 success 事件后必须画出斜杠');

  // 反向：再开回来
  emit('s', 'memory', { kind: 'success', text: onText });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆', '收到"已开启"事件后必须变回「记忆」');

  // 事件驱动的更新不得产生任何命令
  assert.equal(harness.statusCount(), 0, '事件订阅不得额外发 status');
  assert.deepEqual(harness.executed, [], '整条订阅路径都不该产生命令');
});

test('记忆开关：换会话时状态必须跟随（不得沿用上一个会话的显示）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // s1：点一下关掉
  let tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '前置条件：s1 已关');

  // 换到 s2：宿主口径"缺席 = 开"，所以必须显示「记忆」（默认开），不得沿用 s1 的「记忆已关」。
  // 宿主渲染槽位条目**不给 key**，换会话不会重挂载组件，所以这里量的是 shownRef 的跟随逻辑。
  tree = env.render(component, { sessionId: 's2' });
  await env.flush();
  tree = env.render(component, { sessionId: 's2' });
  const chipS2 = findByClass(tree, 'dshmem-tg');
  assert.equal(textOf(chipS2), '记忆', '换到没关过的会话必须显示默认「记忆」');
  assert.equal(chipS2.props['aria-pressed'], true, 's2 必须渲染成"开"');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, 's2 不得画出 s1 的"已关"斜杠');

  // 换回 s1：必须用缓存立刻显示"关"，且不产生任何命令
  tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '换回已关过的会话必须立刻显示「记忆已关」');
  assert.deepEqual(harness.lines(), ['/memory off'], '换会话不得产生任何额外命令');
});

test('记忆开关：重挂载后不得把已关闭的会话显示成开启（缓存必须带结果）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // 点一下关掉
  let tree = env.render(component, { sessionId: 'off-session' });
  await env.flush();
  tree = env.render(component, { sessionId: 'off-session' });
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 'off-session' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '前置条件：已关');

  // 真正模拟"卸载后重新挂载"：丢掉组件状态，插件闭包（含状态缓存）仍活着
  env.unmount();
  tree = env.render(component, { sessionId: 'off-session' });
  await env.flush();
  tree = env.render(component, { sessionId: 'off-session' });

  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['aria-pressed'], false, '重挂载后必须仍是"关"：退回默认"开"就是在骗用户');
  assert.equal(textOf(chip), '记忆已关', '重挂载后文案必须仍是「记忆已关」');
  assert.ok(findByClass(tree, 'dshmem-tg-bar') !== null, '重挂载后斜杠必须仍在');
  assert.deepEqual(harness.lines(), ['/memory off'], '重挂载不得产生任何命令');
});

test('记忆开关：旧宿主不认 /memory（matched=false）时不得假装切成功', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true, matched: false });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '前置条件：默认开');

  // 点击：命令发出但宿主不认 → UI 必须保持"开"，不得翻成"已关"
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['aria-pressed'], true, 'matched=false 时绝不能把 UI 改成已关闭——保持原状');
  assert.equal(textOf(chip), '记忆', 'matched=false 时文案不得变成「记忆已关」');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, 'matched=false 时不得画出"已关"的斜杠');
});

test('记忆开关：本地显示与宿主不一致时，点击是自愈的（幂等 noop + 事件纠正）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  // 宿主侧其实已经关掉了（例如上一份文档里关过、页面刷新后客户端缓存丢失），
  // 但芯片按默认值显示"开"——这是"默认即开"口径下唯一的状态不一致窗口。
  const harness = makeToggleCtx({ hostOn: false });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆', '前置条件：本地按默认值显示"开"');

  // 用户点一下（意图是关）：下发 /memory off —— 在宿主侧是幂等 noop，
  // 其返回文案带 `状态：记忆已关闭` 标记，订阅随即把芯片纠正过来。
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  assert.deepEqual(harness.lines(), ['/memory off'], '点击只应发一条 /memory off（不做"先探再取反"）');
  assert.equal(harness.hostOn(), false, '宿主状态保持关闭（noop 不得把它打开）');

  // 模拟宿主把 noop 结果回执给客户端
  const host = await import('../src/memory-toggle.js');
  harness.commandExecutedListeners[0]('s', 'memory', { kind: 'success', text: host.toggleResultText(false, false) });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '宿主回执必须把芯片纠正成「记忆已关」');
});

test('记忆开关：会话未打开时点击不发命令且不崩', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);

  /** @type {string[]} */
  const commands = [];
  /** @type {any} */
  const ctx = {
    remote: { workspaceFiles: {} },
    sessions: {
      async using(target, options, operation) {
        return await operation({
          binding: {
            session: {
              getSnapshot: () => ({ openState: 'error', openError: { message: 'boom' } }),
              async command(line) {
                commands.push(line);
                return { ok: true, value: { matched: true } };
              },
            },
          },
        });
      },
    },
    slots: {
      inject(key, callback) {
        return callback();
      },
      register(options, component) {
        calls.push({ options, component });
        return () => {};
      },
    },
    effect(callback) {
      return callback();
    },
  };

  /** @type {Array<{options: any, component: any}>} */
  const calls = [];
  plugin.apply(ctx);
  const component = calls.find((entry) => entry.options.id === 'memory-toggle').component;

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  assert.deepEqual(commands, [], '会话未打开时不得发命令');
  assert.ok(findByClass(tree, 'dshmem-tg') !== null, '失败后组件必须仍然渲染（不得把输入区炸掉）');
});

test('记忆开关：写命令 reject 时必须清 busy（否则按钮永久 disabled）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true, failWrite: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  // 旧实现曾有一个"busy 永久卡死"的真缺陷（早退路径漏了 setBusy(false)），
  // 后果是芯片在**所有**会话上永久 disabled = 用户看到"按钮坏了"。这条守住失败路径。
  assert.equal(
    findByClass(tree, 'dshmem-tg').props.disabled,
    false,
    '写命令失败后必须解除 busy，否则按钮永久点不动',
  );
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆', '失败后不得假装切成功（保持原显示）');
});

test('记忆开关：切会话途中旧会话的迟到结果不得改新会话显示', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  /** @type {() => void} */
  let releaseWrite = () => {};
  const writeGate = new Promise((resolve) => {
    releaseWrite = () => resolve();
  });
  const harness = makeToggleCtx({ hostOn: true, gate: writeGate });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // s1 上点击 → 写命令发出但被闸门挡住（还在途中）
  let tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  findByClass(tree, 'dshmem-tg').props.onClick();
  assert.deepEqual(harness.lines(), ['/memory off'], '点击应立即发出 /memory off');

  // 切到 s2（s2 从未被关过 → 应显示默认「记忆」）
  tree = env.render(component, { sessionId: 's2' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆', '前置条件：s2 显示默认开');

  // 现在让 s1 的写命令落地
  releaseWrite();
  await env.flush();
  tree = env.render(component, { sessionId: 's2' });

  // s1 的迟到结果绝不能写到 s2 的显示上（否则 s2 会显示成 s1 的状态 = 骗用户）
  assert.equal(
    textOf(findByClass(tree, 'dshmem-tg')),
    '记忆',
    's1 的迟到结果不得把 s2 显示成「记忆已关」',
  );
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, 's2 不得画出 s1 的"已关"斜杠');

  // 但结果应当已写进 s1 的缓存：切回 s1 立刻显示"关"
  tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '切回 s1 应立刻显示缓存的"关"');
});

test('记忆开关：换会话时旧订阅必须撤销并重新订阅（不得泄漏）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  assert.equal(harness.commandExecutedListeners.length, 1, 's1 渲染后应恰好有一个活跃订阅');
  assert.equal(harness.unsubscribeCount(), 0, '未换会话前不该撤销订阅');

  // 换到 s2：useEffect 依赖 [sessionId] → 必须先撤销旧订阅再订阅新的
  tree = env.render(component, { sessionId: 's2' });
  await env.flush();
  assert.equal(harness.unsubscribeCount(), 1, '换会话必须撤销旧订阅（否则订阅泄漏、旧会话事件仍会改显示）');
  assert.equal(harness.commandExecutedListeners.length, 1, '换会话后必须恰好仍有一个活跃订阅（不能多也不能少）');

  // 新订阅必须绑定 s2：给 s2 发事件才生效
  harness.commandExecutedListeners[0]('s2', 'memory', { kind: 'success', text: '状态：记忆已关闭' });
  tree = env.render(component, { sessionId: 's2' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '换会话后的订阅必须绑定新会话');

  // 卸载时必须撤销订阅（组件卸载不留下挂在宿主事件上的 listener）
  env.unmount();
  assert.equal(harness.unsubscribeCount(), 2, '卸载时必须撤销订阅');
});

test('回归守卫：开关不得再挂悬停探针，也不得再有 /memory status 回读', () => {
  // 这两样都是"鼠标划过就产生副作用"的来源（悬停即执行真命令、在对话流留可见节点）。
  // 用源码级断言钉住，防止将来有人为了"显示更准"把它们加回来。
  //
  // 只钉"探针挂载"与"回读通路"这两种**可执行形态**，不钉注释里对历史的说明
  // （注释里出现 `/memory status` 是在解释为什么不做，那是应该保留的信息）。
  assert.ok(!/onMouseEnter:\s*probe/.test(SOURCE), '不得再把 probe 挂到 onMouseEnter 上');
  assert.ok(!/onFocus:\s*probe/.test(SOURCE), '不得再把 probe 挂到 onFocus 上');
  assert.ok(!/function probe\s*\(/.test(SOURCE), 'probe 函数本身应当已整层移除');
  assert.ok(!/readCommandText/.test(SOURCE), '回读辅助函数应当已整层移除');
  assert.ok(
    !/commands\.execute\(/.test(SOURCE),
    '开关不得再调 remote.commands.execute：那会执行真命令并在对话流留下可见节点',
  );
});

test('parseToggleStatus：只认宿主契约的两个标记，认不出返回 null', () => {
  const { exports } = load({ window: false });
  const { parseToggleStatus } = exports;
  assert.equal(typeof parseToggleStatus, 'function', 'parseToggleStatus 必须导出，供开关初始化回归测试使用');

  assert.equal(parseToggleStatus('状态：记忆已开启'), true);
  assert.equal(parseToggleStatus('状态：记忆已关闭'), false);
  assert.equal(parseToggleStatus('前言\n状态：记忆已关闭\n用法：/memory on'), false, '多行文本里也要认出来');
  assert.equal(parseToggleStatus('状态：记忆已开启\n下一步建议：…'), true);

  // 认不出的情形必须返回 null（UI 落到"未知"），绝不能默认成 true
  assert.equal(parseToggleStatus(''), null);
  assert.equal(parseToggleStatus('/memory 用法说明'), null);
  assert.equal(parseToggleStatus(/** @type {any} */ (undefined)), null);
  assert.equal(parseToggleStatus(/** @type {any} */ (null)), null);
  assert.equal(parseToggleStatus(/** @type {any} */ (123)), null);
});

test('parseToggleStatus：两个标记互不包含，判定顺序不影响结果', () => {
  const { exports } = load({ window: false });
  const { parseToggleStatus, TOGGLE_STATUS_ON, TOGGLE_STATUS_OFF } = exports;

  // review P2-1：早先的注释声称"`状态：记忆未开启` 会被先判开而误判"——那是错的。
  // 两个标记只差「已开启」/「已关闭」，互不为子串，所以顺序无关；这条测试把这个事实钉住。
  assert.equal(TOGGLE_STATUS_ON.indexOf(TOGGLE_STATUS_OFF), -1, '「开」标记不得包含「关」标记');
  assert.equal(TOGGLE_STATUS_OFF.indexOf(TOGGLE_STATUS_ON), -1, '「关」标记不得包含「开」标记');

  // 近形但不同的文案必须落到 null，绝不能猜成"开"
  assert.equal(parseToggleStatus('状态：记忆未开启'), null, '「未开启」不是「已开启」，必须落到未知');
  assert.equal(parseToggleStatus('状态：记忆未关闭'), null, '「未关闭」不是「已关闭」，必须落到未知');
  assert.equal(parseToggleStatus('状态：记忆已关'), null, '截断文案必须落到未知');
  assert.equal(parseToggleStatus('状态：记忆已打开'), null, '换词必须落到未知');

  // 顺序无关的直接验证：两个标记单独出现都只命中自己那一边
  assert.equal(parseToggleStatus('x' + TOGGLE_STATUS_ON + 'y'), true);
  assert.equal(parseToggleStatus('x' + TOGGLE_STATUS_OFF + 'y'), false);
  // 两个标记同时出现（异常文本）时，先判关 → 返回 false；这里只钉住"不会抛错、结果是布尔"
  assert.equal(typeof parseToggleStatus(TOGGLE_STATUS_ON + TOGGLE_STATUS_OFF), 'boolean');
});

test('跨半边契约：客户端解析器必须认得宿主真正产出的 status 文本', async () => {
  // 这是本任务唯一的跨半边耦合点：宿主写死的两个标记字符串必须被客户端解析器认出来。
  // 任何一侧改了文案而另一侧没跟上，这条测试立刻红——比真机发现早得多。
  const host = await import('../src/tools/archive.js');
  const { exports } = load({ window: false });

  assert.equal(
    exports.TOGGLE_STATUS_ON,
    host.TOGGLE_STATUS_ON_TEXT,
    '客户端硬编码的「开」标记必须与宿主导出的常量逐字一致',
  );
  assert.equal(
    exports.TOGGLE_STATUS_OFF,
    host.TOGGLE_STATUS_OFF_TEXT,
    '客户端硬编码的「关」标记必须与宿主导出的常量逐字一致',
  );

  // 用宿主真正的 status 文本跑一遍客户端解析器，确认方向不会反
  assert.equal(exports.parseToggleStatus(host.TOGGLE_STATUS_ON_TEXT), true, '宿主的「开」文本必须解析成 true');
  assert.equal(exports.parseToggleStatus(host.TOGGLE_STATUS_OFF_TEXT), false, '宿主的「关」文本必须解析成 false');
});

test('开关常量：槽位/ID/order 与已评审原型一致', () => {
  const { exports } = load({ window: false });
  assert.equal(exports.TOGGLE_SLOT, 'conversation.input.left', '落点必须是宿主加式槽 conversation.input.left');
  assert.equal(exports.TOGGLE_ID, 'memory-toggle');
  assert.equal(typeof exports.TOGGLE_ORDER, 'number');
  assert.equal(exports.TOGGLE_STATUS_ON, '状态：记忆已开启');
  assert.equal(exports.TOGGLE_STATUS_OFF, '状态：记忆已关闭');
  assert.equal(typeof exports.makeMemoryToggle, 'function');

  const tipOn = exports.toggleTooltip(true);
  assert.ok(tipOn.main.includes('已开启'), '开启态 tooltip 要说明当前是开的');
  assert.ok(tipOn.sub.includes('五个 memory_* 工具不可见'), '必须说清关闭的后果');
  const tipOff = exports.toggleTooltip(false);
  assert.ok(tipOff.main.includes('已关闭'), '关闭态 tooltip 要说明当前是关的');
  assert.ok(tipOff.main.includes('点击开启'), '关闭态要给出恢复路径');
});

test('toggleTooltip：两态文案各自诚实，且都说清关闭的后果', () => {
  const { exports } = load({ window: false });
  const tipOn = exports.toggleTooltip(true);
  const tipOff = exports.toggleTooltip(false);

  // 用户 2026-10-11 定稿"默认就是开启状态"后，未知态已从组件里整层移除，
  // 所以这里只钉两态：开态说明"当前开着 + 点击关闭"，关态说明"当前关着 + 点击开启"。
  assert.ok(tipOn.main.includes('已开启'), '开启态 tooltip 要说明当前是开的');
  assert.ok(tipOn.main.includes('点击关闭'), '开启态必须说明点击会关闭（这是唯一触发方式）');
  assert.ok(tipOff.main.includes('已关闭'), '关闭态 tooltip 要说明当前是关的');
  assert.ok(tipOff.main.includes('点击开启'), '关闭态要给出恢复路径');
  assert.notEqual(tipOn.main, tipOff.main, '两态文案必须可区分，否则用户分不清当前状态');

  // 两态都必须说清"关闭的后果"（教育性信息，与状态无关）
  for (const [label, tip] of [['开', tipOn], ['关', tipOff]]) {
    assert.ok(tip.sub.includes('不注入记忆快照'), `${label}态 tooltip 必须说明关闭后不注入记忆`);
    assert.ok(tip.sub.includes('五个 memory_* 工具不可见'), `${label}态 tooltip 必须说明五个工具不可见`);
  }
});

test('CSS 覆盖开关两态，且选择器都带 dshmem- 前缀', () => {
  const { exports } = load({ window: false });
  const css = exports.CSS;
  for (const token of [
    '.dshmem-tg {',
    '.dshmem-tg[aria-pressed=true]',
    '.dshmem-tg[aria-pressed=false]',
    '.dshmem-tg-bar',
    '.dshmem-tg-tip',
    '.dshmem-tg-wrap:hover .dshmem-tg-tip',
  ]) {
    assert.ok(css.includes(token), `样式表必须含 ${token}`);
  }
  // 未知态已随口径移除：CSS 里不该再有它的选择器（留着会让人以为还有第三态）
  assert.ok(!css.includes('[data-unknown'), '未知态样式应当已整层移除');
  // 这份 CSS 会注入宿主页面 head：任何不带前缀的选择器都可能改到宿主（含别的插件）的样式
  const selectors = css.split('\n').filter((line) => line.includes('{') && !line.trim().startsWith('--'));
  for (const line of selectors) {
    const head = line.slice(0, line.indexOf('{')).trim();
    if (head.length === 0) continue;
    for (const part of head.split(',')) {
      assert.ok(
        part.trim().startsWith('.dshmem-'),
        `选择器必须带 .dshmem- 前缀（否则会污染宿主页面）：${part.trim()}`,
      );
    }
  }
});

test('无 window 的 Node 环境下不注册加载器，但仍导出纯函数', () => {
  const { registration, exports } = load({ window: false });
  assert.equal(registration, null, '没有 __ModuleLoader__ 时不应尝试注册');
  assert.equal(typeof exports.parseMemoryFile, 'function');
  assert.equal(typeof exports.parseJournalFile, 'function');
  assert.equal(typeof exports.buildActionLine, 'function');
  assert.equal(exports.MEMORY_DIR, 'memory');
});

test('内存目录名与 cordis.patch.yml 的默认 memoryDirName 一致', () => {
  const { exports } = load({ window: false });
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const declared = /memoryDirName:\s*([A-Za-z0-9_-]+)/.exec(patch);
  assert.ok(declared !== null, 'cordis.patch.yml 应当声明 memoryDirName');
  assert.equal(
    exports.MEMORY_DIR,
    declared[1],
    '客户端硬编码的目录名必须与插件默认配置一致，否则面板会读空目录',
  );
});

test('行身份 rowKey 在"同 id / 无编号 / 跨文件同序号"下都唯一', () => {
  const { exports } = load({ window: false });
  const { rowKey } = exports;
  assert.equal(typeof rowKey, 'function', 'rowKey 必须导出，供行身份回归测试使用');

  // 这三种形状都由解析器明确支持，且都是"按 id 选中"会出错、按行身份才对的情形。
  const rows = [
    { id: '#0007', order: 2, filePath: 'memory/M-2026-09-20.md' },
    { id: '#0007', order: 3, filePath: 'memory/M-2026-09-20.md' }, // 同文件重复编号
    { id: '#0007', order: 2, filePath: 'memory/M-2026-09-21.md' }, // 跨文件同编号同序号
    { id: null, order: 0, filePath: 'memory/M-2026-09-20.md' }, // 忘了写编号
    { id: null, order: 0, filePath: 'memory/archive/M-2026-09-19.md' }, // 归档区同名文件的无编号条目
  ];
  const keys = rows.map((entry) => rowKey(entry));
  assert.equal(
    new Set(keys).size,
    rows.length,
    `行身份必须两两不同（否则列表 key 重复、选中会错行）：${JSON.stringify(keys)}`,
  );
  assert.equal(
    rowKey(rows[0]),
    rowKey({ id: '#0007', order: 2, filePath: 'memory/M-2026-09-20.md' }),
    '同一条目的行身份必须稳定（同一对象两次读取得到同一个键）',
  );
});
