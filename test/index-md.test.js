/**
 * `index-md` 单测：`next-id` 注记、`INDEX.md` 渲染（★／（置顶）／⚠ 超限未注入）、
 * 重建顺序（★ 段 → active → candidate → superseded → expired）、确定性。
 *
 * 用真实 `parse.parseMemoryFile` 造模型（条目形状与运行时一致），
 * 全部在 `fs.mkdtempSync(os.tmpdir())` 临时目录里进行（本文件其实不碰磁盘）。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../src/config.js';
import { indexNoteLine, isOverlength, readIndexNote, renderIndex } from '../src/index-md.js';
import { parseMemoryFile } from '../src/parse.js';

/** @type {string[]} */
const temps = [];

/** 临时目录（纪律要求：绝不碰真实项目目录） */
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  return dir;
}

/**
 * 一份固定配置（长度上限取得很小，方便触发超限）
 *
 * @param {Record<string, unknown>} overrides
 * @returns {typeof DEFAULTS}
 */
function configWith(overrides) {
  return { ...DEFAULTS, ...overrides };
}

/**
 * 用两天的记忆文件造一个模型。
 *
 * @param {string} dir
 * @param {number} nextId
 * @returns {{ active: import('../src/parse.js').Entry[], nextId: number }}
 */
function buildModel(dir, nextId) {
  const day19 = `# 记忆 · 2026-09-19

## 约定
- [#0007] 项目默认使用 SSH 别名 us
  - 置顶：true
  - 创建：2026-09-18
- [#0010] 待确认的约定
  - 状态：candidate
  - 创建：2026-09-20

## 事实
- [#0009] 置顶的事实
  - 置顶：true
  - 创建：2026-09-20

## 经验
- [#0008] 经验条
  - 创建：2026-09-19
`;
  const day20 = `# 记忆 · 2026-09-20

## 事实
- [#0011] 已被取代的事实
  - 状态：superseded
  - 取代者：#0013
- [#0012] 已过期的事实
  - 有效至：2026-09-01
`;
  const first = parseMemoryFile(day19, path.join(dir, 'memory', 'M-2026-09-19.md'));
  const second = parseMemoryFile(day20, path.join(dir, 'memory', 'M-2026-09-20.md'));
  return { active: [...first.entries, ...second.entries], nextId };
}

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录。
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('indexNoteLine / readIndexNote', () => {
  test('注记行格式固定为四位补零', () => {
    assert.equal(indexNoteLine(11), 'next-id: 0011');
    assert.equal(indexNoteLine(7), 'next-id: 0007');
    assert.equal(indexNoteLine(12345), 'next-id: 12345');
    assert.equal(indexNoteLine(0), 'next-id: 0000');
  });

  test('读回注记：容忍人工写法，读不出返回 null', () => {
    assert.equal(readIndexNote('# 项目记忆索引\n\nnext-id: 0011\n'), 11);
    assert.equal(readIndexNote('next-id: 11'), 11);
    assert.equal(readIndexNote('next-id：#0011'), 11);
    assert.equal(readIndexNote('next-id:0009'), 9);
    assert.equal(readIndexNote('# 项目记忆索引\n'), null);
    assert.equal(readIndexNote('next-id: 不是数字'), null);
    assert.equal(readIndexNote(''), null);
  });

  test('写出去再读回来一致', () => {
    const text = `# 项目记忆索引\n\n${indexNoteLine(37)}\n`;
    assert.equal(readIndexNote(text), 37);
  });
});

describe('isOverlength：§5.6 的三处上限', () => {
  test('标题 / 详细 / 单条总计各自超限', () => {
    const entry = parseMemoryFile(
      `# 记忆 · 2026-09-20

## 事实
- [#0001] 标题很长
  - 详细：细节很多
`,
      '/tmp/memory/M-2026-09-20.md',
    ).entries[0];
    assert.ok(entry !== undefined);
    assert.deepEqual(isOverlength(entry, configWith({})), { overlength: false, codes: [] });
    assert.deepEqual(isOverlength(entry, configWith({ maxTitleChars: 2 })).codes, ['overlength-title']);
    assert.deepEqual(isOverlength(entry, configWith({ detailMaxChars: 2 })).codes, ['overlength-detail']);
    assert.deepEqual(isOverlength(entry, configWith({ itemMaxChars: 10 })).codes, ['overlength-item']);
  });
});

