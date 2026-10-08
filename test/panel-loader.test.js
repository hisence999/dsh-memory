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
 *      且注入面覆盖 slots / remote / remote.workspaceFiles / remote.commands / sessions。
 *
 * 为什么 inject 里有 `remote.commands`：`session.command()` 只回 `{matched}`，命令文本被丢掉
 * （`dsh-api-session-controller/lib/client.js:1848-1855`），而开关 chip 需要 `/memory status`
 * 的**返回文本**来初始化状态，只能直连 `remote.commands.execute`（官方 ui-commands 同款）。
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
    ['slots', 'remote', 'remote.workspaceFiles', 'remote.commands', 'sessions'],
    '注入面必须与实现一致：槽位注册 + 工作区文件远端 + 命令远端（/memory status 的返回文本）+ 会话命令',
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

/** 造一个可记录的 ctx：commands.execute 与 session.command 都记进 `executed`。 */
function makeToggleCtx(options = {}) {
  /** @type {Array<{via: string, sessionId: string, line: string}>} */
  const executed = [];
  /** @type {Array<{target: string, options: any}>} */
  const uses = [];
  /** @type {Array<{options: any, component: any}>} */
  const calls = [];
  /** @type {Array<(sessionId: string, commandName: string, result: any) => void>} */
  const commandExecutedListeners = [];
  /** @type {string} 宿主侧开关状态（模拟宿主开关表） */
  let hostOn = options.hostOn === undefined ? true : options.hostOn;
  /** 状态回读的返回文本（可被测试改） */
  let statusText = options.statusText === undefined ? null : options.statusText;
  /** 写命令是否被宿主识别（旧宿主 = false） */
  const matched = options.matched === undefined ? true : options.matched;
  /** 是否提供 remote.commands.execute（旧宿主可能没有 commands 命名空间） */
  const hasCommands = options.hasCommands !== false;
  /** 手动闸门：非 null 时 status 会等它 resolve */
  const gate = options.gate === undefined ? null : options.gate;

  /** 当前应返回的状态文本（默认按 hostOn 推导，与宿主契约一致）。 */
  const currentStatusText = () =>
    statusText !== null ? statusText : '状态：记忆' + (hostOn ? '已开启' : '已关闭');

  const ctx = {
    remote: {
      workspaceFiles: {},
      commands: hasCommands
        ? {
            async execute(sessionId, line) {
              executed.push({ via: 'remote', sessionId, line });
              if (gate !== null) await gate;
              return { ok: true, value: { result: { kind: 'success', text: currentStatusText() } } };
            },
          }
        : {},
    },
    sessions: {
      async using(target, opts, operation) {
        uses.push({ target, options: opts });
        return await operation({
          binding: {
            session: {
              getSnapshot: () => ({ openState: options.closed ? 'error' : 'open', openError: options.closed ? { message: 'boom' } : null }),
              async command(line) {
                executed.push({ via: 'session', sessionId: target, line });
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
      return () => {};
    },
  };

  return {
    ctx,
    calls,
    executed,
    uses,
    commandExecutedListeners,
    lines: () => executed.map((entry) => entry.line),
    statusCount: () => executed.filter((entry) => entry.line === '/memory status').length,
    hostOn: () => hostOn,
    setStatusText: (value) => {
      statusText = value;
    },
    /** 取开关组件 */
    component() {
      return calls.find((entry) => entry.options.id === 'memory-toggle').component;
    },
  };
}

/** 触发一次 hover（懒探入口）。 */
function hover(chip) {
  chip.props.onMouseEnter();
}

test('记忆开关：点击真的发 /memory off 与 /memory on，且本地状态跟随', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();
  assert.ok(component !== undefined, '必须注册 memory-toggle');

  // ── 挂载：**不发任何命令**（review P1-2：懒探，新建对话首屏不该出现命令节点） ──
  let tree = env.render(component, { sessionId: 'session-1' });
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });
  assert.deepEqual(harness.executed, [], '挂载不得产生任何命令（含 /memory status）');

  // 未知态：不宣称任何状态
  const chipUnknown = findByClass(tree, 'dshmem-tg');
  assert.ok(chipUnknown !== null, '必须渲染开关 chip');
  assert.equal('aria-pressed' in chipUnknown.props, false, '未知态不得给 aria-pressed');
  assert.equal(chipUnknown.props['data-unknown'], 'true', '未知态必须有 data-unknown 标记');
  assert.equal(textOf(chipUnknown), '记忆', '未知态文案是「记忆」');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, '未知态不画斜杠');
  // tooltip 也必须诚实：不能一边把主体做成中性，一边在悬停里宣称"已开启"
  const tipUnknownText = textOf(findByClass(tree, 'dshmem-tg-tip'));
  assert.ok(!tipUnknownText.includes('已开启'), '未知态 tooltip 不得宣称「已开启」');
  assert.ok(tipUnknownText.includes('未知'), '未知态 tooltip 应当明说状态未知');

  // ── hover 懒探：这时才发一次 /memory status ──
  hover(chipUnknown);
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });

  assert.equal(harness.statusCount(), 1, 'hover 后应恰好发一次 /memory status');
  const chipOn = findByClass(tree, 'dshmem-tg');
  assert.equal(chipOn.props['aria-pressed'], true, '探到"开"后 chip 应为按下态');
  assert.equal(chipOn.props['data-unknown'], undefined, '已知状态不应再带 data-unknown');
  assert.equal(textOf(chipOn), '记忆', '开启时文案是「记忆」');

  // ── 点一下：应当发 /memory off，本地状态跟随 ──
  chipOn.props.onClick();
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
  assert.ok(
    findByClass(tree, 'dshmem-tg-bar') !== null,
    '关闭时图标上必须叠 45° 斜杠（原型三态之一）',
  );
  assert.ok(
    textOf(findByClass(tree, 'dshmem-tg-tip')).includes('不注入记忆快照'),
    'tooltip 必须说明关闭后不注入记忆',
  );
  assert.ok(
    textOf(findByClass(tree, 'dshmem-tg-tip')).includes('memory_*'),
    'tooltip 必须说明五个 memory_* 工具不可见',
  );

  // ── 再点一下：应当发 /memory on 并回到开启 ──
  chipOff.props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 'session-1' });

  assert.equal(harness.executed.filter((entry) => entry.line === '/memory on').length, 1, '再点必须发一次 /memory on');
  assert.equal(harness.hostOn(), true, '宿主状态应当恢复');
  const chipBack = findByClass(tree, 'dshmem-tg');
  assert.equal(chipBack.props['aria-pressed'], true, '恢复后 chip 回到按下态');
  assert.equal(textOf(chipBack), '记忆', '恢复后文案回到「记忆」');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, '恢复后斜杠必须消失');

  // ── 回读次数纪律：整个流程只允许一次 status ──
  // 每次 /memory status 都是真实命令执行，宿主会写 command/run + command/done，
  // 而 ui-chat 会把它们渲染成可见的对话流节点（只隐藏 name==='permission'）。
  assert.equal(harness.statusCount(), 1, `两次切换期间只允许 hover 时那一次回读，实际 ${harness.statusCount()} 次`);
  assert.deepEqual(
    harness.lines(),
    ['/memory status', '/memory off', '/memory on'],
    '命令序列必须恰好是「探一次 → 关 → 开」，不得多出校正探针',
  );
});

