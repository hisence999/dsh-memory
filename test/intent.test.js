/**
 * `intent` 单测：beginIntent / commitIntent（删除即提交）/ converge 的前滚与回滚，
 * 含"部分文件已生效"的中间态、备份缺失、intent 损坏不可收敛。
 *
 * 全部在 `fs.mkdtempSync(os.tmpdir())` 临时目录里进行，绝不触碰真实项目目录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { INTENT_FILE, beginIntent, commitIntent, converge } from '../src/intent.js';

/** @type {string[]} */
const temps = [];

/** @returns {string} 临时记忆目录 */
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  return dir;
}

/**
 * @param {Array<{ path: string, tmpPath: string, backupPath: string }>} files
 * @returns {{ version: 1, op: 'batch', files: Array<{ path: string, tmpPath: string, backupPath: string }>, createdAt: string }}
 */
function payloadFor(files) {
  return { version: 1, op: 'batch', files, createdAt: '2026-09-20T10:00:00.000Z' };
}

/** @param {string} dir */
function intentPathIn(dir) {
  return path.join(dir, INTENT_FILE);
}

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录。
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('beginIntent / commitIntent', () => {
  test('落一份可读的 intent；删除 intent 即提交', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'M-2026-09-20.md');
    const payload = payloadFor([
      { path: target, tmpPath: path.join(dir, '.a.tmp'), backupPath: path.join(dir, '.a.bak') },
    ]);

    const begun = await beginIntent(dir, payload);
    assert.equal(begun.ok, true);
    if (!begun.ok) return;
    const intentPath = begun.intentPath;
    if (typeof intentPath !== 'string') throw new Error('intent 路径缺失');

    const onDisk = JSON.parse(readFileSync(intentPath, 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.op, 'batch');
    assert.equal(onDisk.files.length, 1);
    assert.equal(onDisk.files[0].path, target);

    // 没有残留临时文件
    assert.equal(
      readdirSync(dir).some((name) => name.endsWith('.tmp')),
      false,
    );

    const committed = await commitIntent(intentPath);
    assert.deepEqual(committed, { ok: true });
    assert.equal(existsSync(intentPathIn(dir)), false);

    // 没有 intent 时收敛是纯读操作
    assert.deepEqual(await converge(dir), { recovered: false, warnings: [] });
  });

  test('结构非法的 payload → 拒绝且不落盘', async () => {
    const dir = tempDir();
    // @ts-expect-error 故意传非法结构
    const result = await beginIntent(dir, { version: 2, op: 'batch', files: [] });
    assert.equal(result.ok, false);
    assert.equal(existsSync(intentPathIn(dir)), false);
  });

  test('commitIntent 幂等：文件已不存在也算提交', async () => {
    const dir = tempDir();
    assert.deepEqual(await commitIntent(intentPathIn(dir)), { ok: true });
  });
});