describe('renderIndex：行格式与标记', () => {
  test('★ 只给参与注入的置顶条；状态用中文写法', () => {
    const dir = tempDir();
    const model = buildModel(dir, 13);
    const text = renderIndex(model, { today: '2026-09-20', config: configWith({}) });

    assert.ok(text.startsWith('# 项目记忆索引\n'));
    assert.ok(text.includes('next-id: 0013'));
    assert.ok(text.includes('[★ #0007] 约定 · 项目默认使用 SSH 别名 us · 状态 active'));
    assert.ok(text.includes('[★ #0009] 事实 · 置顶的事实 · 状态 active'));
    assert.ok(text.includes('[#0008] 经验 · 经验条 · 状态 active'));
    assert.ok(text.includes('[#0010] 约定 · 待确认的约定 · 状态 candidate'));
    assert.ok(text.includes('[#0011] 事实 · 已被取代的事实 · 状态 superseded'));
    assert.ok(text.includes('[#0012] 事实 · 已过期的事实 · 状态 expired'));
    assert.equal(text.endsWith('\n'), true);
  });

  test('不参与注入的置顶条：行尾（置顶），不渲染 ★', () => {
    const dir = tempDir();
    const parsed = parseMemoryFile(
      `# 记忆 · 2026-09-20

## 约定
- [#0002] 待确认但被人工置顶
  - 状态：candidate
  - 置顶：true
- [#0003] 已归档但被人工置顶
  - 状态：archived
  - 置顶：true
`,
      path.join(dir, 'memory', 'M-2026-09-20.md'),
    );
    const text = renderIndex({ active: parsed.entries, nextId: 3 }, { today: '2026-09-20', config: configWith({}) });

    assert.equal(text.includes('★ #0002'), false);
    assert.ok(text.includes('[#0002] 约定 · 待确认但被人工置顶 · 状态 candidate （置顶）'));
    assert.ok(text.includes('[#0003] 约定 · 已归档但被人工置顶 · 状态 archived （置顶）'));
  });

  test('超限条目仍列出，行尾标 ⚠ 超限未注入；两个标记顺序固定', () => {
    const dir = tempDir();
    const parsed = parseMemoryFile(
      `# 记忆 · 2026-09-20

## 约定
- [#0004] 一个很长的标题用于触发超限
  - 置顶：true
- [#0005] 普通标题
`,
      path.join(dir, 'memory', 'M-2026-09-20.md'),
    );
    const text = renderIndex(
      { active: parsed.entries, nextId: 5 },
      { today: '2026-09-20', config: configWith({ maxTitleChars: 5 }) },
    );

    // 置顶 + 超限 → 不渲染 ★，两个标记按固定顺序
    assert.ok(text.includes('[#0004] 约定 · 一个很长的标题用于触发超限 · 状态 active （置顶）⚠ 超限未注入'));
    // 未超限的普通条目不带标记
    assert.ok(text.includes('[#0005] 约定 · 普通标题 · 状态 active'));
    assert.equal(text.includes('[#0005] 约定 · 普通标题 · 状态 active ⚠ 超限未注入'), false);
    assert.equal(text.includes('★'), false);
  });

  test('overlengthIds 可由调用方预先指定', () => {
    const dir = tempDir();
    const model = buildModel(dir, 13);
    const text = renderIndex(model, { today: '2026-09-20', config: configWith({}), overlengthIds: ['#0008'] });
    assert.ok(text.includes('[#0008] 经验 · 经验条 · 状态 active ⚠ 超限未注入'));
  });
});

describe('renderIndex：重建顺序（§2.3）', () => {
  test('★ 段在前，随后 active → candidate → superseded → expired', () => {
    const dir = tempDir();
    const model = buildModel(dir, 13);
    const text = renderIndex(model, { today: '2026-09-20', config: configWith({}) });
    const order = text
      .split('\n')
      .filter((line) => line.startsWith('['))
      .map((line) => line.slice(line.indexOf('#'), line.indexOf(']')));

    assert.deepEqual(order, ['#0007', '#0009', '#0008', '#0010', '#0011', '#0012']);
  });

  test('组内按排序链（类型 → 置信度 → 优先级 → 创建日期新者优先 → 编号升序）', () => {
    const dir = tempDir();
    const parsed = parseMemoryFile(
      `# 记忆 · 2026-09-20

## 事实
- [#0020] 事实-低优先级
  - 优先级：low
  - 创建：2026-09-20
- [#0021] 事实-高优先级
  - 优先级：high
  - 创建：2026-09-19

## 约定
- [#0030] 约定-后面创建
  - 创建：2026-09-20
- [#0029] 约定-更早创建
  - 创建：2026-09-18

## 经验
- [#0040] 经验条
`,
      path.join(dir, 'memory', 'M-2026-09-20.md'),
    );
    const text = renderIndex({ active: parsed.entries, nextId: 40 }, { today: '2026-09-20', config: configWith({}) });
    const order = text
      .split('\n')
      .filter((line) => line.startsWith('['))
      .map((line) => line.slice(line.indexOf('#'), line.indexOf(']')));

    // 约定（类型权重最高）→ 约定内创建日期新者优先；再 事实（优先级 high 在前）；最后 经验
    assert.deepEqual(order, ['#0030', '#0029', '#0021', '#0020', '#0040']);
  });

  test('归档条目不出现在 INDEX.md（模型只有 entries 时按路径过滤）', () => {
    const dir = tempDir();
    const activeParsed = parseMemoryFile(
      `# 记忆 · 2026-09-20

## 事实
- [#0001] 活动区的条目
`,
      path.join(dir, 'memory', 'M-2026-09-20.md'),
    );
    const archivedParsed = parseMemoryFile(
      `# 记忆 · 2026-09-19

## 事实
- [#0002] 归档区的条目
  - 状态：archived
`,
      path.join(dir, 'memory', 'archive', 'M-2026-09-19.md'),
    );
    const text = renderIndex(
      { entries: [...activeParsed.entries, ...archivedParsed.entries], nextId: 2 },
      { today: '2026-09-20', config: configWith({}) },
    );
    assert.ok(text.includes('#0001'));
    assert.equal(text.includes('#0002'), false);
  });

  test('确定性：同一模型 + 同一天渲染两次逐字符相同', () => {
    const dir = tempDir();
    const model = buildModel(dir, 13);
    const first = renderIndex(model, { today: '2026-09-20', config: configWith({}) });
    const second = renderIndex(model, { today: '2026-09-20', config: configWith({}) });
    assert.equal(first, second);
  });

  test('没有条目时给固定占位行', () => {
    const text = renderIndex({ active: [], nextId: 0 }, { today: '2026-09-20', config: configWith({}) });
    assert.ok(text.includes('next-id: 0000'));
    assert.ok(text.includes('（暂无长期记忆）'));
  });
});
