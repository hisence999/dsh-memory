/**
 * `store` 集成测试：loadProject / applyBatch / syncAtBoundary / rebuildIndex / recordUsage。
 *
 * 覆盖任务验收点：归档单条不影响同日其他条目、恢复回填归档前状态并删除三字段、
 * supersedes 原子替换不产生双活、无编号条目补发并写回、INDEX.md 可从活动记忆重建、
 * intent 残留收敛（前滚/回滚）、锁超时返回 locked、写冲突绝不覆盖、日志只追加。
 *
 * 全部在 `fs.mkdtempSync(os.tmpdir())` 临时目录里进行，绝不触碰真实项目目录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../src/config.js';
import { beginIntent } from '../src/intent.js';
import { buildSnapshot } from '../src/snapshot.js';
import { applyBatch, loadProject, rebuildIndex, recordUsage, syncAtBoundary } from '../src/store.js';

/** 固定的"今天"与"此刻"，让归档时间等产物可断言 */
const TODAY = '2026-09-20';
const NOW = new Date('2026-09-20T14:32:00');

/**
 * 测试用配置（默认值来自 config.js，只覆盖需要变化的键）
 *
 * @param {Record<string, unknown>} overrides
 * @returns {typeof DEFAULTS}
 */
function configWith(overrides) {
  return { ...DEFAULTS, ...overrides };
}

/** @type {string[]} */
const temps = [];

/** 建一个临时项目目录（含 `memory/`） */
function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  const memoryDir = path.join(dir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  return { dir, memoryDir };
}

/**
 * 写一个活动记忆文件
 *
 * @param {string} memoryDir
 * @param {string} date
 * @param {string} body
 * @returns {string} 文件路径
 */
function writeMemory(memoryDir, date, body) {
  const file = path.join(memoryDir, `M-${date}.md`);
  writeFileSync(file, `# 记忆 · ${date}\n\n${body}`);
  return file;
}

/**
 * 写一个归档记忆文件
 *
 * @param {string} memoryDir
 * @param {string} date
 * @param {string} body
 * @returns {string} 文件路径
 */
