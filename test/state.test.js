/**
 * `state` 单测：`.state/ids` 与 `.state/usage.json` 的原子读写、损坏降级、bumpUsage 纯函数。
 *
 * 全部在 `fs.mkdtempSync(os.tmpdir())` 临时目录里进行，绝不触碰真实项目目录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IDS_FILE, STATE_DIR, USAGE_FILE, bumpUsage, loadState, saveState } from '../src/state.js';

/** @type {string[]} */
const temps = [];

/** @returns {string} 临时记忆目录 */
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  return dir;
}

/**
 * 写出 `.state/` 目录（loadState 自己不建目录）
 *
 * @param {string} dir 记忆目录
 * @returns {string} `.state` 目录路径
 */
function makeStateDir(dir) {
  const stateDir = path.join(dir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录。
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadState：缺省与损坏降级', () => {
  test('全新项目：没有 .state → ids=null、usage={}、无告警', async () => {
    const dir = tempDir();
    assert.deepEqual(await loadState(dir), { ids: null, usage: {}, warnings: [] });
  });

  test('水位线文件损坏 → 按缺失处理并记 watermark-rebuilt', async () => {
    const dir = tempDir();
    makeStateDir(dir);
    writeFileSync(path.join(dir, IDS_FILE), '这不是数字\n');

    const loaded = await loadState(dir);
    assert.equal(loaded.ids, null);
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.warnings[0].code, 'watermark-rebuilt');
    assert.equal(loaded.warnings[0].filePath, path.join(dir, IDS_FILE));
  });

  test('水位线读不出（是目录）→ 记 watermark-rebuilt，不抛错', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, IDS_FILE), { recursive: true });

    const loaded = await loadState(dir);
    assert.equal(loaded.ids, null);
    assert.equal(loaded.warnings.some((warning) => warning.code === 'watermark-rebuilt'), true);
  });

  test('usage 损坏（不是 JSON）→ 清空并记 usage-reset', async () => {
    const dir = tempDir();
    makeStateDir(dir);
    writeFileSync(path.join(dir, USAGE_FILE), '{ 这不是 JSON');

    const loaded = await loadState(dir);
    assert.deepEqual(loaded.usage, {});
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.warnings[0].code, 'usage-reset');
  });

  test('usage 结构非法（值是数字）→ 丢弃该条并记 usage-reset', async () => {
    const dir = tempDir();
    makeStateDir(dir);
    writeFileSync(path.join(dir, USAGE_FILE), '{"#0001": 5}');

    const loaded = await loadState(dir);
    assert.deepEqual(loaded.usage, {});
    assert.equal(loaded.warnings[0].code, 'usage-reset');
  });

  test('usage 单条坏、其余好 → 只丢坏的那条', async () => {
    const dir = tempDir();
    makeStateDir(dir);
    writeFileSync(
      path.join(dir, USAGE_FILE),
      JSON.stringify({
        '#0001': { count: 3, lastUsedAt: '2026-09-20T10:00:00.000Z' },
        '#0002': '坏值',
        '#0003': { count: -1, lastUsedAt: 'x' },
      }),
    );

    const loaded = await loadState(dir);
    assert.deepEqual(loaded.usage, { '#0001': { count: 3, lastUsedAt: '2026-09-20T10:00:00.000Z' } });
    assert.equal(loaded.warnings.length, 1);
    assert.equal(loaded.warnings[0].code, 'usage-reset');
  });

  test('usage 键归一：裸数字键补成 #NNNN', async () => {
    const dir = tempDir();
    makeStateDir(dir);
    writeFileSync(path.join(dir, USAGE_FILE), JSON.stringify({ '0007': { count: 1, lastUsedAt: 'x' } }));

    const loaded = await loadState(dir);
    assert.deepEqual(loaded.usage, { '#0007': { count: 1, lastUsedAt: 'x' } });
    assert.deepEqual(loaded.warnings, []);
  });
});

