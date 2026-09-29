/**
 * 端到端验收测试（Lead 维护，对应设计 §14 里**必须跨模块**才能判定的条款）。
 *
 * 与各模块自己的单元测试分工：
 *   - 单元测试证明"函数对"；
 *   - 这里证明"整条链路对"——真实 `store.applyBatch` 落盘 → 重新 `loadProject` → `buildSnapshot`/`renderIndex`。
 *
 * 每条用例的用例名里带 §14 条目号，便于直接对照验收矩阵。
 * 全部使用 `fs.mkdtempSync` 临时工作区，绝不碰真实项目目录。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig } from '../src/config.js';
import { loadProject, applyBatch, syncAtBoundary } from '../src/store.js';
import { converge } from '../src/intent.js';
import { buildSnapshot } from '../src/snapshot.js';
import { renderIndex, readIndexNote } from '../src/index-md.js';
import { parseMemoryFile, todayLocal } from '../src/parse.js';
import * as dedup from '../src/dedup.js';
import * as sensitive from '../src/sensitive.js';

/** @type {string[]} */
const TEMP_ROOTS = [];
after(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const CONFIG = resolveConfig({ maxPinnedItems: 2, maxIndexItems: 3 }).config;
const TODAY = todayLocal();

/** 工具层传给 store 的校验器（与生产路径同源）。 */
const VALIDATORS = {
  findDuplicate: dedup.findDuplicate,
  findSimilar: dedup.findSimilar,
  findConflicts: dedup.findConflicts,
  scanEntryTexts: sensitive.scanEntryTexts,
};

/** 造一个空工作区。 */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmem-acc-'));
  TEMP_ROOTS.push(root);
  return root;
}

/** 写一个记忆文件（用于构造"人工编辑"现场）。 */
/** @param {string} root @param {string} date @param {string} body @returns {string} */
function writeMemoryFile(root, date, body) {
  const dir = path.join(root, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `M-${date}.md`);
  fs.writeFileSync(file, `# 记忆 · ${date}\n\n${body}\n`, 'utf8');
  return file;
}

/** 读一个文件，不存在返回 ''。 */
/** @param {string} filePath @returns {string} */
function readOrEmpty(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

/** 走一次完整的"边界扫描"（与 index.js 的 agent/created 同路径）。 */
/** @param {string} root */
async function boundary(root) {
  const model = await loadProject({ workspace: root, config: CONFIG });
  const sync = await syncAtBoundary(model, { config: CONFIG, today: TODAY });
  const fresh = await loadProject({ workspace: root, config: CONFIG });
  // 生产路径（index.js）把两处告警合并后带出，这里照同一口径聚合
  const warnings = [...model.warnings, ...sync.warnings, ...fresh.warnings];
  return { model, sync, fresh, warnings };
}

test('§14.8 / §14.53 重复编号修复后水位线必须抬高（真实宿主冒烟发现的回归）', async () => {
  const root = makeWorkspace();
  // 同一编号在文件里出现两次（模拟人工复制粘贴）
  writeMemoryFile(
    root,
    TODAY,
    ['## 事实', '- [#0001] 第一条', '  - 状态：active', '- [#0001] 第二条', '  - 状态：active'].join('\n'),
  );

  const { sync, fresh } = await boundary(root);

  assert.ok(
    sync.warnings.some((item) => item.code === 'duplicate-id-repaired'),
    '必须报告重复编号已修复',
  );
  const ids = fresh.entries.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ['#0001', '#0002'], '后出现的条目应被重发新号');

  // 水位线 = 已分配的最大编号：必须跟着抬高，否则日后删掉 #0002 就会复用这个号
  const idsFile = readOrEmpty(path.join(root, 'memory', '.state', 'ids')).trim();
  assert.equal(idsFile, '2', '.state/ids 必须抬到 2');
  assert.equal(readIndexNote(readOrEmpty(path.join(root, 'memory', 'INDEX.md'))), 2, 'INDEX.md 的 next-id 必须抬到 2');

  // 再走一次边界：不得再报重复
  const second = await boundary(root);
  assert.equal(
    second.sync.warnings.filter((item) => item.code === 'duplicate-id-repaired').length,
    0,
    '修复后不应反复报同一问题',
  );
});