describe('converge：前滚（临时文件都在 → 继续完成）', () => {
  test('单文件前滚：目标换成新内容，清掉临时与备份，删 intent 并记 warn', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'M-2026-09-20.md');
    const tmpPath = path.join(dir, '.M-2026-09-20.md.abc.tmp');
    const backupPath = path.join(dir, '.M-2026-09-20.md.abc.bak');
    writeFileSync(target, '旧内容\n');
    writeFileSync(tmpPath, '新内容\n');
    writeFileSync(backupPath, '旧内容\n');
    await beginIntent(dir, payloadFor([{ path: target, tmpPath, backupPath }]));

    /** @type {Array<{ code: string, message: string }>} */
    const warned = [];
    /** @type {string[]} */
    const infos = [];
    const result = await converge(dir, {
      warn: (warning) => warned.push(warning),
      info: (message) => infos.push(message),
    });

    assert.equal(result.recovered, 'rolled-forward');
    assert.equal(result.degraded, false);
    assert.equal(readFileSync(target, 'utf8'), '新内容\n');
    assert.equal(existsSync(tmpPath), false);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(intentPathIn(dir)), false);
    assert.ok(result.warnings.some((warning) => warning.code === 'intent-recovered'));
    assert.equal(warned.length, result.warnings.length);
    assert.ok(infos.some((message) => message.includes('前滚')));
    assert.deepEqual(result.applied, [{ path: target, action: 'forward' }]);
  });

  test('多文件前滚：全部换成新版本', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'archive'), { recursive: true });
    const files = [
      { path: path.join(dir, 'M-2026-09-20.md'), tmpPath: path.join(dir, '.1.tmp'), backupPath: path.join(dir, '.1.bak') },
      { path: path.join(dir, 'JOURNAL-2026-09-20.md'), tmpPath: path.join(dir, '.2.tmp'), backupPath: path.join(dir, '.2.bak') },
      { path: path.join(dir, 'archive', 'M-2026-09-19.md'), tmpPath: path.join(dir, '.3.tmp'), backupPath: path.join(dir, '.3.bak') },
    ];
    writeFileSync(files[0].path, '旧1\n');
    writeFileSync(files[1].path, '旧2\n');
    writeFileSync(files[2].path, '旧3\n');
    for (const file of files) {
      writeFileSync(file.tmpPath, `新-${path.basename(file.path)}\n`);
      writeFileSync(file.backupPath, '旧\n');
    }
    await beginIntent(dir, payloadFor(files));

    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-forward');
    assert.equal(readFileSync(files[0].path, 'utf8'), '新-M-2026-09-20.md\n');
    assert.equal(readFileSync(files[1].path, 'utf8'), '新-JOURNAL-2026-09-20.md\n');
    assert.equal(readFileSync(files[2].path, 'utf8'), '新-M-2026-09-19.md\n');
    assert.equal(result.applied?.length, 3);
  });

  test('files 为空的前滚：直接删 intent', async () => {
    const dir = tempDir();
    await beginIntent(dir, payloadFor([]));
    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-forward');
    assert.equal(existsSync(intentPathIn(dir)), false);
  });
});

describe('converge：回滚（新内容拿不到了 → 还原原内容副本）', () => {
  test('临时文件不可用（是目录）且目标仍是旧内容 → 走回滚路径但不做无谓覆盖', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'M-2026-09-20.md');
    const tmpPath = path.join(dir, '.tmp-as-dir');
    const backupPath = path.join(dir, '.bak');
    writeFileSync(target, '旧内容\n');
    writeFileSync(backupPath, '旧内容\n');
    mkdirSync(tmpPath);
    await beginIntent(dir, payloadFor([{ path: target, tmpPath, backupPath }]));

    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-back');
    assert.equal(readFileSync(target, 'utf8'), '旧内容\n');
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(intentPathIn(dir)), false);
  });

  test('部分已生效、其余新内容也丢了 → 整体回滚到旧版本（全成或全败）', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'archive'), { recursive: true });
    const a = path.join(dir, 'M-2026-09-20.md');
    const b = path.join(dir, 'archive', 'M-2026-09-19.md');
    const aTmp = path.join(dir, '.a.tmp');
    const bTmp = path.join(dir, '.b.tmp');
    const aBak = path.join(dir, '.a.bak');
    const bBak = path.join(dir, '.b.bak');

    // 崩溃前的真实状态：两个临时文件都写好了、intent 也落了
    writeFileSync(a, 'A-旧\n');
    writeFileSync(aTmp, 'A-新\n');
    writeFileSync(aBak, 'A-旧\n');
    writeFileSync(b, 'B-旧\n');
    writeFileSync(bTmp, 'B-新\n');
    writeFileSync(bBak, 'B-旧\n');
    await beginIntent(
      dir,
      payloadFor([
        { path: a, tmpPath: aTmp, backupPath: aBak },
        { path: b, tmpPath: bTmp, backupPath: bBak },
      ]),
    );

    // 崩溃：a 已经 rename 过（目标=新内容、临时文件被消费），b 的新内容也丢了
    writeFileSync(a, 'A-新\n');
    rmSync(aTmp);
    rmSync(bTmp);

    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-back');
    assert.equal(readFileSync(a, 'utf8'), 'A-旧\n', '已生效的那半也要回到旧版本');
    assert.equal(readFileSync(b, 'utf8'), 'B-旧\n');
    assert.equal(existsSync(aBak), false);
    assert.equal(existsSync(bBak), false);
    assert.equal(existsSync(intentPathIn(dir)), false);
    assert.ok(result.warnings.some((warning) => warning.code === 'intent-recovered'));
  });

  test('回滚时目标原本不存在（无备份）→ 删除新建的文件', async () => {
    const dir = tempDir();
    const created = path.join(dir, 'JOURNAL-2026-09-20.md');
    const createdTmp = path.join(dir, '.j.tmp');
    const other = path.join(dir, 'M-2026-09-20.md');
    const otherTmp = path.join(dir, '.m.tmp');
    const otherBak = path.join(dir, '.m.bak');

    writeFileSync(createdTmp, '新建内容\n');
    writeFileSync(other, '旧内容\n');
    writeFileSync(otherTmp, '新内容\n');
    writeFileSync(otherBak, '旧内容\n');
    await beginIntent(
      dir,
      payloadFor([
        { path: created, tmpPath: createdTmp, backupPath: path.join(dir, '.j.bak') },
        { path: other, tmpPath: otherTmp, backupPath: otherBak },
      ]),
    );

    // 崩溃：新建文件已生效（临时文件被消费），另一个文件的新内容丢了 → 无法前滚
    writeFileSync(created, '新建内容\n');
    rmSync(createdTmp);
    rmSync(otherTmp);

    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-back');
    assert.equal(existsSync(created), false, '原本不存在的目标，回滚即删除');
    assert.equal(readFileSync(other, 'utf8'), '旧内容\n');
    assert.equal(existsSync(intentPathIn(dir)), false);
  });
});