describe('saveState / loadState：原子写与往返', () => {
  test('写 ids 与 usage 后能原样读回，且不留临时文件', async () => {
    const dir = tempDir();
    const usage = { '#0001': { count: 2, lastUsedAt: '2026-09-20T10:00:00.000Z' } };

    assert.deepEqual(await saveState(dir, { ids: 11, usage }), { ok: true });
    assert.equal(readFileSync(path.join(dir, IDS_FILE), 'utf8'), '11\n');
    assert.equal(readFileSync(path.join(dir, USAGE_FILE), 'utf8'), `${JSON.stringify(usage, null, 2)}\n`);
    assert.deepEqual(
      readdirSync(path.join(dir, STATE_DIR)).filter((name) => name.endsWith('.tmp')),
      [],
    );

    const loaded = await loadState(dir);
    assert.equal(loaded.ids, 11);
    assert.deepEqual(loaded.usage, usage);
    assert.deepEqual(loaded.warnings, []);
  });

  test('patch 只给一个键时只写一个文件', async () => {
    const dir = tempDir();
    await saveState(dir, { usage: {} });
    assert.equal(existsSync(path.join(dir, USAGE_FILE)), true);
    assert.equal(existsSync(path.join(dir, IDS_FILE)), false);

    const other = tempDir();
    await saveState(other, { ids: 3 });
    assert.equal(existsSync(path.join(other, IDS_FILE)), true);
    assert.equal(existsSync(path.join(other, USAGE_FILE)), false);
  });

  test('patch.ids 为 null/undefined → 不动水位线', async () => {
    const dir = tempDir();
    await saveState(dir, { ids: 5, usage: {} });
    await saveState(dir, { ids: null, usage: { '#0001': { count: 1, lastUsedAt: 'x' } } });
    assert.equal(readFileSync(path.join(dir, IDS_FILE), 'utf8'), '5\n');

    const loaded = await loadState(dir);
    assert.equal(loaded.ids, 5);
  });

  test('水位线取值非法 → 失败且不落盘', async () => {
    const dir = tempDir();
    const result = await saveState(dir, { ids: Number.NaN });
    assert.equal(result.ok, false);
    assert.equal(existsSync(path.join(dir, IDS_FILE)), false);
  });

  test('saveState 自己创建 .state 目录（全新项目）', async () => {
    const dir = tempDir();
    assert.deepEqual(await saveState(dir, { ids: 1 }), { ok: true });
    assert.equal(existsSync(path.join(dir, STATE_DIR)), true);
  });
});

describe('bumpUsage：纯函数', () => {
  test('计数 +1 并更新 lastUsedAt，入参不被修改', () => {
    const usage = { '#0001': { count: 1, lastUsedAt: '2026-09-19T00:00:00.000Z' } };
    const next = bumpUsage(usage, ['#0001', '#0002'], '2026-09-20T10:00:00.000Z');

    assert.deepEqual(next, {
      '#0001': { count: 2, lastUsedAt: '2026-09-20T10:00:00.000Z' },
      '#0002': { count: 1, lastUsedAt: '2026-09-20T10:00:00.000Z' },
    });
    assert.deepEqual(usage, { '#0001': { count: 1, lastUsedAt: '2026-09-19T00:00:00.000Z' } });
    assert.notEqual(next, usage);
  });

  test('只有长期记忆编号计入：日志编号与其他非法值忽略', () => {
    const next = bumpUsage({}, ['#0001', 'J-20260920-1432', '坏值', ''], '2026-09-20T10:00:00.000Z');
    assert.deepEqual(next, { '#0001': { count: 1, lastUsedAt: '2026-09-20T10:00:00.000Z' } });
  });

  test('同一次调用里重复的编号只计一次', () => {
    const next = bumpUsage({}, ['#0001', '#0001', '#0001'], '2026-09-20T10:00:00.000Z');
    assert.equal(next['#0001'].count, 1);
  });

  test('usage 缺失/为空、ids 为空都安全', () => {
    assert.deepEqual(bumpUsage(undefined, ['#0005'], 'x'), { '#0005': { count: 1, lastUsedAt: 'x' } });
    assert.deepEqual(bumpUsage(null, [], 'x'), {});
    assert.deepEqual(bumpUsage({ '#0001': { count: 1, lastUsedAt: 'x' } }, [], 'y'), {
      '#0001': { count: 1, lastUsedAt: 'x' },
    });
  });

  test('bumpUsage 的返回值可以直接交给 saveState 落盘', async () => {
    const dir = tempDir();
    const usage = bumpUsage(undefined, ['#0009'], '2026-09-20T10:00:00.000Z');
    assert.deepEqual(await saveState(dir, { ids: 9, usage }), { ok: true });
    const loaded = await loadState(dir);
    assert.deepEqual(loaded.usage, { '#0009': { count: 1, lastUsedAt: '2026-09-20T10:00:00.000Z' } });
    assert.equal(loaded.ids, 9);
  });
});