test('§14.7 无编号条目在扫描时补发编号并写回（不等到被索引）', async () => {
  const root = makeWorkspace();
  const file = writeMemoryFile(root, TODAY, ['## 约定', '- 手工写的没有编号的一条', '  - 状态：active'].join('\n'));

  const { sync } = await boundary(root);

  assert.ok(sync.warnings.some((item) => item.code === 'missing-id-assigned'), '必须报告已补发编号');
  const content = readOrEmpty(file);
  assert.match(content, /- \[#0001\] 手工写的没有编号的一条/, '补发的编号必须写回文件');
});

test('§14.64 / §14.6 人工越权编辑：检测、自愈、且人工备注一字不丢', async () => {
  const root = makeWorkspace();
  writeMemoryFile(
    root,
    TODAY,
    [
      '## 事实',
      '- [#0001] 原本的条目',
      '  - 状态：candidate',
      '  - 置顶：true',
      '  - 我的备注：人手写的，不许丢',
    ].join('\n'),
  );

  const { fresh } = await boundary(root);
  const entry = fresh.entries.find((item) => item.id === '#0001');
  assert.ok(entry, '条目必须还在');
  assert.equal(entry.pinned, true, '人工写的置顶要保留在文件里（不参与注入但保留人工意图）');
  assert.deepEqual(
    entry.unknownFields.map((item) => item.name),
    ['我的备注'],
    '未知字段必须原样保留',
  );

  // §14.20：不参与注入的置顶条在 INDEX.md 里只渲染行尾「（置顶）」、不渲染 ★
  const index = renderIndex(fresh, { today: TODAY });
  const line = index.split('\n').find((item) => item.includes('#0001'));
  assert.ok(line?.includes('（置顶）'), 'INDEX.md 必须保留人工置顶意图');
  assert.ok(!line?.includes('★'), 'candidate 不参与注入，因此不得渲染 ★');
  assert.ok(line?.includes('状态 candidate'), 'INDEX.md 用中文状态写法');
});

test('§14.12 / §14.68 一次带 supersedes 的写入完成原子替换，不产生双活', async () => {
  const root = makeWorkspace();
  writeMemoryFile(
    root,
    TODAY,
    [
      '## 事实',
      '- [#0011] web profile 使用 3080 端口',
      '  - 状态：active',
      '  - 标签：port',
    ].join('\n'),
  );

  const model = await loadProject({ workspace: root, config: CONFIG });
  const result = await applyBatch(
    model,
    [
      {
        type: 'write',
        entries: [
          {
            kind: 'fact',
            title: 'web profile 使用 3180 端口',
            detail: '端口从 3080 调整为 3180。',
            tags: ['port'],
            supersedes: ['#0011'],
          },
        ],
      },
    ],
    { config: CONFIG, today: TODAY, validators: VALIDATORS },
  );

  assert.equal(result.ok, true, `写入应当成功，实际：${JSON.stringify(result).slice(0, 400)}`);
  const fresh = await loadProject({ workspace: root, config: CONFIG });
  const oldEntry = fresh.entries.find((item) => item.id === '#0011');
  const newEntry = fresh.entries.find((item) => item.id !== '#0011' && item.tags.includes('port'));
  assert.equal(oldEntry?.status, 'superseded', '旧条目必须被标为 superseded');
  assert.equal(oldEntry?.supersededBy, newEntry?.id, '旧条目必须记录取代者');
  assert.deepEqual(newEntry?.supersedes, ['#0011'], '新条目必须记录取代');
  assert.equal(
    fresh.entries.filter((item) => item.status === 'active' && item.tags.includes('port')).length,
    1,
    '同一主题不得出现两条 active（双活）',
  );
});

test('§14.15 / §14.16 归档单条不影响同日其他条目，恢复回填原状态', async () => {
  const root = makeWorkspace();
  writeMemoryFile(
    root,
    TODAY,
    [
      '## 事实',
      '- [#0001] 保留的条目',
      '  - 状态：active',
      '- [#0002] 要归档的条目',
      '  - 状态：candidate',
      '  - 备注：归档也要保住这句',
    ].join('\n'),
  );

  const model = await loadProject({ workspace: root, config: CONFIG });
  const archived = await applyBatch(model, [{ type: 'archive', ids: ['#0002'], reason: '有误' }], {
    config: CONFIG,
    today: TODAY,
    validators: VALIDATORS,
  });
  assert.equal(archived.ok, true, `归档应当成功：${JSON.stringify(archived).slice(0, 300)}`);

  const afterArchive = await loadProject({ workspace: root, config: CONFIG });
  assert.ok(afterArchive.entries.some((item) => item.id === '#0001' && item.status === 'active'), '同日其他条目必须原样保留');
  const archivedEntry = afterArchive.archived.find((item) => item.id === '#0002');
  assert.equal(archivedEntry?.status, 'archived');
  assert.equal(archivedEntry?.archivedStatusBefore, 'candidate', '归档前状态必须留存');
  assert.ok(
    archivedEntry?.unknownFields.some((item) => item.name === '备注'),
    '归档不得丢人工备注',
  );

  const restored = await applyBatch(afterArchive, [{ type: 'restore', ids: ['#0002'] }], {
    config: CONFIG,
    today: TODAY,
    validators: VALIDATORS,
  });
  assert.equal(restored.ok, true, `恢复应当成功：${JSON.stringify(restored).slice(0, 300)}`);
  const afterRestore = await loadProject({ workspace: root, config: CONFIG });
  const back = afterRestore.entries.find((item) => item.id === '#0002');
  assert.equal(back?.status, 'candidate', '恢复必须回填归档前状态');
  assert.equal(back?.archivedAt, null, '恢复必须删掉归档时间');
  assert.equal(back?.archivedStatusBefore, null, '恢复必须删掉归档前状态字段');
});

test('§14.33 / §14.34 / §14.44 快照与 INDEX 同源：置顶不重复、超限标注、说明行口径一致', async () => {
  const root = makeWorkspace();
  const lines = ['## 事实'];
  for (let index = 1; index <= 5; index += 1) {
    lines.push(`- [#000${index}] 第 ${index} 条事实`, '  - 状态：active', '  - 标签：bulk');
  }
  lines.push('- [#0006] 置顶的那条', '  - 状态：active', '  - 置顶：true', '  - 标签：bulk');
  writeMemoryFile(root, TODAY, lines.join('\n'));

  const { fresh } = await boundary(root);
  const snapshot = buildSnapshot(fresh, CONFIG, { today: TODAY });
  const index = renderIndex(fresh, { today: TODAY });

  // §14.33：快照块字符数就是文本本身的字符数，且不超预算
  assert.equal(snapshot.stats.chars, snapshot.text.replace(/\n/g, '').length, 'chars 口径必须与文本一致');
  assert.ok(snapshot.stats.chars <= CONFIG.maxSnapshotChars, '不得超预算');

  // §14.34：置顶条必须出现在置顶段，且不在索引段重复出现
  const pinnedOccurrences = snapshot.text.split('#0006').length - 1;
  assert.equal(pinnedOccurrences, 1, '同一条不得同时出现在两段');
  assert.ok(snapshot.text.includes('[★ #0006]'), '置顶条必须渲染 ★（注入视图）');
  assert.ok(!index.includes('★ #0006') || index.includes('[★ #0006]'), 'INDEX.md 也渲染 ★（该条参与注入）');

  // §14.44：存在省略时说明行必须出现，且 (b) 句数字口径与 stats 一致
  if (snapshot.stats.omitted > 0) {
    assert.match(snapshot.text, /本次快照按排序省略了 \d+ 条记忆；置顶记忆共 \d+ 条，展示其中前 \d+ 条。/);
    const expectK = Math.min(snapshot.stats.pinnedTotal, CONFIG.maxPinnedItems);
    assert.ok(snapshot.text.includes(`展示其中前 ${expectK} 条`), 'K 必须等于 min(M, maxPinnedItems)');
  }

  // §14.35：同输入两次调用逐字符相同
  assert.equal(buildSnapshot(fresh, CONFIG, { today: TODAY }).text, snapshot.text, '同状态必须逐字符一致');
});

test('§14.50 降级可验收：INDEX.md 损坏能重建、usage.json 损坏不影响注入', async () => {
  const root = makeWorkspace();
  writeMemoryFile(root, TODAY, ['## 事实', '- [#0001] 一条事实', '  - 状态：active'].join('\n'));
  await boundary(root);

  const indexPath = path.join(root, 'memory', 'INDEX.md');
  const snapshotBefore = buildSnapshot(
    await loadProject({ workspace: root, config: CONFIG }),
    CONFIG,
    { today: TODAY },
  ).text;
  const indexBefore = readOrEmpty(indexPath);

  // ① INDEX.md 被写坏 → 边界扫描必须重建
  fs.writeFileSync(indexPath, '# 被写坏的索引\n\n乱码\n', 'utf8');
  const rebuilt = await boundary(root);
  assert.ok(rebuilt.sync.ok, '重建必须成功');
  assert.match(readOrEmpty(indexPath), /#0001/, '重建后必须重新列出条目');

  // ② usage.json 被写坏 → 清空 usage，但注入文本必须逐字符不变
  fs.writeFileSync(path.join(root, 'memory', '.state', 'usage.json'), '{ 这不是 json', 'utf8');
  const degraded = await boundary(root);
  assert.ok(
    degraded.fresh.warnings.some((item) => item.code === 'usage-reset') ||
      degraded.sync.warnings.some((item) => item.code === 'usage-reset'),
    'usage 损坏必须告警（usage-reset）',
  );
  const snapshotAfter = buildSnapshot(degraded.fresh, CONFIG, { today: TODAY }).text;
  assert.equal(snapshotAfter, snapshotBefore, 'usage 损坏不得影响注入文本');
  assert.ok(indexBefore.length > 0);
});

test('§14.40 / §14.66 崩溃收敛：残留 intent 且目标被人工改动时绝不覆盖', async () => {
  const root = makeWorkspace();
  const file = writeMemoryFile(root, TODAY, ['## 事实', '- [#0001] 原始内容', '  - 状态：active'].join('\n'));
  await boundary(root);

  // 手工造一份"崩溃残留"的 intent：beforeFingerprint 与当前内容不符（模拟崩溃后又有人改了文件）
  const stateDir = path.join(root, 'memory', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  const tmpPath = path.join(root, 'memory', '.M-gone.tmp');
  fs.writeFileSync(tmpPath, '# 记忆 · X\n\n## 事实\n- [#0009] 崩溃时写了一半的新版本\n', 'utf8');
  fs.writeFileSync(
    path.join(stateDir, 'intent.json'),
    JSON.stringify({
      version: 1,
      op: 'batch',
      createdAt: new Date().toISOString(),
      files: [
        {
          path: file,
          tmpPath,
          backupPath: path.join(root, 'memory', '.M-gone.bak'),
          beforeFingerprint: 'deadbeefdeadbeef',
          afterFingerprint: 'cafebabecafebabe',
        },
      ],
    }),
    'utf8',
  );

  const before = readOrEmpty(file);
  const { sync } = await boundary(root);
  const after = readOrEmpty(file);

  assert.equal(after, before, '目标内容无法核对时**绝不覆盖**');
  assert.ok(
    sync.warnings.some((item) => item.code === 'write-conflict'),
    '必须报告 write-conflict（目标内容无法核对），而不是静默处理',
  );
  assert.ok(
    fs.existsSync(path.join(stateDir, 'intent.json')),
    '无法收敛时必须保留 intent，交人工处理（不得擅自丢弃）',
  );
});

test('§12.1 崩溃残留清扫：只清自己的陈旧产物，不碰近期文件与用户文件', async () => {
  const root = makeWorkspace();
  const dir = path.join(root, 'memory');
  fs.mkdirSync(path.join(dir, '.state'), { recursive: true });

  const orphanOld = path.join(dir, '.M-2026-09-20.md.aaaaaaaaaaaa.tmp');
  const orphanNew = path.join(dir, '.M-2026-09-20.md.bbbbbbbbbbbb.tmp');
  const userFile = path.join(dir, 'notes.txt');
  const userDot = path.join(dir, '.gitignore');
  fs.writeFileSync(orphanOld, 'x', 'utf8');
  fs.writeFileSync(orphanNew, 'x', 'utf8');
  fs.writeFileSync(userFile, 'x', 'utf8');
  fs.writeFileSync(userDot, 'x', 'utf8');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(orphanOld, old, old);

  const result = await converge(dir, {});

  assert.ok(!fs.existsSync(orphanOld), '超过 10 分钟的自家孤儿产物应被清掉');
  assert.ok(fs.existsSync(orphanNew), '近期产物不得清（可能属于正在并发写的进程）');
  assert.ok(fs.existsSync(userFile), '用户文件绝不能被碰');
  assert.ok(fs.existsSync(userDot), '用户的点文件绝不能被碰');
  assert.ok(result.warnings.some((item) => item.code === 'stale-tmp-swept'), '清扫必须留告警');
});

test('§14.3 多项目隔离：两个工作区互不可见、互不影响', async () => {
  const projectA = makeWorkspace();
  const projectB = makeWorkspace();
  writeMemoryFile(projectA, TODAY, ['## 事实', '- [#0001] 只属于 A 项目的条目', '  - 状态：active'].join('\n'));

  await boundary(projectA);
  const b = await boundary(projectB);

  const modelA = await loadProject({ workspace: projectA, config: CONFIG });
  const modelB = await loadProject({ workspace: projectB, config: CONFIG });
  assert.equal(modelA.entries.length, 1, 'A 项目应有 1 条');
  assert.equal(modelB.entries.length, 0, 'B 项目不得看到 A 的条目');
  assert.equal(b.sync.wrote, false, '空项目不该被写任何东西（不污染无关项目）');
  assert.ok(!fs.existsSync(path.join(projectB, 'memory', 'INDEX.md')), 'B 项目不该凭空出现 INDEX.md');
});

test('§14.50 日志写入失败：返回可读失败，绝不抛异常（不能拖垮模型步骤）', async () => {
  const root = makeWorkspace();
  writeMemoryFile(root, TODAY, ['## 事实', '- [#0001] 占位', '  - 状态：active'].join('\n'));
  await boundary(root);

  // 把当天的日志文件位置改成目录 → 写入必然失败
  const journalPath = path.join(root, 'memory', `JOURNAL-${TODAY}.md`);
  fs.mkdirSync(journalPath, { recursive: true });

  const model = await loadProject({ workspace: root, config: CONFIG });
  let threw = false;
  /** @type {any} */
  let result;
  try {
    result = await applyBatch(model, [{ type: 'log', entries: [{ title: '写不进去的日志', content: '正文' }] }], {
      config: CONFIG,
      today: TODAY,
      validators: VALIDATORS,
    });
  } catch (error) {
    threw = true;
  }

  assert.equal(threw, false, '日志写失败不得抛异常（§14.50 / §12.3）');
  assert.equal(result?.ok, false, '必须如实返回失败');
  assert.ok(typeof result?.message === 'string' && result.message.length > 0, '必须给出可读原因');
});

test('§14.53 编号降级：两处水位线丢失 + 历史最大号条目被删 → 复用并告警', async () => {
  const root = makeWorkspace();
  writeMemoryFile(
    root,
    TODAY,
    ['## 事实', '- [#0001] A 条', '  - 状态：active', '- [#0002] B 条（稍后被人工删除）', '  - 状态：active'].join('\n'),
  );
  await boundary(root);

  // 人工删掉 #0002 那条，并把两处水位线一起清掉（§6.1 唯一允许复用的降级路径）
  writeMemoryFile(root, TODAY, ['## 事实', '- [#0001] A 条', '  - 状态：active'].join('\n'));
  fs.rmSync(path.join(root, 'memory', '.state', 'ids'), { force: true });
  fs.rmSync(path.join(root, 'memory', 'INDEX.md'), { force: true });

  const { sync } = await boundary(root);
  assert.ok(
    sync.warnings.some((item) => item.code === 'watermark-rebuilt'),
    '两处水位线同时丢失必须告警（并且说明这是降级路径）',
  );

  const model = await loadProject({ workspace: root, config: CONFIG });
  const written = await applyBatch(model, [{ type: 'write', entries: [{ kind: 'fact', title: '降级后再写一条' }] }], {
    config: CONFIG,
    today: TODAY,
    validators: VALIDATORS,
  });
  assert.equal(written.ok, true);
  assert.deepEqual(written.result?.assignedIds, ['#0002'], '降级路径下编号被复用（这是设计唯一允许的复用）');
});

test('§14.20 / §14.64 新增置顶标记必须被检测告警（工具从不写置顶），且基线更新后不重复告警', async () => {
  const root = makeWorkspace();
  writeMemoryFile(root, TODAY, ['## 事实', '- [#0001] 普通条目', '  - 状态：active'].join('\n'));
  await boundary(root); // 建立无置顶的基线 INDEX.md

  // 越权/人工编辑：新增一条带 置顶：true 的活动条目
  writeMemoryFile(
    root,
    TODAY,
    [
      '## 事实',
      '- [#0001] 普通条目',
      '  - 状态：active',
      '- [#0002] 被加了置顶的条目',
      '  - 状态：active',
      '  - 置顶：true',
    ].join('\n'),
  );

  const first = await boundary(root);
  assert.ok(
    first.warnings.some((item) => item.code === 'manual-edit-detected' && item.message.includes('置顶')),
    '新增置顶必须告警（模型用通用文件工具写置顶属越权编辑）',
  );

  // 该置顶条参与注入 → INDEX.md 与快照都应渲染 ★（人工意图生效）
  const snapshot = buildSnapshot(first.fresh, CONFIG, { today: TODAY });
  assert.ok(snapshot.text.includes('[★ #0002]'), '参与注入的置顶条必须渲染 ★');

  const second = await boundary(root);
  assert.equal(
    second.warnings.filter((item) => item.message.includes('置顶')).length,
    0,
    '基线已更新，不得反复告警同一条置顶',
  );
});

test('§14.20 归档置顶条不得触发永久误报（INDEX.md 不渲染归档条目）', async () => {
  const root = makeWorkspace();
  writeMemoryFile(
    root,
    TODAY,
    ['## 事实', '- [#0001] 一条要被归档的置顶条', '  - 状态：active', '  - 置顶：true'].join('\n'),
  );
  await boundary(root);

  const model = await loadProject({ workspace: root, config: CONFIG });
  const archived = await applyBatch(model, [{ type: 'archive', ids: ['#0001'], reason: '不再需要' }], {
    config: CONFIG,
    today: TODAY,
    validators: VALIDATORS,
  });
  assert.equal(archived.ok, true, `归档应当成功：${JSON.stringify(archived).slice(0, 300)}`);

  // 归档后连续两次边界扫描都不得出现"新增置顶"告警
  const first = await boundary(root);
  const second = await boundary(root);
  const pinWarningsOf = (/** @type {{ warnings: Array<{ message: string }> }} */ pass) =>
    pass.warnings.filter((item) => item.message.includes('置顶')).length;
  assert.equal(pinWarningsOf(first), 0, '第一次扫描不得误报归档条目的置顶');
  assert.equal(pinWarningsOf(second), 0, '第二次扫描不得误报归档条目的置顶');
  // 归档文件里仍然保留置顶（§14.20），只是不参与注入
  const fresh = await loadProject({ workspace: root, config: CONFIG });
  assert.equal(fresh.archived.find((item) => item.id === '#0001')?.pinned, true, '归档文件里必须保留置顶');
});

test('§14.6 解析保真端到端：人工备注、游离行、未知字段在写入后全部保留', async () => {
  const root = makeWorkspace();
  const file = writeMemoryFile(
    root,
    TODAY,
    [
      '人工写在文件头的说明（不属于任何条目）',
      '',
      '## 约定',
      '- [#0001] 用 pnpm',
      '  - 状态：active',
      '  - 我的字段：自定义值',
      '',
      '  空行后的缩进备注',
      '',
      '## 经验',
      '- [#0002] bundle 变化要重启',
      '  - 状态：active',
    ].join('\n'),
  );

  const model = await loadProject({ workspace: root, config: CONFIG });
  const written = await applyBatch(
    model,
    [{ type: 'write', entries: [{ kind: 'procedure', title: '改 patch 后先 dump-config', detail: '实测通过' }] }],
    { config: CONFIG, today: TODAY, validators: VALIDATORS },
  );
  assert.equal(written.ok, true, `写入应当成功：${JSON.stringify(written).slice(0, 300)}`);

  const content = readOrEmpty(file);
  for (const fragment of ['人工写在文件头的说明', '我的字段：自定义值', '空行后的缩进备注', '#0001', '#0002', '改 patch 后先 dump-config']) {
    assert.ok(content.includes(fragment), `写入后不得丢内容：${fragment}`);
  }

  // 重新解析：条目数不变（新增一条 → 共 3 条），且未知字段仍在
  const reparsed = parseMemoryFile(content, file);
  assert.equal(reparsed.entries.length, 3, '条目数应为 3');
  const first = reparsed.entries.find((entry) => entry.id === '#0001');
  assert.deepEqual(first?.unknownFields.map((item) => item.name), ['我的字段']);
});