test('记忆开关：懒探——挂载不发命令、hover 才探、再次 hover 不重复探', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // 挂载 + 多轮重渲染：0 命令
  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  env.render(component, { sessionId: 's' });
  assert.equal(harness.statusCount(), 0, '挂载与重渲染都不得发 /memory status');

  // 第一次 hover：探一次
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(harness.statusCount(), 1, '第一次 hover 必须探一次');

  // 再次 hover（含 onFocus）：命中缓存，不重复探
  hover(findByClass(tree, 'dshmem-tg'));
  findByClass(tree, 'dshmem-tg').props.onFocus();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(harness.statusCount(), 1, '再次 hover / focus 必须命中缓存，不得重复探');
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true);
});

test('记忆开关：未知态点击一次完成切换（不再需要点两次）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  // 宿主侧其实是"开"的，但芯片还没探过（未知）
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['data-unknown'], 'true', '前置条件：此刻是未知态');

  // 一次点击就要完成切换：先探真值（开）→ 取反 → 发 off。
  // 旧语义"先探一次、让用户再点一次"在真机上会被当成按钮坏了（未知态很常见：缓存只在内存里）。
  chip.props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  assert.deepEqual(
    harness.lines(),
    ['/memory status', '/memory off'],
    '未知态一次点击必须探真值后紧接着下发 off',
  );
  assert.equal(harness.hostOn(), false, '宿主状态必须真的被改到');
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '一次点击后芯片必须显示「记忆已关」');
});

