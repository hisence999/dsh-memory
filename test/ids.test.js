/**
 * `ids` 单测：编号解析/格式化、水位线取 max、分配、重复编号修复的仲裁顺序。
 *
 * 全部为纯函数测试，不需要磁盘；临时目录纪律照旧（本文件不涉及 IO）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { allocate, formatId, parseId, repairDuplicates, watermark } from '../src/ids.js';

describe('parseId / formatId', () => {
  test('parseId：合法形态', () => {
    assert.equal(parseId('#0007'), 7);
    assert.equal(parseId('0007'), 7);
    assert.equal(parseId('#7'), 7);
    assert.equal(parseId('  #0012 '), 12);
    assert.equal(parseId('#0000'), 0);
    assert.equal(parseId('#12345'), 12345);
  });

  test('parseId：非法形态一律 null', () => {
    assert.equal(parseId(''), null);
    assert.equal(parseId('   '), null);
    assert.equal(parseId('#'), null);
    assert.equal(parseId('#abc'), null);
    assert.equal(parseId('J-20260920-1432'), null);
    assert.equal(parseId('#0007 '), 7);
    assert.equal(parseId('#0x7'), null);
    assert.equal(parseId('7.5'), null);
    assert.equal(parseId('#-7'), null);
    // @ts-expect-error 非字符串输入
    assert.equal(parseId(null), null);
    // @ts-expect-error 非字符串输入
    assert.equal(parseId(7), null);
  });

  test('formatId：补零到四位，超出四位自然增长；非法输入返回空串', () => {
    assert.equal(formatId(7), '#0007');
    assert.equal(formatId(0), '#0000');
    assert.equal(formatId(12345), '#12345');
    assert.equal(formatId(-1), '');
    assert.equal(formatId(Number.NaN), '');
    assert.equal(formatId(Number.POSITIVE_INFINITY), '');
  });
});

describe('watermark：max(.state/ids, INDEX.md 注记, 活动编号, 归档编号)', () => {
  test('四处来源各自生效', () => {
    assert.equal(watermark({ idsFileContent: '0011\n' }), 11);
    assert.equal(watermark({ idsFileContent: '#0012' }), 12);
    assert.equal(watermark({ idsFileContent: '{"nextId":13}' }), 13);
    assert.equal(watermark({ idsFileContent: '不是数字' }), 0);
    assert.equal(watermark({ indexNote: 7 }), 7);
    assert.equal(watermark({ indexNote: '0014' }), 14);
    assert.equal(watermark({ indexNote: null }), 0);
    assert.equal(watermark({ activeIds: ['#0002', '#0005'] }), 5);
    assert.equal(watermark({ archivedIds: ['#0009', null, '坏值'] }), 9);
    assert.equal(watermark({ activeIds: [{ id: '#0004' }, { id: null }] }), 4);
  });

  test('取最大值，而不是某一个来源', () => {
    assert.equal(
      watermark({
        idsFileContent: '0011\n',
        indexNote: 20,
        activeIds: ['#0003', '#0007'],
        archivedIds: ['#0009'],
      }),
      20,
    );
    assert.equal(
      watermark({ idsFileContent: '0011\n', indexNote: 2, activeIds: ['#0030'], archivedIds: ['#0009'] }),
      30,
    );
  });

  test('全部缺失 → 0（编号从 1 起，0 是安全的加性单位元）', () => {
    assert.equal(watermark(), 0);
    assert.equal(watermark({}), 0);
    assert.equal(watermark({ idsFileContent: '', indexNote: null, activeIds: [], archivedIds: [] }), 0);
  });
});

describe('allocate', () => {
  test('从水位线 +1 开始连续分配', () => {
    assert.deepEqual(allocate(0, 3), { ids: ['#0001', '#0002', '#0003'], next: 3 });
    assert.deepEqual(allocate(11, 2), { ids: ['#0012', '#0013'], next: 13 });
    assert.deepEqual(allocate(12345, 1), { ids: ['#12346'], next: 12346 });
  });

  test('count 为 0/负数/非法 → 不发编号且水位线不变', () => {
    assert.deepEqual(allocate(5, 0), { ids: [], next: 5 });
    assert.deepEqual(allocate(5, -3), { ids: [], next: 5 });
    assert.deepEqual(allocate(Number.NaN, 2), { ids: ['#0001', '#0002'], next: 2 });
  });
});

describe('repairDuplicates：仲裁顺序与重发编号', () => {
  test('活动文件优先于归档文件（即使归档文件日期更早）', () => {
    const entries = [
      { id: '#0003', filePath: 'D:/proj/memory/archive/M-2026-09-01.md', fileDate: '2026-09-01', order: 0, archivedAt: '2026-09-10 10:00' },
      { id: '#0003', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 0, archivedAt: null },
    ];
    const result = repairDuplicates(entries);

    assert.equal(result.entries[1].id, '#0003', '活动条目保留原号');
    assert.equal(result.entries[0].id, '#0004', '归档条目重发新号');
    assert.equal(entries[0].id, '#0003', '入参不可被修改');
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, 'duplicate-id-repaired');
    assert.equal(result.warnings[0].id, '#0004');
    assert.deepEqual(result.reassigned, [
      { path: 'D:/proj/memory/archive/M-2026-09-01.md', from: '#0003', to: '#0004' },
    ]);
  });

  test('活动文件之间按文件名日期升序：早的那份保留原号', () => {
    const entries = [
      { id: '#0002', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 0 },
      { id: '#0002', filePath: 'D:/proj/memory/M-2026-09-19.md', fileDate: '2026-09-19', order: 0 },
    ];
    const result = repairDuplicates(entries);
    assert.equal(result.entries[1].id, '#0002');
    assert.equal(result.entries[0].id, '#0003');
  });

  test('同一文件内按出现顺序：order 小的保留原号', () => {
    const entries = [
      { id: '#0005', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 1 },
      { id: '#0005', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 0 },
    ];
    const result = repairDuplicates(entries);
    assert.equal(result.entries[1].id, '#0005');
    assert.equal(result.entries[0].id, '#0006');
  });

  test('新编号从既有最大编号之后递增，绝不与既有编号撞车', () => {
    const entries = [
      { id: '#0002', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 0 },
      { id: '#0009', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 1 },
      { id: '#0002', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 2 },
      { id: '#0002', filePath: 'D:/proj/memory/M-2026-09-21.md', fileDate: '2026-09-21', order: 0 },
    ];
    const result = repairDuplicates(entries);
    assert.deepEqual(
      result.entries.map((entry) => entry.id),
      ['#0002', '#0009', '#0010', '#0011'],
    );
    assert.equal(result.warnings.length, 2);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      ['duplicate-id-repaired', 'duplicate-id-repaired'],
    );
  });

  test('无编号条目（尚未补发）不在这里处理，也不记重复告警', () => {
    const entries = [
      { id: null, filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 0 },
      { id: null, filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 1 },
    ];
    const result = repairDuplicates(entries);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.entries.map((entry) => entry.id),
      [null, null],
    );
  });

  test('没有重复时原样返回（条目对象不被复制）', () => {
    const entries = [
      { id: '#0001', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 0 },
      { id: '#0002', filePath: 'D:/proj/memory/M-2026-09-20.md', fileDate: '2026-09-20', order: 1 },
    ];
    const result = repairDuplicates(entries);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0], entries[0]);
    assert.equal(result.entries[1], entries[1]);
    assert.deepEqual(result.warnings, []);
  });

  test('fileDate 缺失时从文件名的日期推导', () => {
    const entries = [
      { id: '#0004', filePath: 'D:/proj/memory/M-2026-09-21.md', order: 0 },
      { id: '#0004', filePath: 'D:/proj/memory/M-2026-09-18.md', order: 0 },
    ];
    const result = repairDuplicates(entries);
    assert.equal(result.entries[1].id, '#0004', '09-18 那份保留原号');
    assert.equal(result.entries[0].id, '#0005');
  });

  test('入参不是数组时按空清单处理', () => {
    // @ts-expect-error 故意传非法类型
    const result = repairDuplicates(undefined);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.warnings, []);
  });
});
