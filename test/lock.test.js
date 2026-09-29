/**
 * `lock` 单测：`wx` 拿锁、超时等待、陈旧锁接管、release 只删自己的锁、中止。
 *
 * 全部在 `fs.mkdtempSync(os.tmpdir())` 临时目录里进行，绝不触碰真实项目目录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireLock } from '../src/lock.js';

/** @type {string[]} */
const temps = [];

/**
 * 建一个临时目录，并在其中准备好 `.state/`（store 负责建目录，锁只写文件）。
 *
 * @returns {Promise<{ dir: string, lockPath: string }>}
 */
async function makeTarget() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  const lockPath = path.join(dir, '.state', 'lock');
  await mkdir(path.dirname(lockPath), { recursive: true });
  return { dir, lockPath };
}

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录。
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('acquireLock：拿锁与释放', () => {
  test('拿锁 → 锁文件存在 → release 后消失（release 幂等）', async () => {
    const { lockPath } = await makeTarget();

    const lock = await acquireLock(lockPath, { timeoutMs: 200, staleMs: 60_000 });
    assert.equal(lock.ok, true);
    if (!lock.ok) return;
    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(lock.warnings, []);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);

    await lock.release();
    assert.equal(existsSync(lockPath), false);
    await lock.release();
    assert.equal(existsSync(lockPath), false);
  });

  test('锁被占用 → 轮询到超时返回 locked；释放后可以再拿到', async () => {
    const { lockPath } = await makeTarget();

    const holder = await acquireLock(lockPath, { timeoutMs: 0 });
    assert.equal(holder.ok, true);
    if (!holder.ok) return;

    const started = Date.now();
    const second = await acquireLock(lockPath, { timeoutMs: 120, staleMs: 60_000 });
    const elapsed = Date.now() - started;
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, 'locked');
    assert.ok(elapsed >= 100, `应当等到超时才放弃（实际 ${elapsed}ms）`);

    await holder.release();
    const third = await acquireLock(lockPath, { timeoutMs: 50 });
    assert.equal(third.ok, true);
    if (third.ok) await third.release();
  });

  test('timeoutMs=0 且锁被占用 → 立即失败（仍然尝试过一次）', async () => {
    const { lockPath } = await makeTarget();

    const holder = await acquireLock(lockPath, { timeoutMs: 0 });
    assert.equal(holder.ok, true);
    if (!holder.ok) return;

    const started = Date.now();
    const second = await acquireLock(lockPath, { timeoutMs: 0 });
    assert.equal(second.ok, false);
    assert.ok(Date.now() - started < 100);
    await holder.release();
  });

  test('timeoutMs/staleMs 非法 → 回退默认值，不抛错', async () => {
    const { lockPath } = await makeTarget();

    const lock = await acquireLock(lockPath, { timeoutMs: -5, staleMs: Number.NaN });
    assert.equal(lock.ok, true);
    if (lock.ok) await lock.release();
  });

  test('锁目录不存在 → io_error（不抛错）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
    temps.push(dir);
    const result = await acquireLock(path.join(dir, '不存在', '.state', 'lock'), { timeoutMs: 50 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'io_error');
    assert.equal(typeof result.error, 'string');
  });
});

describe('acquireLock：陈旧锁接管', () => {
  test('mtime 超过 staleMs → 接管锁并记 stale-lock-taken', async () => {
    const { lockPath } = await makeTarget();

    writeFileSync(lockPath, '{"pid":999999,"createdAt":"2020-01-01T00:00:00.000Z"}\n');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockPath, old, old);

    /** @type {Array<{ code: string, message: string }>} */
    const warned = [];
    const lock = await acquireLock(lockPath, {
      timeoutMs: 500,
      staleMs: 1000,
      warn: (warning) => {
        warned.push(warning);
      },
    });

    assert.equal(lock.ok, true);
    if (!lock.ok) return;
    assert.equal(lock.warnings.length, 1);
    assert.equal(lock.warnings[0].code, 'stale-lock-taken');
    assert.equal(warned.length, 1);
    assert.equal(warned[0].code, 'stale-lock-taken');
    // 锁已换成我们自己的凭据
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);

    await lock.release();
    assert.equal(existsSync(lockPath), false);
  });

  test('未超 staleMs 的锁不会被接管', async () => {
    const { lockPath } = await makeTarget();
    writeFileSync(lockPath, '别人的锁\n');

    const result = await acquireLock(lockPath, { timeoutMs: 80, staleMs: 60_000 });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(lockPath, 'utf8'), '别人的锁\n');
  });
});

describe('acquireLock：release 只删自己创建的锁', () => {
  test('锁被他人替换后，release 不动手', async () => {
    const { lockPath } = await makeTarget();

    const lock = await acquireLock(lockPath, { timeoutMs: 100 });
    assert.equal(lock.ok, true);
    if (!lock.ok) return;

    // 模拟：本进程持有的锁已被别人接管（内容变了）。
    writeFileSync(lockPath, '别人接管后的锁\n');
    await lock.release();
    assert.equal(readFileSync(lockPath, 'utf8'), '别人接管后的锁\n');
  });
});

describe('acquireLock：并发与中止', () => {
  test('并发争抢只有一个成功', async () => {
    const { lockPath } = await makeTarget();

    const results = await Promise.all([
      acquireLock(lockPath, { timeoutMs: 0 }),
      acquireLock(lockPath, { timeoutMs: 0 }),
      acquireLock(lockPath, { timeoutMs: 0 }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const winner = results.find((result) => result.ok);
    if (winner !== undefined && winner.ok) await winner.release();
  });

  test('signal 中止 → 快速返回且不抛错', async () => {
    const { lockPath } = await makeTarget();

    const holder = await acquireLock(lockPath, { timeoutMs: 0 });
    assert.equal(holder.ok, true);
    if (!holder.ok) return;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const result = await acquireLock(lockPath, { timeoutMs: 5000, signal: controller.signal });
    const elapsed = Date.now() - started;

    assert.equal(result.ok, false);
    assert.ok(elapsed < 2000, `中止应当很快返回（实际 ${elapsed}ms）`);
    await holder.release();
  });

  test('入口即已中止 → 失败且不创建锁文件', async () => {
    const { lockPath } = await makeTarget();

    const controller = new AbortController();
    controller.abort();
    const result = await acquireLock(lockPath, { timeoutMs: 100, signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(existsSync(lockPath), false);
  });
});