test('记忆开关：未知态 + 探测到"已关闭" → 点击发 /memory on（不是再发一次 off）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  // 宿主侧是"关"的，芯片未知
  const harness = makeToggleCtx({ hostOn: false });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['data-unknown'], 'true', '前置条件：未知态');

  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  assert.deepEqual(
    harness.lines(),
    ['/memory status', '/memory on'],
    '探到"已关闭"后点击必须发 on：再发一次 off 就是 noop，用户会以为点了没用',
  );
  assert.equal(harness.hostOn(), true, '宿主状态必须变成开');
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆', '芯片必须回到「记忆」');
});

test('记忆开关：探不到状态（无 commands 命名空间）时，未知态点击按"关"一次完成', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hasCommands: false });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  // 懒探不可用 → 一直未知态，但必须正常渲染
  const chip = findByClass(tree, 'dshmem-tg');
  assert.ok(chip !== null, '没有 commands 服务时组件必须仍然渲染（不得把输入区炸掉）');
  assert.equal(chip.props['data-unknown'], 'true');
  hover(chip);
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(
    findByClass(tree, 'dshmem-tg').props['data-unknown'],
    'true',
    '探不到就保持未知，不得猜',
  );

  // 未知态 + 探不到 → 一次点击直接按"关"下发（用户主动点开关，意图多半是关掉；重复 off 幂等）
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.deepEqual(harness.lines(), ['/memory off'], '探不到时点击必须直接发一次 /memory off');
  assert.equal(harness.hostOn(), false, '宿主状态必须变成关');
  assert.ok(findByClass(tree, 'dshmem-tg') !== null, '仍然正常渲染');
});

test('记忆开关：busy 期间重复点击只发一次命令', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // 先 hover 确知为"开"
  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true);

  // 第一次点击 → 进入 busy；中间渲染一轮（真实 React 会在两次点击之间重渲染）
  findByClass(tree, 'dshmem-tg').props.onClick();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props.disabled, true, 'busy 期间按钮必须 disabled');

  // busy 中再点两次：必须被守卫挡掉
  findByClass(tree, 'dshmem-tg').props.onClick();
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  assert.deepEqual(harness.lines(), ['/memory status', '/memory off'], 'busy 期间的重复点击不得重复发命令');
  assert.equal(
    harness.executed.filter((entry) => entry.line === '/memory off').length,
    1,
    '只允许一条 /memory off',
  );
  assert.equal(findByClass(tree, 'dshmem-tg').props.disabled, false, '落地后必须解除 disabled');
});

test('记忆开关：切会话后旧会话的迟到 probe 结果不得触发 commit', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  /** @type {() => void} */
  let releaseProbe = () => {};
  const probeGate = new Promise((resolve) => {
    releaseProbe = () => resolve();
  });
  // s1 是"开"，但芯片未知；probe 被闸门挡住
  const harness = makeToggleCtx({ hostOn: true, gate: probeGate });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // s1 未知态点击 → setBusy(true) + probe 发出（被挡住）
  let tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  findByClass(tree, 'dshmem-tg').props.onClick();
  assert.deepEqual(harness.lines(), ['/memory status'], '点击应只发出 probe');

  // 切到 s2
  tree = env.render(component, { sessionId: 's2' });

  // 让 s1 的 probe 返回
  releaseProbe();
  await env.flush();
  tree = env.render(component, { sessionId: 's2' });

  // 旧会话的迟到结果绝不能触发 commit：那会把开关命令打到用户已经离开的会话上
  assert.deepEqual(
    harness.lines(),
    ['/memory status'],
    '切走后不得用旧会话的 probe 结果下发命令',
  );
  assert.equal(harness.hostOn(), true, '宿主状态不得被改动');

  // 而且 busy 必须被清掉：busy 是组件级状态，而组件**不会**因换会话重挂载
  // （宿主 renderEntry 不给 key），漏清会让芯片在【所有】会话上永久 disabled = 按钮坏了。
  assert.equal(
    findByClass(tree, 'dshmem-tg').props.disabled,
    false,
    '切会话后必须解除 busy，否则芯片永久变成"点不动"',
  );
});

