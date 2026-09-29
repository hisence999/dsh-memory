/**
 * `memory-files` 单测：原子写与指纹冲突、读失败降级、`wx` 幂等、按路径串行。
 *
 * 纪律（工程约定 §0.9）：全部在 `fs.mkdtempSync(os.tmpdir())` 建出的临时目录里进行，
 * **绝不触碰真实项目目录**。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  backupFile,
  ensureFile,
  fingerprint,
  listDir,
  mkdirp,
  readText,
  removeFile,
  withPathQueue,
  writeAtomic,
} from '../src/memory-files.js';

/** @type {string[]} */
const temps = [];

/** @returns {string} 本次测试独占的临时目录 */
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  return dir;
}

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() {
  /** @type {() => void} */
  let resolveFn = () => undefined;
  /** @type {Promise<void>} */
  const promise = new Promise((resolve) => {
    resolveFn = () => {
      resolve();
    };
  });
  return { promise, resolve: resolveFn };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录。
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('readText：读失败一律按无内容降级', () => {
  test('文件不存在 → 空内容且没有 error', async () => {
    const dir = tempDir();
    const result = await readText(path.join(dir, '不存在的文件.md'));
    assert.deepEqual(result, { content: '' });
  });

  test('读失败（目标是目录）→ 空内容 + error，不抛错', async () => {
    const dir = tempDir();
    const asDir = path.join(dir, 'dir.md');
    mkdirSync(asDir);
    const result = await readText(asDir);
    assert.equal(result.content, '');
    assert.equal(typeof result.error, 'string');
  });

  test('换行归一为 \\n（Windows 编辑器写入的 CRLF 不制造假"人工改动"）', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.md');
    writeFileSync(file, '第一行\r\n第二行\r第三行\n');
    const result = await readText(file);
    assert.equal(result.content, '第一行\n第二行\n第三行\n');
  });
});

describe('fingerprint：内容指纹', () => {
  test('稳定、16 位十六进制、随内容变化', () => {
    const a = fingerprint('记忆内容');
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, fingerprint('记忆内容'));
    assert.notEqual(a, fingerprint('记忆内容 '));
  });
});

describe('writeAtomic：同目录临时文件 + rename', () => {
  test('落盘内容正确，且不留临时文件', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    const result = await writeAtomic(file, '# 记忆 · 2026-09-20\n');
    assert.deepEqual(result, { ok: true });
    assert.equal(readFileSync(file, 'utf8'), '# 记忆 · 2026-09-20\n');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  test('父目录不存在时自动创建', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'memory', 'archive', 'M-2026-09-19.md');
    const result = await writeAtomic(file, 'x\n');
    assert.equal(result.ok, true);
    assert.equal(readFileSync(file, 'utf8'), 'x\n');
  });

  test('指纹不符 → write_conflict，目标保持原样，且不留临时文件', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    writeFileSync(file, '人工改过的内容\n');

    const result = await writeAtomic(file, '我基于旧快照的新内容\n', { expectedFingerprint: fingerprint('旧快照\n') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'write_conflict');
    assert.equal(readFileSync(file, 'utf8'), '人工改过的内容\n');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  test('指纹相符 → 正常写入', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    writeFileSync(file, '旧内容\n');
    const result = await writeAtomic(file, '新内容\n', { expectedFingerprint: fingerprint('旧内容\n') });
    assert.deepEqual(result, { ok: true });
    assert.equal(readFileSync(file, 'utf8'), '新内容\n');
  });

  test('文件不存在却给了期望指纹 → write_conflict（不凭空创建）', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    const result = await writeAtomic(file, '新内容\n', { expectedFingerprint: fingerprint('旧内容\n') });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'write_conflict');
    assert.equal(existsSync(file), false);
  });

  test('已中止的 signal → 失败且不落盘', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    const controller = new AbortController();
    controller.abort();
    const result = await writeAtomic(file, '新内容\n', { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'io_error');
    assert.equal(existsSync(file), false);
  });
});