describe('converge：指纹守卫（绝不覆盖收敛点之前的人工编辑）', () => {
  test('回滚前发现目标被人工改动 → 不覆盖、保留 intent、degraded + write-conflict', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'M-2026-09-20.md');
    const tmpPath = path.join(dir, '.t.tmp');
    const backupPath = path.join(dir, '.t.bak');

    // 崩溃前的真实状态：目标是旧内容、tmp 是新内容、备份是旧内容
    writeFileSync(target, '旧内容\n');
    writeFileSync(tmpPath, '新内容\n');
    writeFileSync(backupPath, '旧内容\n');
    await beginIntent(dir, payloadFor([{ path: target, tmpPath, backupPath }]));

    // 崩溃后、下一个收敛点之前：临时文件丢了，且有人手工编辑了目标
    rmSync(tmpPath);
    writeFileSync(target, '人工编辑后的内容\n');

    /** @type {Array<{ code: string, message: string }>} */
    const warned = [];
    const result = await converge(dir, {
      warn: (warning) => warned.push(warning),
    });

    assert.equal(result.recovered, false);
    assert.equal(result.degraded, true, '无法安全回滚 → 必须返回 degraded');
    assert.equal(readFileSync(target, 'utf8'), '人工编辑后的内容\n', '绝不覆盖人工编辑');
    assert.equal(existsSync(intentPathIn(dir)), true, 'intent 必须保留，交人工处理');
    assert.ok(result.warnings.some((warning) => warning.code === 'write-conflict'));
    assert.ok(result.warnings.some((warning) => warning.message.includes('人工改动')));
    assert.equal(warned.length, result.warnings.length);
  });

  test('前滚前发现目标被人工改动 → 不覆盖、保留 intent、degraded', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'M-2026-09-20.md');
    const tmpPath = path.join(dir, '.t.tmp');
    const backupPath = path.join(dir, '.t.bak');
    writeFileSync(target, '旧内容\n');
    writeFileSync(tmpPath, '新内容\n');
    writeFileSync(backupPath, '旧内容\n');
    await beginIntent(dir, payloadFor([{ path: target, tmpPath, backupPath }]));

    // 崩溃后、收敛点之前：目标被人工编辑（临时文件仍在，因此走的是前滚路径）
    writeFileSync(target, '人工编辑后的内容\n');

    const result = await converge(dir);
    assert.equal(result.recovered, false);
    assert.equal(result.degraded, true);
    assert.equal(readFileSync(target, 'utf8'), '人工编辑后的内容\n', '绝不覆盖人工编辑');
    assert.equal(existsSync(intentPathIn(dir)), true);
    assert.ok(result.warnings.some((warning) => warning.code === 'write-conflict'));
  });

  test('全部文件已是新版本（临时文件已被 rename 消费）→ 视为已生效：提交，不回滚', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'M-2026-09-20.md');
    const tmpPath = path.join(dir, '.t.tmp');
    const backupPath = path.join(dir, '.t.bak');
    writeFileSync(target, '旧内容\n');
    writeFileSync(tmpPath, '新内容\n');
    writeFileSync(backupPath, '旧内容\n');
    await beginIntent(dir, payloadFor([{ path: target, tmpPath, backupPath }]));

    // 模拟：rename 全部完成，进程在"删除 intent"之前被杀
    writeFileSync(target, '新内容\n');
    rmSync(tmpPath);

    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-forward');
    assert.equal(result.degraded, false);
    assert.equal(readFileSync(target, 'utf8'), '新内容\n', '已完成的写入绝不能被撤销');
    assert.equal(existsSync(backupPath), false, '提交后清理备份');
    assert.equal(existsSync(intentPathIn(dir)), false, '视为已提交');
    assert.ok(result.warnings.some((warning) => warning.code === 'intent-recovered'));
  });

  test('部分文件已生效、其余临时文件仍在 → 先补齐到新版本（前滚）', async () => {
    const dir = tempDir();
    const a = path.join(dir, 'M-2026-09-20.md');
    const b = path.join(dir, 'M-2026-09-19.md');
    const aTmp = path.join(dir, '.a.tmp');
    const bTmp = path.join(dir, '.b.tmp');
    const aBak = path.join(dir, '.a.bak');
    const bBak = path.join(dir, '.b.bak');
    writeFileSync(a, 'A-旧\n');
    writeFileSync(aTmp, 'A-新\n');
    writeFileSync(aBak, 'A-旧\n');
    writeFileSync(b, 'B-旧\n');
    writeFileSync(bTmp, 'B-新\n');
    writeFileSync(bBak, 'B-旧\n');
    await beginIntent(
      dir,
      payloadFor([
        { path: a, tmpPath: aTmp, backupPath: aBak },
        { path: b, tmpPath: bTmp, backupPath: bBak },
      ]),
    );

    // a 已 rename 且临时文件仍在（异常但可能：rename 与删除之间被杀）→ 收敛应补齐 b
    writeFileSync(a, 'A-新\n');

    const result = await converge(dir);
    assert.equal(result.recovered, 'rolled-forward');
    assert.equal(readFileSync(a, 'utf8'), 'A-新\n');
    assert.equal(readFileSync(b, 'utf8'), 'B-新\n');
    assert.equal(existsSync(intentPathIn(dir)), false);
  });
});