test('记忆开关：订阅 command/executed——用户手打 /memory off 时芯片要跟着变', async () => {
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

  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '前置条件：当前显示为"开"');

  const emit = harness.commandExecutedListeners[0];

  // 别的会话：不得影响本会话芯片
  emit('other-session', 'memory', { kind: 'success', text: '状态：记忆已关闭' });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '别的会话的事件不得改本会话');

  // 别的命令名：不得影响
  emit('s', 'export', { kind: 'success', text: '状态：记忆已关闭' });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '非 memory 命令不得改芯片');

  // 失败结果：不得改
  emit('s', 'memory', { kind: 'error', text: '状态：记忆已关闭' });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, 'kind!==success 不得改芯片');

  // 正例：用户手打 /memory off → 芯片变「记忆已关」
  emit('s', 'memory', { kind: 'success', text: '状态：记忆已关闭' });
  tree = env.render(component, { sessionId: 's' });
  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['aria-pressed'], false, '收到 success 事件后必须变"关"');
  assert.equal(textOf(chip), '记忆已关', '收到 success 事件后文案必须变「记忆已关」');
  assert.ok(findByClass(tree, 'dshmem-tg-bar') !== null, '收到 success 事件后必须画出斜杠');

  // 反向：再开回来
  emit('s', 'memory', { kind: 'success', text: '状态：记忆已开启' });
  tree = env.render(component, { sessionId: 's' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆', '收到"已开启"事件后必须变回「记忆」');

  // 事件驱动的更新不得产生任何命令
  assert.equal(harness.statusCount(), 1, '事件订阅不得额外发 status');
});

test('记忆开关：同一会话重挂载/换会话——缓存带结果、不重复回读', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: true });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // s1：hover 探一次
  let tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  assert.equal(harness.statusCount(), 1, 's1 首次 hover 探一次');
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true);

  // 换到 s2：必须为新会话重新探（状态是按会话隔离的）
  tree = env.render(component, { sessionId: 's2' });
  await env.flush();
  tree = env.render(component, { sessionId: 's2' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['data-unknown'], 'true', '换到没探过的会话应是未知态');
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's2' });
  assert.equal(harness.statusCount(), 2, '换会话必须重新回读');

  // 换回 s1：命中缓存，不重复探，且立刻显示真实状态
  tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  assert.equal(
    findByClass(tree, 'dshmem-tg').props['aria-pressed'],
    true,
    '换回已探过的会话必须直接用缓存状态渲染，不得退回"未知"',
  );
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  assert.equal(harness.statusCount(), 2, '换回已探过的会话 hover 也不得再发 status');
});

test('记忆开关：重挂载时不得把已关闭的会话显示成开启（缓存必须带结果）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  const harness = makeToggleCtx({ hostOn: false }); // 宿主侧是「关」

  plugin.apply(harness.ctx);
  const component = harness.component();

  // hover 探到"关"
  let tree = env.render(component, { sessionId: 'off-session' });
  await env.flush();
  tree = env.render(component, { sessionId: 'off-session' });
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 'off-session' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '探到关闭后必须显示「记忆已关」');

  // 真正模拟"卸载后重新挂载"：丢掉组件状态，插件闭包（含状态缓存）仍活着
  env.unmount();
  tree = env.render(component, { sessionId: 'off-session' });
  await env.flush();
  tree = env.render(component, { sessionId: 'off-session' });

  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['aria-pressed'], false, '重挂载后必须仍是"关"：退回未知就是在骗用户');
  assert.equal(chip.props['data-unknown'], undefined, '重挂载后不得退回未知态');
  assert.equal(textOf(chip), '记忆已关', '重挂载后文案必须仍是「记忆已关」');
  assert.ok(findByClass(tree, 'dshmem-tg-bar') !== null, '重挂载后斜杠必须仍在');
  assert.equal(harness.statusCount(), 1, '重挂载不得再发 status（缓存已带结果）');
});