describe('ensureFile：wx 幂等建文件', () => {
  test('首次创建；再次调用 no-op 且不覆盖既有内容', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'JOURNAL-2026-09-20.md');
    const first = await ensureFile(file, '# 日志 · 2026-09-20\n');
    assert.deepEqual(first, { created: true });
    writeFileSync(file, '# 日志 · 2026-09-20\n\n### 已有条目\n');

    const second = await ensureFile(file, '# 骨架\n');
    assert.deepEqual(second, { created: false });
    assert.equal(readFileSync(file, 'utf8'), '# 日志 · 2026-09-20\n\n### 已有条目\n');
  });

  test('并发创建只写一次（多会话首次使用同一项目）', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'INDEX.md');
    const results = await Promise.all([ensureFile(file, 'A\n'), ensureFile(file, 'B\n'), ensureFile(file, 'C\n')]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.ok(['A\n', 'B\n', 'C\n'].includes(readFileSync(file, 'utf8')));
  });
});

describe('withPathQueue：同一路径串行', () => {
  test('同一 key 的异步任务按提交顺序串行', async () => {
    /** @type {string[]} */
    const order = [];
    const tasks = [0, 1, 2].map((index) =>
      withPathQueue('same-key', async () => {
        order.push(`start-${index}`);
        await sleep(5);
        order.push(`end-${index}`);
        return index;
      }),
    );
    assert.deepEqual(await Promise.all(tasks), [0, 1, 2]);
    assert.deepEqual(order, ['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  test('不同 key 互不阻塞', async () => {
    /** @type {string[]} */
    const order = [];
    const gate = deferred();
    const slow = withPathQueue('key-a', async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    const fast = withPathQueue('key-b', async () => {
      order.push('b-run');
    });
    await fast;
    assert.deepEqual(order, ['a-start', 'b-run']);
    gate.resolve();
    await slow;
    assert.deepEqual(order, ['a-start', 'b-run', 'a-end']);
  });

  test('前一个任务失败不阻塞后一个，失败照常向上抛', async () => {
    const failing = withPathQueue('key-c', async () => {
      throw new Error('任务失败');
    });
    await assert.rejects(failing, /任务失败/);
    const next = await withPathQueue('key-c', async () => 'ok');
    assert.equal(next, 'ok');
  });

  test('并发 read-modify-write 不丢更新', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    await writeAtomic(file, '# 记忆 · 2026-09-20\n');

    await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        withPathQueue(file, async () => {
          const current = await readText(file);
          await sleep(3);
          const written = await writeAtomic(file, `${current.content}追加-${index}\n`);
          assert.equal(written.ok, true);
        }),
      ),
    );

    const final = await readText(file);
    const appended = final.content.split('\n').filter((line) => line.startsWith('追加-'));
    assert.equal(appended.length, 5);
  });
});

describe('目录、备份与删除', () => {
  test('listDir：码位升序、不存在返回空数组、路径是文件也返回空数组', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'b.md'), '');
    writeFileSync(path.join(dir, 'a.md'), '');
    mkdirSync(path.join(dir, 'archive'));
    assert.deepEqual(await listDir(dir), ['a.md', 'archive', 'b.md']);
    assert.deepEqual(await listDir(path.join(dir, '不存在')), []);

    const asFile = path.join(dir, 'a.md');
    assert.deepEqual(await listDir(asFile), []);
  });

  test('mkdirp：递归创建且已存在也算成功', async () => {
    const dir = tempDir();
    const nested = path.join(dir, 'memory', '.state');
    assert.deepEqual(await mkdirp(nested), { ok: true });
    assert.equal(existsSync(nested), true);
    assert.deepEqual(await mkdirp(nested), { ok: true });
  });

  test('backupFile：原文件存在则复制；不存在则清掉陈旧备份', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'M-2026-09-20.md');
    const backup = path.join(dir, '.M-2026-09-20.md.bak');
    writeFileSync(file, '原内容\n');

    const copied = await backupFile(file, backup);
    assert.equal(copied.ok, true);
    assert.equal(copied.existed, true);
    assert.equal(readFileSync(backup, 'utf8'), '原内容\n');

    const missingFile = path.join(dir, '不存在.md');
    const noSource = await backupFile(missingFile, backup);
    assert.equal(noSource.ok, true);
    assert.equal(noSource.existed, false);
    assert.equal(existsSync(backup), false);
  });

  test('removeFile：删掉目标；文件不存在也算成功', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'tmp.tmp');
    writeFileSync(file, 'x');
    assert.deepEqual(await removeFile(file), { ok: true, existed: true });
    assert.equal(existsSync(file), false);
    assert.deepEqual(await removeFile(file), { ok: true, existed: false });
  });
});