function writeArchived(memoryDir, date, body) {
  const archiveDir = path.join(memoryDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const file = path.join(archiveDir, `M-${date}.md`);
  writeFileSync(file, `# 记忆 · ${date}\n\n${body}`);
  return file;
}

/**
 * 读一次项目模型（只用只读入口）
 *
 * @param {string} dir
 * @param {Record<string, unknown>} [overrides]
 * @returns {Promise<import('../src/store.js').ProjectModel>}
 */
async function load(dir, overrides = {}) {
  return loadProject({ workspace: dir, config: configWith(overrides) });
}

/** 目录里有没有临时/备份残留
 *
 * @param {string} memoryDir
 * @returns {string[]}
 */
function leftovers(memoryDir) {
  return readdirSync(memoryDir, { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'));
}

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录。
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

/** 两天的固定夹具：9-19 有 #0003 与 #0004
 *
 * @param {string} memoryDir
 */
function seedTwoEntries(memoryDir) {
  writeMemory(
    memoryDir,
    '2026-09-19',
    `## 事实
- [#0003] 旧事实：web profile 使用 3080 端口
  - 标签：port
  - 创建：2026-09-19

- [#0004] 同一天的另一条记忆
  - 创建：2026-09-19
`,
  );
}

describe('loadProject：只读扫描', () => {
  test('项目根 = 工作区根（不向上搜 .git）；memory/ 不存在时不创建、返回空模型', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
    temps.push(dir);
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    const workspace = path.join(dir, 'sub');
    mkdirSync(workspace);

    const model = await load(workspace);
    assert.equal(model.projectRoot, path.resolve(workspace));
    assert.equal(model.memoryDir, path.join(path.resolve(workspace), 'memory'));
    assert.deepEqual(model.entries, []);
    assert.deepEqual(model.active, []);
    assert.deepEqual(model.archived, []);
    assert.deepEqual(model.journals, []);
    assert.equal(model.nextId, 0);
    assert.equal(existsSync(path.join(workspace, 'memory')), false, '只读路径不得创建目录');
  });

  test('水位线 = max(.state/ids, INDEX.md 注记, 活动编号, 归档编号)', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    writeArchived(
      memoryDir,
      '2026-09-18',
      `## 事实
- [#0009] 归档区里的高编号
  - 状态：archived
  - 归档前状态：active
`,
    );
    writeFileSync(path.join(memoryDir, 'INDEX.md'), '# 项目记忆索引\n\nnext-id: 0021\n');
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    writeFileSync(path.join(memoryDir, '.state', 'ids'), '0030\n');

    const model = await load(dir);
    assert.equal(model.nextId, 30);
    assert.equal(model.active.length, 2);
    assert.equal(model.archived.length, 1);
  });

  test('损坏/无法解析的文件被隔离，其余记忆照常可用', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    writeFileSync(path.join(memoryDir, 'M-2026-09-17.md'), '# 记忆 · 2026-09-17\n\n这行既不是分节也不是条目\n');

    const model = await load(dir);
    assert.equal(model.entries.length, 2);
    assert.ok(model.warnings.some((warning) => warning.code === 'empty-file' || warning.code === 'free-field'));
  });

  test('重复编号与手工超限在扫描期只报告、不改文件', async () => {
    const { dir, memoryDir } = makeProject();
    const file = writeMemory(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0003] 第一条
- [#0003] 手工复制出来的第二条
`,
    );
    const before = readFileSync(file, 'utf8');

    const model = await load(dir);
    assert.ok(model.warnings.some((warning) => warning.code === 'manual-edit-detected' && warning.id === '#0003'));
    assert.equal(readFileSync(file, 'utf8'), before, '读路径绝不改文件');
  });
});

describe('applyBatch：写入', () => {
  test('分配编号、写回文件、重建 INDEX.md、落水位线，且不留残留', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const model = await load(dir);
    const result = await applyBatch(
      model,
      [{ type: 'write', entries: [{ kind: 'fact', title: 'web profile 现在用 3180 端口', detail: '换端口了' }] }],
      { config: configWith({}), today: TODAY, now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.result.assignedIds, ['#0005']);
    assert.deepEqual(result.result.paths.length > 0, true);

    const todayFile = readFileSync(path.join(memoryDir, `M-${TODAY}.md`), 'utf8');
    assert.ok(todayFile.includes('[#0005] web profile 现在用 3180 端口'));
    assert.ok(todayFile.includes('详细：换端口了'));

    assert.equal(readFileSync(path.join(memoryDir, '.state', 'ids'), 'utf8'), '5\n');
    const index = readFileSync(path.join(memoryDir, 'INDEX.md'), 'utf8');
    assert.ok(index.includes('next-id: 0005'));
    assert.ok(index.includes('[#0005] 事实 · web profile 现在用 3180 端口 · 状态 active'));

    assert.equal(existsSync(path.join(memoryDir, '.state', 'intent.json')), false);
    assert.deepEqual(leftovers(memoryDir), []);
  });

  test('任何一条校验失败 → 整批不写入，并按 entry 序号指出原因', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    const before = readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8');

    const model = await load(dir);
    const result = await applyBatch(
      model,
      [
        {
          type: 'write',
          entries: [
            { kind: 'fact', title: '这一条是合法的' },
            { kind: 'fact', title: '   ' },
          ],
        },
      ],
      { config: configWith({}), today: TODAY, now: NOW },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'invalid_param');
    assert.equal(result.entryIndex, 1);
    assert.equal(existsSync(path.join(memoryDir, `M-${TODAY}.md`)), false, '整批不写入');
    assert.equal(existsSync(path.join(memoryDir, '.state', 'ids')), false);
    assert.equal(readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8'), before);
  });

  test('超长标题 → too_long；有效至早于今天 → invalid_param', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    const model = await load(dir);

    const tooLong = await applyBatch(model, [{ type: 'write', entries: [{ kind: 'fact', title: 'x'.repeat(200) }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.equal(tooLong.code, 'too_long');

    const expired = await applyBatch(model, [{ type: 'write', entries: [{ kind: 'fact', title: '有效至过期', expiresAt: '2026-09-01' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.code, 'invalid_param');
      assert.ok(expired.message.includes('有效至不得早于今天'));
    }
  });

  test('supersedes：一次调用完成新增 + 取代，不产生双活', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const model = await load(dir);
    const result = await applyBatch(
      model,
      [
        {
          type: 'write',
          entries: [{ kind: 'fact', title: 'web profile 监听 3180 端口', supersedes: ['#0003'] }],
        },
      ],
      { config: configWith({}), today: TODAY, now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.result.assignedIds, ['#0005']);

    const old = readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8');
    assert.ok(old.includes('状态：superseded'));
    assert.ok(old.includes('取代者：#0005'));
    assert.ok(old.includes('[#0003] 旧事实：web profile 使用 3080 端口'), '旧条目正文不修改');

    const fresh = readFileSync(path.join(memoryDir, `M-${TODAY}.md`), 'utf8');
    assert.ok(fresh.includes('取代：#0003'));

    const index = readFileSync(path.join(memoryDir, 'INDEX.md'), 'utf8');
    assert.ok(index.includes('[#0003] 事实 · 旧事实：web profile 使用 3080 端口 · 状态 superseded'));
    assert.ok(index.includes('[#0005] 事实 · web profile 监听 3180 端口 · 状态 active'));
  });

  test('supersedes 指向已取代的编号 → conflict；同一批两条指向同一旧编号 → conflict', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    let model = await load(dir);
    const first = await applyBatch(model, [{ type: 'write', entries: [{ kind: 'fact', title: '第一轮取代', supersedes: ['#0003'] }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(first.ok, true);

    model = await load(dir);
    const again = await applyBatch(model, [{ type: 'write', entries: [{ kind: 'fact', title: '再取代一次', supersedes: ['#0003'] }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.code, 'conflict');
    assert.ok(again.message.includes('#0005'), '提示应指向当前取代者');

    model = await load(dir);
    const sameBatch = await applyBatch(
      model,
      [
        {
          type: 'write',
          entries: [
            { kind: 'fact', title: '新条目一', supersedes: ['#0004'] },
            { kind: 'fact', title: '新条目二', supersedes: ['#0004'] },
          ],
        },
      ],
      { config: configWith({}), today: TODAY, now: NOW },
    );
    assert.equal(sameBatch.ok, false);
    if (!sameBatch.ok) assert.equal(sameBatch.code, 'conflict');
  });
});

describe('applyBatch：归档与恢复', () => {
  test('归档只移走目标那一条，同日其他条目不动', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const model = await load(dir);
    const result = await applyBatch(model, [{ type: 'archive', ids: ['#0003'], reason: '端口已改' }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.result.archived, ['#0003']);

    const active = readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8');
    assert.equal(active.includes('#0003'), false);
    assert.ok(active.includes('[#0004] 同一天的另一条记忆'), '同日其他条目必须原地不动');

    const archived = readFileSync(path.join(memoryDir, 'archive', 'M-2026-09-19.md'), 'utf8');
    assert.ok(archived.includes('[#0003] 旧事实：web profile 使用 3080 端口'));
    assert.ok(archived.includes('状态：archived'));
    assert.ok(archived.includes('归档前状态：active'));
    assert.ok(archived.includes('归档时间：2026-09-20 14:32'));
    assert.ok(archived.includes('归档原因：端口已改'));

    const index = readFileSync(path.join(memoryDir, 'INDEX.md'), 'utf8');
    assert.equal(index.includes('#0003'), false, '归档条目不出现在 INDEX.md');
    assert.ok(index.includes('#0004'));
    assert.equal(readFileSync(path.join(memoryDir, '.state', 'ids'), 'utf8'), '4\n');
    assert.deepEqual(leftovers(memoryDir), []);
  });

  test('恢复：回填归档前状态并删除归档时间/归档原因/归档前状态三个字段', async () => {
    const { dir, memoryDir } = makeProject();
    writeArchived(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0003] 归档条目（原状态 candidate）
  - 状态：archived
  - 归档前状态：candidate
  - 归档时间：2026-09-18 10:00
  - 归档原因：等待复核
`,
    );
    writeMemory(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0004] 活动区的另一条记忆
`,
    );

    const model = await load(dir);
    const result = await applyBatch(model, [{ type: 'restore', ids: ['#0003'] }], { config: configWith({}), today: TODAY, now: NOW });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.result.restored, ['#0003']);

    const restored = readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8');
    assert.ok(restored.includes('[#0003] 归档条目（原状态 candidate）'));
    assert.ok(restored.includes('状态：candidate'), '归档前状态回填到状态');
    assert.equal(restored.includes('归档前状态'), false);
    assert.equal(restored.includes('归档时间'), false);
    assert.equal(restored.includes('归档原因'), false);

    const archived = readFileSync(path.join(memoryDir, 'archive', 'M-2026-09-19.md'), 'utf8');
    assert.equal(archived.includes('#0003'), false, '归档区里该条已移出');

    const index = readFileSync(path.join(memoryDir, 'INDEX.md'), 'utf8');
    assert.ok(index.includes('[#0003] 事实 · 归档条目（原状态 candidate） · 状态 candidate'));
  });

  test('恢复前置检查：与活动记忆标题精确重复 → conflict，且不动文件', async () => {
    const { dir, memoryDir } = makeProject();
    writeArchived(
      memoryDir,
      '2026-09-18',
      `## 事实
- [#0009] 重复的标题
  - 状态：archived
  - 归档前状态：active
`,
    );
    writeMemory(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0003] 重复的标题
`,
    );
    const activeBefore = readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8');
    const archivedBefore = readFileSync(path.join(memoryDir, 'archive', 'M-2026-09-18.md'), 'utf8');

    const model = await load(dir);
    const result = await applyBatch(model, [{ type: 'restore', ids: ['#0009'] }], { config: configWith({}), today: TODAY, now: NOW });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'conflict');
    assert.equal(readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8'), activeBefore);
    assert.equal(readFileSync(path.join(memoryDir, 'archive', 'M-2026-09-18.md'), 'utf8'), archivedBefore);
  });

  test('恢复前置检查：字段不可容纳（归档前状态非法）→ invalid_param，原样留在归档区', async () => {
    const { dir, memoryDir } = makeProject();
    writeArchived(
      memoryDir,
      '2026-09-18',
      `## 事实
- [#0009] 状态字段坏掉的归档条目
  - 状态：archived
`,
    );
    writeMemory(memoryDir, '2026-09-19', '## 事实\n- [#0003] 活动条目\n');

    const model = await load(dir);
    const result = await applyBatch(model, [{ type: 'restore', ids: ['#0009'] }], { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'invalid_param');
    assert.ok(readFileSync(path.join(memoryDir, 'archive', 'M-2026-09-18.md'), 'utf8').includes('#0009'));
  });

  test('重复编号会被扫描期修复，恢复只能用修复后的编号（旧编号 → not_found）', async () => {
    const { dir, memoryDir } = makeProject();
    writeArchived(
      memoryDir,
      '2026-09-18',
      `## 事实
- [#0003] 归档区里的 #0003
  - 状态：archived
  - 归档前状态：active
`,
    );
    seedTwoEntries(memoryDir); // 活动区同样有 #0003

    const model = await load(dir);
    const result = await applyBatch(model, [{ type: 'restore', ids: ['#0003'] }], { config: configWith({}), today: TODAY, now: NOW });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'not_found');
    assert.ok(result.warnings.some((warning) => warning.code === 'duplicate-id-repaired'));
  });
});