test('记忆开关：回读途中重挂载也要拿到结果（共享同一个进行中的回读）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  /** @type {() => void} */
  let releaseProbe = () => {};
  const probeGate = new Promise((resolve) => {
    releaseProbe = () => resolve();
  });
  const harness = makeToggleCtx({ hostOn: false, gate: probeGate });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // 第一次 hover：发出回读，但**还没返回**
  let tree = env.render(component, { sessionId: 's' });
  hover(findByClass(tree, 'dshmem-tg'));
  assert.equal(harness.statusCount(), 1, 'hover 应发出一次回读');

  // 回读途中卸载并重新挂载（真实场景：输入区随会话切换重挂载），再 hover 一次
  env.unmount();
  tree = env.render(component, { sessionId: 's' });
  hover(findByClass(tree, 'dshmem-tg'));
  assert.equal(harness.statusCount(), 1, '回读途中重挂载不得再发一次命令（应复用进行中的那次）');

  // 现在让回读返回
  releaseProbe();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(textOf(chip), '记忆已关', '重挂载后的实例必须也能拿到进行中回读的结果，不得停在"未知"');
  assert.equal(chip.props['aria-pressed'], false);
});

test('记忆开关：status 认不出时不写缓存，下次交互会重试（不被一次失败锁死）', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  // 旧宿主的 status 返回不含约定的状态标记
  const harness = makeToggleCtx({ statusText: '/memory 用法说明' });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // 第一次 hover：探了，但认不出 → 仍是未知态
  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(harness.statusCount(), 1, '第一次 hover 应探一次');
  assert.equal(
    findByClass(tree, 'dshmem-tg').props['data-unknown'],
    'true',
    '认不出时必须停在未知态，不得猜成开或关',
  );

  // 宿主这次能给出标记了 → 第二次 hover 必须重试并成功（null 不得进缓存）
  harness.setStatusText('状态：记忆已关闭');
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(harness.statusCount(), 2, 'null 结果不得写进缓存，下次交互必须重试');
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '重试成功后必须显示真实状态');
});

test('记忆开关：切会话后旧会话的迟到结果不得覆盖新会话显示', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  /** @type {() => void} */
  let releaseProbe = () => {};
  const probeGate = new Promise((resolve) => {
    releaseProbe = () => resolve();
  });
  // s1 是「关」；s2 从未探过
  const harness = makeToggleCtx({ hostOn: false, gate: probeGate });

  plugin.apply(harness.ctx);
  const component = harness.component();

  // s1 上 hover：回读发出，但被闸门挡住（还在途中）
  let tree = env.render(component, { sessionId: 's1' });
  hover(findByClass(tree, 'dshmem-tg'));
  assert.equal(harness.statusCount(), 1, 's1 上应发出一次回读');

  // 切到 s2：此刻 s2 是未知态
  tree = env.render(component, { sessionId: 's2' });
  assert.equal(
    findByClass(tree, 'dshmem-tg').props['data-unknown'],
    'true',
    '切到没探过的 s2 必须是未知态',
  );

  // 现在让 s1 那次回读返回（结果是"关"）
  releaseProbe();
  await env.flush();
  tree = env.render(component, { sessionId: 's2' });

  // s1 的迟到结果绝不能写到 s2 的显示上（否则 s2 会显示成 s1 的状态 = 骗用户）
  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(
    chip.props['data-unknown'],
    'true',
    's1 的迟到结果不得覆盖 s2：s2 仍应是未知态',
  );
  assert.equal(textOf(chip), '记忆', 's2 不得显示成 s1 的「记忆已关」');
  assert.equal(chip.props['aria-pressed'], undefined, 's2 仍未知，不得给 aria-pressed');

  // 但结果本身应当进了 s1 的缓存：切回 s1 立刻显示"关"，且不重复发命令
  tree = env.render(component, { sessionId: 's1' });
  await env.flush();
  tree = env.render(component, { sessionId: 's1' });
  assert.equal(textOf(findByClass(tree, 'dshmem-tg')), '记忆已关', '切回 s1 应立刻显示缓存的"关"');
  assert.equal(harness.statusCount(), 1, '切回已探过的会话不得再发命令');
});

