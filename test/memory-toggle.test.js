/**
 * 每会话「记忆开关」纯逻辑的单测。
 *
 * 守卫三件事：
 *   1. 默认值必须是「开」——任何"没显式关过"的会话都不能被静默关掉记忆；
 *   2. 边界输入（非字符串 / 空串 / 未见过）必须落在"开"这一侧（失败方向可控）；
 *   3. 文案必须说清"不是删除、不影响其他工具"，否则用户会以为记忆被清了。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOGGLE_TOOL_NAMES,
  createToggleState,
  toggleResultText,
  toggleVerbOf,
  withToggleUsage,
} from '../src/memory-toggle.js';

test('开关表：默认全部为「开」，只有显式关闭过的会话才为关', () => {
  const state = createToggleState();
  assert.equal(state.isOn('session-a'), true, '从未见过的会话必须默认开启');
  assert.equal(state.size(), 0, '默认不写任何条目（缺席即开）');

  assert.equal(state.set('session-a', false), true, '首次关闭应报告"有变化"');
  assert.equal(state.isOn('session-a'), false);
  assert.equal(state.size(), 1);

  assert.equal(state.isOn('session-b'), true, '关闭一个会话不能波及其他会话');
});

test('开关表：重复设置返回 false（供命令层回 noop 文案）', () => {
  const state = createToggleState();
  assert.equal(state.set('s', false), true);
  assert.equal(state.set('s', false), false, '已经是关的，再关一次不算变化');
  assert.equal(state.set('s', true), true);
  assert.equal(state.set('s', true), false, '已经是开的，再开一次不算变化');
});

test('开关表：边界输入一律落在「开」这一侧（失败方向可控）', () => {
  const state = createToggleState();
  assert.equal(state.isOn(''), true, '空会话 id 必须按开启处理，不能静默关掉记忆');
  assert.equal(state.isOn(/** @type {any} */ (undefined)), true);
  assert.equal(state.isOn(/** @type {any} */ (null)), true);
  assert.equal(state.isOn(/** @type {any} */ (123)), true);

  assert.equal(state.set('', false), false, '空 id 的写入必须无效');
  assert.equal(state.set(/** @type {any} */ (undefined), false), false);
  assert.equal(state.size(), 0, '非法写入不得污染状态表');
});

test('开关表：clear 清掉痕迹，避免会话 id 复用串味', () => {
  const state = createToggleState();
  state.set('s', false);
  assert.equal(state.isOn('s'), false);
  state.clear('s');
  assert.equal(state.isOn('s'), true, '清理后回到默认开启');
  assert.equal(state.size(), 0);
});

test('开关动词解析：on/off 大小写与空白都接受，其他一律 undefined', () => {
  assert.equal(toggleVerbOf('on'), true);
  assert.equal(toggleVerbOf('off'), false);
  assert.equal(toggleVerbOf('ON'), true);
  assert.equal(toggleVerbOf('  Off  '), false);
  assert.equal(toggleVerbOf('archive'), undefined, 'archive 不是开关动词');
  assert.equal(toggleVerbOf('restore'), undefined);
  assert.equal(toggleVerbOf(''), undefined);
  assert.equal(toggleVerbOf(/** @type {any} */ (undefined)), undefined);
});

test('工具名清单与设计口径一致：恰好五个，且含 memory_search', () => {
  assert.equal(TOGGLE_TOOL_NAMES.length, 5, '关闭时摘掉的必须是五个工具');
  assert.ok(TOGGLE_TOOL_NAMES.includes('memory_search'));
  assert.ok(TOGGLE_TOOL_NAMES.includes('memory_write'));
  assert.ok(TOGGLE_TOOL_NAMES.includes('memory_edit'));
  assert.ok(TOGGLE_TOOL_NAMES.includes('memory_archive'));
  assert.ok(TOGGLE_TOOL_NAMES.includes('memory_log'));
});

test('关闭文案必须说清「不是删除、不影响其他工具」', () => {
  const off = toggleResultText(false, true);
  assert.ok(/不再注入|不注入/.test(off), '必须说明不再注入记忆');
  assert.ok(off.includes('memory_search'), '必须点名消失的工具');
  assert.ok(/一个字都没动|没有删除/.test(off), '必须明确记忆文件未被改动，否则用户会以为被清了');
  assert.ok(off.includes('其他工具'), '必须说明不影响其他工具（这是用户明确选的口径）');
  assert.ok(off.includes('/memory on'), '必须给出恢复路径');
  assert.ok(off.includes('不跨重启保留'), '必须说明状态的生命周期');
});

test('开启文案与 noop 文案可区分', () => {
  const onChanged = toggleResultText(true, true);
  const onNoop = toggleResultText(true, false);
  assert.ok(onChanged.includes('已为本会话开启'));
  assert.ok(onNoop.includes('原本就是开启状态'), '重复开启必须明说没做改动');
  assert.notEqual(onChanged, onNoop);
});

test('重复关闭的 noop 文案也必须可区分，且仍说清「不是删除」（review P2-3 缺口）', () => {
  const offChanged = toggleResultText(false, true);
  const offNoop = toggleResultText(false, false);
  assert.notEqual(offChanged, offNoop, '重复关闭与首次关闭的文案必须不同，否则用户不知道有没有生效');
  assert.ok(offNoop.includes('原本就是关闭状态'), 'noop 必须明说没做改动（否则用户不知道有没有生效）');
  assert.ok(/一个字都没动|没有删除/.test(offNoop), 'noop 文案同样必须说清记忆文件未被改动');
  assert.ok(offNoop.includes('其他工具'), 'noop 文案同样必须说清不影响其他工具');
});

test('用法说明追加开关两行，且保留原有内容', () => {
  const merged = withToggleUsage('原始用法');
  assert.ok(merged.startsWith('原始用法'), '不能丢掉既有的 archive/restore 用法');
  assert.ok(merged.includes('/memory on'));
  assert.ok(merged.includes('/memory off'));
});
