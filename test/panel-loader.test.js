/**
 * 客户端半边的**加载器契约测试**（不需要浏览器）。
 *
 * 守卫的是最容易漂移、且真机才暴露的三件事：
 *   1. 文件必须以 `window.__ModuleLoader__.load({ id, factory })` 形式注册，且 id = 包名；
 *   2. `factory(require)` 必须返回 Cordis 插件对象 `{ name, inject, apply }`；
 *   3. `apply(ctx)` 必须把「记忆」视图注册进 `conversation.view`，id='memory'、order=20，
 *      且注入面覆盖 slots / remote / remote.workspaceFiles / sessions。
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
    '注入面必须与实现一致：槽位注册 + 工作区文件远端 + 会话命令',
  );
});

test('apply 把「记忆」视图注册进 conversation.view（id=memory、order=20）', () => {
  const { registration } = load();
  const plugin = registration.factory(() => fakeReact());

  const calls = makeCalls();
  /** @type {FakeCtx} */
  const ctx = {
    remote: { workspaceFiles: {} },
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

  assert.deepEqual(calls.inject, ['conversation.view'], '必须注入 conversation.view 槽');
  assert.equal(calls.register.length, 1, '应当只注册一条视图');
  const { options, component } = calls.register[0];
  assert.equal(options.name, 'conversation.view');
  assert.equal(options.id, 'memory');
  assert.equal(options.order, 20, 'order=20 让它排在 chat(0) 与 trajectory(10) 之后，紧邻轨迹');
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), '记忆');
  assert.equal(typeof component, 'function', '第二个参数必须是视图组件');
  assert.equal(calls.effect.length, 1, '注册必须挂在 ctx.effect 下，随插件卸载自动撤销');
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