describe('applyBatch：编辑', () => {
  test('改状态/类型/标签、清空详细、刷新更新日期，并按类型移动分节', async () => {
    const { dir, memoryDir } = makeProject();
    writeMemory(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0003] 待复核的事实
  - 详细：旧的详细内容
  - 标签：port
`,
    );

    const model = await load(dir);
    const result = await applyBatch(
      model,
      [{ type: 'edit', edits: [{ id: '#0003', kind: 'lesson', status: 'candidate', tags: ['port', '热加载'], detail: null }] }],
      { config: configWith({}), today: TODAY, now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const file = readFileSync(path.join(memoryDir, 'M-2026-09-19.md'), 'utf8');
    assert.ok(file.includes('## 经验'), 'kind 变更后移动到目标分节');
    assert.equal(file.includes('## 事实'), false, '原来的空分节不保留');
    assert.ok(file.includes('状态：candidate'));
    assert.ok(file.includes('标签：port, 热加载'));
    assert.ok(file.includes('更新：2026-09-20'));
    assert.equal(file.includes('详细'), false, 'detail: null 清空详细');
    assert.ok(file.includes('[#0003] 待复核的事实'));
  });

  test('编号不存在 / 目标已归档 → not_found', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    writeArchived(memoryDir, '2026-09-18', '## 事实\n- [#0009] 归档条目\n  - 状态：archived\n  - 归档前状态：active\n');

    const model = await load(dir);
    const missing = await applyBatch(model, [{ type: 'edit', edits: [{ id: '#0999', detail: 'x' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'not_found');

    const archived = await applyBatch(model, [{ type: 'edit', edits: [{ id: '#0009', detail: 'x' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(archived.ok, false);
    if (!archived.ok) {
      assert.equal(archived.code, 'not_found');
      assert.ok(archived.message.includes('restore'));
    }
  });
});

describe('syncAtBoundary：扫描期写回（§6.1）', () => {
  test('补发无编号条目的编号并写回，再跑一次幂等', async () => {
    const { dir, memoryDir } = makeProject();
    const file = writeMemory(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0003] 有编号的条目
- 手工新增的无编号条目
`,
    );

    const model = await load(dir);
    const first = await syncAtBoundary(model, { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(first.ok, true);
    assert.equal(first.wrote, true);
    assert.ok(first.warnings.some((warning) => warning.code === 'missing-id-assigned'));
    assert.ok(first.warnings.some((warning) => warning.code === 'index-rebuilt'));

    const written = readFileSync(file, 'utf8');
    assert.ok(written.includes('[#0004] 手工新增的无编号条目'));
    assert.ok(existsSync(path.join(memoryDir, 'INDEX.md')));
    assert.equal(readFileSync(path.join(memoryDir, '.state', 'ids'), 'utf8'), '4\n');
    assert.deepEqual(leftovers(memoryDir), []);

    // 幂等：再跑一次没有任何变化
    const second = await syncAtBoundary(await load(dir), { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(second.ok, true);
    assert.equal(second.wrote, false);
    assert.deepEqual(second.warnings, []);
  });

  test('重复编号被重发并写回，且新号高于水位线', async () => {
    const { dir, memoryDir } = makeProject();
    const file = writeMemory(
      memoryDir,
      '2026-09-19',
      `## 事实
- [#0003] 第一条
- [#0003] 手工复制出来的第二条
`,
    );

    const model = await load(dir);
    const synced = await syncAtBoundary(model, { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(synced.ok, true);
    const repaired = synced.warnings.filter((warning) => warning.code === 'duplicate-id-repaired');
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0].id, '#0004');

    const written = readFileSync(file, 'utf8');
    assert.ok(written.includes('[#0003] 第一条'));
    assert.ok(written.includes('[#0004] 手工复制出来的第二条'));
  });

  test('会话边界写回不会在无关项目里创建 memory/（没有记忆就不建目录）', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
    temps.push(dir);

    const model = await load(dir);
    const synced = await syncAtBoundary(model, { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(synced.ok, true);
    assert.equal(synced.wrote, false);
    assert.equal(existsSync(path.join(dir, 'memory')), false);
  });
});

describe('rebuildIndex：显式重建', () => {
  test('删掉 INDEX.md 后能重建出等价内容与等价顺序', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const model = await load(dir);
    const written = await applyBatch(model, [{ type: 'write', entries: [{ kind: 'convention', title: '约定 A' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(written.ok, true);

    const indexPath = path.join(memoryDir, 'INDEX.md');
    const before = readFileSync(indexPath, 'utf8');
    rmSync(indexPath);

    const rebuilt = await rebuildIndex(await load(dir), { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) return;
    assert.equal(rebuilt.wrote, true);
    assert.equal(readFileSync(indexPath, 'utf8'), before);
  });
});

describe('applyBatch：intent 残留收敛（§12.1）', () => {
  test('临时文件仍在 → 前滚，并在返回里带 intent-recovered', async () => {
    const { dir, memoryDir } = makeProject();
    const target = writeMemory(memoryDir, '2026-09-19', '## 事实\n- [#0003] 旧内容\n');
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });

    const tmpPath = path.join(memoryDir, '.M-2026-09-19.md.crash.tmp');
    const backupPath = path.join(memoryDir, '.M-2026-09-19.md.crash.bak');
    writeFileSync(tmpPath, '# 记忆 · 2026-09-19\n\n## 事实\n- [#0009] 前滚后的条目\n');
    writeFileSync(backupPath, readFileSync(target, 'utf8'));
    writeFileSync(
      path.join(memoryDir, '.state', 'intent.json'),
      `${JSON.stringify({ version: 1, op: 'batch', createdAt: '2026-09-20T10:00:00.000Z', files: [{ path: target, tmpPath, backupPath }] }, null, 2)}\n`,
    );

    const result = await applyBatch(
      await load(dir),
      [{ type: 'write', entries: [{ kind: 'fact', title: '新写入的条目' }] }],
      { config: configWith({}), today: TODAY, now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.warnings.some((warning) => warning.code === 'intent-recovered'));
    // 前滚后的内容被重读，因此新编号接着 #0009 走
    assert.deepEqual(result.result.assignedIds, ['#0010']);
    const content = readFileSync(target, 'utf8');
    assert.ok(content.includes('[#0009] 前滚后的条目'));
    assert.equal(existsSync(tmpPath), false);
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(path.join(memoryDir, '.state', 'intent.json')), false);
  });

  test('部分已生效、其余新内容已丢 → 回滚到备份内容（整体回到旧版本）', async () => {
    const { dir, memoryDir } = makeProject();
    const applied = writeMemory(memoryDir, '2026-09-19', '## 事实\n- [#0003] 已生效的新内容\n');
    const pending = writeMemory(memoryDir, '2026-09-20', '## 事实\n- [#0004] 还没动的内容\n');
    const appliedBak = path.join(memoryDir, '.a.bak');
    const appliedTmp = path.join(memoryDir, '.a.tmp');
    const pendingBak = path.join(memoryDir, '.b.bak');
    const pendingTmp = path.join(memoryDir, '.b.tmp');
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    // 崩溃前的真实状态：两个临时文件都写好、intent 已落
    writeFileSync(appliedBak, '# 记忆 · 2026-09-19\n\n## 事实\n- [#0003] 备份中的旧内容\n');
    writeFileSync(appliedTmp, readFileSync(applied, 'utf8'));
    writeFileSync(pendingBak, readFileSync(pending, 'utf8'));
    writeFileSync(pendingTmp, '# 记忆 · 2026-09-20\n\n## 事实\n- [#0004] 本来要写的新内容\n');
    const begun = await beginIntent(memoryDir, {
      version: 1,
      op: 'batch',
      createdAt: '2026-09-20T10:00:00.000Z',
      files: [
        { path: applied, tmpPath: appliedTmp, backupPath: appliedBak },
        { path: pending, tmpPath: pendingTmp, backupPath: pendingBak },
      ],
    });
    assert.equal(begun.ok, true);
    // 崩溃：第一个已 rename（临时文件被消费），第二个的新内容丢了 → 无法前滚
    rmSync(appliedTmp);
    rmSync(pendingTmp);

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '新条目' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.warnings.some((warning) => warning.code === 'intent-recovered'));
    const content = readFileSync(applied, 'utf8');
    assert.ok(content.includes('[#0003] 备份中的旧内容'), '已生效的那半也要回到旧版本');
    assert.equal(content.includes('已生效的新内容'), false);
    assert.equal(readFileSync(pending, 'utf8').includes('还没动的内容'), true);
  });

  test('上次写入已完成但 intent 未删除（删除失败/被杀）→ 下次收敛提交，不回滚已完成写入', async () => {
    const { dir, memoryDir } = makeProject();
    const target = writeMemory(memoryDir, '2026-09-19', '## 事实\n- [#0003] 旧内容\n');
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    const tmpPath = path.join(memoryDir, '.M-2026-09-19.md.crash.tmp');
    const backupPath = path.join(memoryDir, '.M-2026-09-19.md.crash.bak');
    const newContent = '# 记忆 · 2026-09-19\n\n## 事实\n- [#0009] 已经落盘的新内容\n';
    writeFileSync(backupPath, readFileSync(target, 'utf8'));
    writeFileSync(tmpPath, newContent);
    const begun = await beginIntent(memoryDir, {
      version: 1,
      op: 'batch',
      createdAt: '2026-09-20T10:00:00.000Z',
      files: [{ path: target, tmpPath, backupPath }],
    });
    assert.equal(begun.ok, true);

    // rename 全部完成，但 intent 没删掉（提交点没走完）
    writeFileSync(target, newContent);
    rmSync(tmpPath);

    const synced = await syncAtBoundary(await load(dir), { config: configWith({}), today: TODAY, now: NOW });
    assert.equal(synced.ok, true);
    assert.ok(synced.warnings.some((warning) => warning.code === 'intent-recovered'));
    assert.equal(readFileSync(target, 'utf8'), newContent, '已完成的写入绝不能被回滚撤销');
    assert.equal(existsSync(backupPath), false);
    assert.equal(existsSync(path.join(memoryDir, '.state', 'intent.json')), false);
  });

  test('收敛点之前目标被人工改动 → 不覆盖、保留 intent 并返回 degraded（内容不丢）', async () => {
    const { dir, memoryDir } = makeProject();
    const target = writeMemory(memoryDir, '2026-09-19', '## 事实\n- [#0003] 旧内容\n');
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    const tmpPath = path.join(memoryDir, '.M-2026-09-19.md.crash.tmp');
    const backupPath = path.join(memoryDir, '.M-2026-09-19.md.crash.bak');
    writeFileSync(backupPath, readFileSync(target, 'utf8'));
    writeFileSync(tmpPath, '# 记忆 · 2026-09-19\n\n## 事实\n- [#0009] 崩溃前写的新内容\n');
    const begun = await beginIntent(memoryDir, {
      version: 1,
      op: 'batch',
      createdAt: '2026-09-20T10:00:00.000Z',
      files: [{ path: target, tmpPath, backupPath }],
    });
    assert.equal(begun.ok, true);

    // 崩溃后、收敛点之前：临时文件丢了 + 有人手工编辑了目标
    rmSync(tmpPath);
    writeFileSync(target, '# 记忆 · 2026-09-19\n\n## 事实\n- [#0003] 人工编辑后的内容\n');

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '这次不该写进去' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'degraded');
    assert.ok(readFileSync(target, 'utf8').includes('人工编辑后的内容'), '绝不覆盖人工编辑');
    assert.equal(existsSync(path.join(memoryDir, '.state', 'intent.json')), true, 'intent 保留交人工处理');
    assert.equal(existsSync(path.join(memoryDir, `M-${TODAY}.md`)), false);
    assert.ok(result.warnings.some((warning) => warning.code === 'write-conflict'));
  });
});

describe('applyBatch：锁与写冲突（§12）', () => {
  test('锁被别人持有时等待超时 → locked', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    const lockPath = path.join(memoryDir, '.state', 'lock');
    writeFileSync(lockPath, '{"pid":1}\n');

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '写不进去' }] }], {
      config: configWith({ lockTimeoutMs: 120 }),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'locked');
    assert.equal(existsSync(path.join(memoryDir, `M-${TODAY}.md`)), false);

    rmSync(lockPath);
    const retry = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '现在写得进去' }] }], {
      config: configWith({ lockTimeoutMs: 120 }),
      today: TODAY,
      now: NOW,
    });
    assert.equal(retry.ok, true);
  });

  test('写前发现文件被外部改动 → 重试两次后 write_conflict，绝不覆盖', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    const idsPath = path.join(memoryDir, '.state', 'ids');
    writeFileSync(idsPath, '3\n');

    let tamperCount = 0;
    /** 每次校验阶段都模拟"另一个进程/人"改掉将要写入的文件（内容每次不同） */
    const tamper = {
      findDuplicate: () => {
        tamperCount += 1;
        writeFileSync(idsPath, `外部改动-${tamperCount}\n`);
        return null;
      },
    };

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '不该被写进去' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
      validators: tamper,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'write_conflict');
    assert.equal(tamperCount, 3, '首写 + 最多两次重试');
    assert.equal(readFileSync(idsPath, 'utf8'), '外部改动-3\n', '绝不覆盖外部改动');
    assert.equal(existsSync(path.join(memoryDir, `M-${TODAY}.md`)), false);
    assert.equal(existsSync(path.join(memoryDir, '.state', 'intent.json')), false);
    assert.ok(result.warnings.some((warning) => warning.code === 'write-conflict'));
  });

  test('外部改动后重试：在新内容上重做修改，人工写的行不丢', async () => {
    const { dir, memoryDir } = makeProject();
    const todayFile = writeMemory(memoryDir, TODAY, '## 事实\n- [#0004] 今天已有的条目\n');

    let tampered = false;
    const tamper = {
      findDuplicate: () => {
        if (!tampered) {
          tampered = true;
          writeFileSync(todayFile, `${readFileSync(todayFile, 'utf8')}\n人工备注行\n`);
        }
        return null;
      },
    };

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '新增条目' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
      validators: tamper,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.warnings.some((warning) => warning.code === 'write-conflict'));
    const content = readFileSync(todayFile, 'utf8');
    assert.ok(content.includes('人工备注行'), '人工改动必须被保留（不是覆盖式写入）');
    assert.ok(content.includes('[#0004] 今天已有的条目'));
    assert.ok(content.includes('[#0005] 新增条目'));
  });
});