test('记忆开关：旧宿主不认 /memory（matched=false）时不得假装切成功', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);
  // status 能探到"开"，但写命令不被识别（旧宿主）
  const harness = makeToggleCtx({ hostOn: true, matched: false });

  plugin.apply(harness.ctx);
  const component = harness.component();

  let tree = env.render(component, { sessionId: 's' });
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  hover(findByClass(tree, 'dshmem-tg'));
  await env.flush();
  tree = env.render(component, { sessionId: 's' });
  assert.equal(findByClass(tree, 'dshmem-tg').props['aria-pressed'], true, '前置条件：已知为"开"');

  // 点击：命令发出但宿主不认 → UI 必须保持"开"，不得翻成"已关"
  findByClass(tree, 'dshmem-tg').props.onClick();
  await env.flush();
  tree = env.render(component, { sessionId: 's' });

  const chip = findByClass(tree, 'dshmem-tg');
  assert.equal(chip.props['aria-pressed'], true, 'matched=false 时绝不能把 UI 改成已关闭——保持原状');
  assert.equal(textOf(chip), '记忆', 'matched=false 时文案不得变成「记忆已关」');
  assert.equal(findByClass(tree, 'dshmem-tg-bar'), null, 'matched=false 时不得画出"已关"的斜杠');
});

test('记忆开关：会话未打开时点击不发命令且不崩', async () => {
  const { registration } = load();
  const env = liveReact();
  const plugin = registration.factory(() => env.React);

  /** @type {string[]} */
  const commands = [];
  /** @type {any} */
  const ctx = {
    remote: { workspaceFiles: {}, commands: {} },
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

test('toggleTooltip：未知态不得宣称"已开启"（P0-2 的同一类错误）', () => {
  const { exports } = load({ window: false });
  const tipUnknown = exports.toggleTooltip(null);
  const tipOn = exports.toggleTooltip(true);

  // 芯片主体在未知态是诚实的（中性外观 + aria-pressed 缺省 + data-unknown），
  // tooltip 不能反过来宣称一个状态——那只是换个地方继续骗用户。
  assert.notEqual(tipUnknown.main, tipOn.main, '未知态 tooltip 必须与"确知开启"不同');
  assert.ok(!tipUnknown.main.includes('已开启'), '未知态不得出现「已开启」');
  assert.ok(!tipUnknown.main.includes('已关闭'), '未知态不得出现「已关闭」');
  assert.ok(tipUnknown.main.includes('未知'), '未知态应当明说状态未知');
  // 点击语义是"先探真值再取反"，所以未知态不能承诺"点击关闭"
  assert.ok(!tipUnknown.main.includes('点击关闭'), '未知态不得承诺"点击关闭"（实际是先探再取反）');
  // 但"关闭的后果"这条教育性信息应当保留
  assert.ok(tipUnknown.sub.includes('五个 memory_* 工具不可见'), '未知态仍须说明关闭的后果');
});

test('CSS 覆盖开关三态（含未知态），且选择器都带 dshmem- 前缀', () => {
  const { exports } = load({ window: false });
  const css = exports.CSS;
  for (const token of [
    '.dshmem-tg {',
    '.dshmem-tg[aria-pressed=true]',
    '.dshmem-tg[aria-pressed=false]',
    // review P0-2：未知态必须有独立的中性外观（既不是"开"的实底，也不是"关"的降级+斜杠）
    '.dshmem-tg[data-unknown=true]',
    '.dshmem-tg-bar',
    '.dshmem-tg-tip',
    '.dshmem-tg-wrap:hover .dshmem-tg-tip',
  ]) {
    assert.ok(css.includes(token), `样式表必须含 ${token}`);
  }
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