describe('converge：无法收敛时绝不静默覆盖', () => {
  test('intent.json 内容不是合法 JSON → degraded，保留 intent，不动数据', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.state'), { recursive: true });
    const intentPath = intentPathIn(dir);
    writeFileSync(intentPath, '{ 这不是 JSON');

    const result = await converge(dir);
    assert.equal(result.recovered, false);
    assert.equal(result.degraded, true);
    assert.equal(result.intentPath, intentPath);
    assert.ok(result.warnings.some((warning) => warning.code === 'intent-recovered'));
    assert.equal(existsSync(intentPath), true, 'intent 必须保留，等人工处理');
  });

  test('intent.json 结构非法 → degraded 且保留文件', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.state'), { recursive: true });
    writeFileSync(intentPathIn(dir), JSON.stringify({ version: 2, op: 'batch', files: [] }));

    const result = await converge(dir);
    assert.equal(result.degraded, true);
    assert.equal(existsSync(intentPathIn(dir)), true);
  });

  test('intent.json 是空文件 → degraded 且保留文件', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.state'), { recursive: true });
    writeFileSync(intentPathIn(dir), '');

    const result = await converge(dir);
    assert.equal(result.degraded, true);
    assert.equal(existsSync(intentPathIn(dir)), true);
  });

  test('intent.json 读不出（是目录）→ degraded 且保留', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.state', 'intent.json'), { recursive: true });

    const result = await converge(dir);
    assert.equal(result.degraded, true);
    assert.equal(existsSync(intentPathIn(dir)), true);
  });
});
