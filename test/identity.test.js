/**
 * `identity` 的验收测试（设计 §7.0 判定口径、§17.5 白名单）。
 *
 * 核心回归（2026-09-26 真机 P0）：**宿主 fork 顶层会话也写 `parentSession`**，
 * 它与真子代理同形不同源；把前者判成子代理会让 `restrict({ deny })` 摘掉四个写入类工具，
 * 模型一调用就撞上宿主 `Error: unknown tool "<name>"`（UNKNOWN_TOOL）。
 *
 * 真实 header 形状（`dsh-session` 的 `SessionStore.fork()` /
 * `dsh-api-session-controller` 的 `commands.fork()`）：
 *   { cwd, parentSession: <源会话 id>, isSeeded: true, delegationDepth: 0 }
 * 真子代理（`dsh-subagent` 的 `childSessionMeta()`）：
 *   { cwd, parentSession: <父会话 id>, origin: 'subagent', delegationDepth: <≥1>, isSeeded: <bool> }
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAllowlist, describeIdentity, isExplicitTopLevel, isForkedTopLevel, isSubagent } from '../src/identity.js';

/** 宿主 fork 顶层会话的真实 header。 */
const FORK_HEADER = Object.freeze({
  cwd: 'D:\\PowerShell',
  parentSession: 'session-7b372557-b94a-426d-b961-cf1dfa378c1d',
  isSeeded: true,
  delegationDepth: 0,
});

/** 宿主真子代理的真实 header。 */
const SUBAGENT_HEADER = Object.freeze({
  cwd: 'D:\\PowerShell',
  parentSession: 'session-parent',
  origin: /** @type {'subagent'} */ ('subagent'),
  delegationDepth: 1,
  isSeeded: false,
});

describe('isSubagent：只用正向特征（origin／delegationDepth）', () => {
  test('fork 顶层会话**不是**子代理（真机 P0 的回归点）', () => {
    assert.equal(isSubagent(FORK_HEADER), false);
  });

  test('origin=subagent 是子代理', () => {
    assert.equal(isSubagent(SUBAGENT_HEADER), true);
    assert.equal(isSubagent({ origin: 'subagent' }), true);
  });

  test('缺 origin 但 delegationDepth>0 也算子代理（第三方 provider 路径）', () => {
    assert.equal(isSubagent({ parentSession: 'p', delegationDepth: 1 }), true);
    assert.equal(isSubagent({ delegationDepth: 2 }), true);
  });

  test('顶层会话（含落盘补零的恢复会话）不是子代理', () => {
    assert.equal(isSubagent({ delegationDepth: 0 }), false);
    assert.equal(isSubagent({}), false);
    assert.equal(isSubagent(undefined), false);
    assert.equal(isSubagent(null), false);
  });

  test('只有 parentSession、且不满足 fork 形状时：既不是子代理也不放行（未知 lineage 隔离）', () => {
    const weird = { parentSession: 'p' }; // isSeeded 缺失
    assert.equal(isSubagent(weird), false, 'parentSession 单独存在不能当子代理判据');
    assert.equal(isExplicitTopLevel(weird), false, '判不出来就必须隔离，不能放行');
  });
});

describe('isForkedTopLevel：fork 顶层会话的四个正向条件', () => {
  test('宿主 fork 形状 → true', () => {
    assert.equal(isForkedTopLevel(FORK_HEADER), true);
  });

  test('内存态 fork（delegationDepth 要落盘才补 0）同样是 fork —— 真机真实形状', () => {
    const liveFork = { cwd: 'D:/x', parentSession: 'p', isSeeded: true };
    assert.equal(isForkedTopLevel(liveFork), true);
    assert.equal(isSubagent(liveFork), false);
    assert.equal(isExplicitTopLevel(liveFork), true);
  });

  test('缺任意一个条件都不算', () => {
    assert.equal(isForkedTopLevel({ ...FORK_HEADER, isSeeded: false }), false, 'isSeeded 必须是明确的 true');
    assert.equal(isForkedTopLevel({ parentSession: 'p', isSeeded: true, delegationDepth: 1 }), false);
    assert.equal(isForkedTopLevel({ isSeeded: true }), false, '没有 parentSession 不是 fork');
    assert.equal(
      isForkedTopLevel({ ...FORK_HEADER, origin: /** @type {'subagent'} */ ('subagent') }),
      false,
      '带 origin 的是子会话',
    );
    assert.equal(isForkedTopLevel(undefined), false);
    assert.equal(isForkedTopLevel(null), false);
  });

  test('非对象 header 一律不放行（不因字段全是 undefined 就误判成顶层）', () => {
    // 宿主 header 必为 SessionHeader 对象；这里只钉住"传进来不是对象"时绝不放行
    for (const bad of ['x', 1, true]) {
      const value = /** @type {any} */ (bad);
      assert.equal(isSubagent(value), false);
      assert.equal(isForkedTopLevel(value), false);
      assert.equal(isExplicitTopLevel(value), false);
    }
  });
});

describe('isExplicitTopLevel：白名单唯一准入条件', () => {
  test('fork 顶层会话必须放行（否则写入工具与注入一起消失）', () => {
    assert.equal(isExplicitTopLevel(FORK_HEADER), true);
  });

  test('内存态顶层（字段全缺省）与落盘恢复会话都放行', () => {
    assert.equal(isExplicitTopLevel({}), true);
    assert.equal(isExplicitTopLevel({ isSeeded: false, delegationDepth: 0 }), true);
  });

  test('真子代理被挡在门外', () => {
    assert.equal(isExplicitTopLevel(SUBAGENT_HEADER), false);
    assert.equal(isExplicitTopLevel({ delegationDepth: 1 }), false);
  });

  test('缺 header 一律不放行', () => {
    assert.equal(isExplicitTopLevel(undefined), false);
    assert.equal(isExplicitTopLevel(null), false);
  });
});

describe('describeIdentity：日志里能看出为什么被隔离', () => {
  test('四个血缘字段都进描述，缺失写"未提供"', () => {
    const text = describeIdentity(FORK_HEADER);
    assert.match(text, /origin=未提供/);
    assert.match(text, /parentSession=有/);
    assert.match(text, /delegationDepth=0/);
    assert.match(text, /isSeeded=true/);
    assert.equal(describeIdentity(undefined), 'header=缺失');
  });
});

describe('createAllowlist：按会话 id 记录"这是主会话"', () => {
  test('add／has／remove／size', () => {
    const allowlist = createAllowlist();
    assert.equal(allowlist.size(), 0);
    assert.equal(allowlist.has('s1'), false);
    allowlist.add('s1');
    assert.equal(allowlist.has('s1'), true);
    assert.equal(allowlist.size(), 1);
    allowlist.remove('s1');
    assert.equal(allowlist.has('s1'), false);
    assert.equal(allowlist.size(), 0);
  });
});