describe('applyBatch：日志与 usage', () => {
  test('日志只追加、编号唯一、文件自动创建，且不影响 INDEX.md', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const model = await load(dir);
    const result = await applyBatch(
      model,
      [
        {
          type: 'log',
          entries: [
            { title: '验证依赖热加载行为', content: '改了 profile patch，依赖清单变化仍需重启。', result: '确认需要重启', tags: ['bundle'] },
            { title: '同日第二条日志', content: '第二条内容', relatedMemoryIds: ['#0003'] },
          ],
        },
      ],
      { config: configWith({}), today: TODAY, now: NOW },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.journalIds.length, 2);
    assert.equal(result.result.journalIds[0], 'J-20260920-1432');
    assert.equal(result.result.journalIds[1], 'J-20260920-1432-2');

    const journal = readFileSync(path.join(memoryDir, `JOURNAL-${TODAY}.md`), 'utf8');
    assert.ok(journal.startsWith(`# 项目日志 · ${TODAY}\n`));
    assert.ok(journal.includes('## J-20260920-1432 · 验证依赖热加载行为'));
    assert.ok(journal.includes('- 内容：改了 profile patch，依赖清单变化仍需重启。'));
    assert.ok(journal.includes('- 结果：确认需要重启'));
    assert.ok(journal.includes('- 标签：bundle'));

    const index = readFileSync(path.join(memoryDir, 'INDEX.md'), 'utf8');
    assert.equal(index.includes('J-20260920'), false, '日志不进长期记忆索引');
  });

  test('第二节日志追加到已有日志文件末尾，保留人工写的内容', async () => {
    const { dir, memoryDir } = makeProject();
    const journalPath = path.join(memoryDir, `JOURNAL-${TODAY}.md`);
    writeFileSync(journalPath, `# 项目日志 · ${TODAY}\n\n人工写的备注\n`);

    const result = await applyBatch(await load(dir), [{ type: 'log', entries: [{ title: '新日志', content: '正文' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(result.ok, true);

    const journal = readFileSync(journalPath, 'utf8');
    assert.ok(journal.includes('人工写的备注'));
    assert.ok(journal.includes('## J-20260920-1432 · 新日志'));
  });

  test('recordUsage：累加计数并落盘（不影响搜索之外的任何东西）', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const model = await load(dir);
    const first = await recordUsage(model, ['#0003'], { now: new Date('2026-09-20T10:00:00.000Z') });
    assert.equal(first.ok, true);
    assert.equal(first.usage['#0003']?.count, 1);

    const second = await recordUsage(model, ['#0003', '#0004'], { now: new Date('2026-09-20T11:00:00.000Z') });
    assert.equal(second.usage['#0003']?.count, 2);
    assert.equal(second.usage['#0004']?.count, 1);
    assert.equal(second.usage['#0003']?.lastUsedAt, '2026-09-20T11:00:00.000Z');

    const onDisk = JSON.parse(readFileSync(path.join(memoryDir, '.state', 'usage.json'), 'utf8'));
    assert.equal(onDisk['#0003'].count, 2);
  });
});

describe('applyBatch：不主动整理（§5.5 第 9 条）', () => {
  test('未参与本次操作的文件一字不动（人工版式不被规范化）', async () => {
    const { dir, memoryDir } = makeProject();
    // 人工版式：`*` 列表标记、字段行缺少缩进、条目之间多个空行
    const raw = '# 记忆 · 2026-09-19\n\n## 事实\n* [#0003] 人工写的条目\n状态：active\n\n\n\n* [#0004] 人工写的第二条\n';
    const untouched = path.join(memoryDir, 'M-2026-09-19.md');
    writeFileSync(untouched, raw);

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '新条目' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(readFileSync(untouched, 'utf8'), raw, '没有参与本次操作的文件必须保留人工版式');
    // 真正被操作的文件照常写入
    assert.ok(readFileSync(path.join(memoryDir, `M-${TODAY}.md`), 'utf8').includes('[#0005] 新条目'));
  });

  test('只有本次改动的文件被写盘（paths 只含相关文件）', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    const other = writeMemory(memoryDir, '2026-09-18', '## 事实\n- [#0002] 与本次无关的条目\n');

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '只动今天这条' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.result.paths.includes(other), false, '无关文件不该出现在写入清单里');
    assert.ok(existsSync(path.join(memoryDir, `M-${TODAY}.md`)));
  });
});

describe('端到端：§14.53 编号复用降级', () => {
  test('两处水位线同时丢失 + 历史最大编号条目被删 → 复用发生且工具返回告警', async () => {
    const { dir, memoryDir } = makeProject();
    // 现存编号最大 #0004；历史上曾用过 #0009（那条已被人工删除）
    // 两处水位线（.state/ids 与 INDEX.md 注记）都不存在
    seedTwoEntries(memoryDir);

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: '降级后的新条目' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    // 复用真的发生了：#0005 曾经可能属于被删掉的历史条目
    assert.deepEqual(result.result.assignedIds, ['#0005']);
    const rebuilt = result.warnings.filter((warning) => warning.code === 'watermark-rebuilt');
    assert.equal(rebuilt.length, 1, '必须显式告警水位线重建');
    assert.ok(rebuilt[0].message.includes('复用'));
    assert.equal(readFileSync(path.join(memoryDir, '.state', 'ids'), 'utf8'), '5\n');
  });
});

describe('端到端：§14.50 usage.json 损坏', () => {
  test('usage 损坏只清空 usage：不影响注入（快照逐字符不变）与搜索所依赖的模型', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    mkdirSync(path.join(memoryDir, '.state'), { recursive: true });
    const usagePath = path.join(memoryDir, '.state', 'usage.json');
    writeFileSync(usagePath, JSON.stringify({ '#0003': { count: 7, lastUsedAt: '2026-09-19T00:00:00.000Z' } }));

    const healthy = await load(dir);
    const beforeText = buildSnapshot(healthy, configWith({}), { today: TODAY }).text;

    // 损坏 usage.json
    writeFileSync(usagePath, '{ 这不是 JSON');
    const degradedModel = await load(dir);

    assert.deepEqual(degradedModel.usage, {}, 'usage 清空');
    assert.ok(degradedModel.warnings.some((warning) => warning.code === 'usage-reset'));

    // 注入不受影响：快照逐字符相同
    assert.equal(buildSnapshot(degradedModel, configWith({}), { today: TODAY }).text, beforeText);
    // 搜索所依赖的模型也不受影响：条目与顺序完全相同
    assert.deepEqual(
      degradedModel.entries.map((entry) => entry.id),
      healthy.entries.map((entry) => entry.id),
    );
    assert.equal(degradedModel.nextId, healthy.nextId);

    // 而且不影响后续操作：写入照常成功，usage 可以被重新统计
    const result = await applyBatch(degradedModel, [{ type: 'write', entries: [{ kind: 'fact', title: '照常写入' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
    });
    assert.equal(result.ok, true);
    const usageAgain = await recordUsage(degradedModel, ['#0003'], { now: new Date('2026-09-20T12:00:00.000Z') });
    assert.equal(usageAgain.ok, true);
    assert.equal(usageAgain.usage['#0003']?.count, 1);
  });
});

describe('端到端：§14.44 快照 (a) 句的 N/M/K', () => {
  test('存在省略时三个数字逐项可核对（N 含被省略的置顶条，K = min(M, maxPinnedItems)）', async () => {
    const { dir, memoryDir } = makeProject();
    // 3 条参与注入的置顶条 + 4 条普通 active 条
    const pinned = [1, 2, 3].map((n) => `- [#000${n}] 置顶条目 ${n}\n  - 置顶：true\n  - 创建：2026-09-1${n}\n`).join('\n');
    const plain = [4, 5, 6, 7].map((n) => `- [#000${n}] 普通条目 ${n}\n  - 创建：2026-09-1${n}\n`).join('\n');
    writeMemory(memoryDir, '2026-09-19', `## 事实\n${pinned}\n${plain}\n`);

    const config = configWith({ maxPinnedItems: 2, maxIndexItems: 2, maxSnapshotChars: 6000 });
    const model = await load(dir);
    const snapshot = buildSnapshot(model, config, { today: TODAY });

    // 逐项自行推算（不抄实现）：
    //   参与注入的置顶条 M = 3；K = min(3, 2) = 2；置顶段被省略 3-2 = 1
    //   索引段能放 maxIndexItems = 2 条，共 4 条普通条 → 省略 2
    //   N = 索引段省略 2 + 置顶段省略 1 = 3
    const M = 3;
    const K = Math.min(M, config.maxPinnedItems);
    const pinnedOmitted = M - K;
    const indexOmitted = 4 - config.maxIndexItems;
    const N = pinnedOmitted + indexOmitted;

    const noteLine = snapshot.text.split('\n').find((line) => line.startsWith('本次快照按排序省略了'));
    assert.equal(noteLine, `本次快照按排序省略了 ${N} 条记忆；置顶记忆共 ${M} 条，展示其中前 ${K} 条。`);
    assert.equal(snapshot.stats.pinnedTotal, M);
    assert.equal(snapshot.stats.pinnedShown, K);
    assert.equal(snapshot.stats.omitted, N);
    assert.equal(snapshot.stats.indexed, 2);
  });
});

describe('applyBatch：注入校验器（dedup / sensitive 归 tools-layer）', () => {
  test('findDuplicate / findConflicts / scanEntryTexts 分别产出 duplicate / conflict / sensitive', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);
    const model = await load(dir);
    const op = [{ type: 'write', entries: [{ kind: 'fact', title: '与某条重复的标题' }] }];

    const duplicated = await applyBatch(model, op, {
      config: configWith({}),
      today: TODAY,
      now: NOW,
      validators: { findDuplicate: () => ({ id: '#0003' }) },
    });
    assert.equal(duplicated.ok, false);
    if (!duplicated.ok) assert.equal(duplicated.code, 'duplicate');

    const conflicted = await applyBatch(model, op, {
      config: configWith({}),
      today: TODAY,
      now: NOW,
      validators: { findConflicts: () => [{ id: '#0003', reason: '同主题 标签=port；端口 3180 ≠ 3080' }] },
    });
    assert.equal(conflicted.ok, false);
    if (!conflicted.ok) {
      assert.equal(conflicted.code, 'conflict');
      assert.ok(conflicted.message.includes('#0003'));
    }

    const sensitive = await applyBatch(model, op, {
      config: configWith({}),
      today: TODAY,
      now: NOW,
      validators: { scanEntryTexts: () => [{ field: 'title', category: 'credential' }] },
    });
    assert.equal(sensitive.ok, false);
    if (!sensitive.ok) assert.equal(sensitive.code, 'sensitive');

    assert.equal(existsSync(path.join(memoryDir, `M-${TODAY}.md`)), false, '三种拒绝都不落盘');
  });

  test('findSimilar：高度相似只提示不拒绝，提示进 result.similar', async () => {
    const { dir, memoryDir } = makeProject();
    seedTwoEntries(memoryDir);

    const result = await applyBatch(await load(dir), [{ type: 'write', entries: [{ kind: 'fact', title: 'web profile 使用端口 3080' }] }], {
      config: configWith({}),
      today: TODAY,
      now: NOW,
      validators: { findSimilar: () => [{ id: '#0003', reason: 'substring' }] },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.result.similar, [{ id: '#0003', reason: 'substring', entryIndex: 0 }]);
    assert.deepEqual(result.result.assignedIds, ['#0005']);
  });
});
