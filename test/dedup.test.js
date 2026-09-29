/**
 * `dedup` 的验收测试（设计 §8.3、§7.1、§14.13／§14.14／§14.68）。
 *
 * 覆盖：精确重复（含规范化）、子串与 20% 编辑距离的相似提示、
 * 冲突四要素（同 kind + 主题键交集 + 指纹差异 + 其余文本基本相同）的正反例、
 * 以及 `excludeIds`（本批 supersedes 目标）必须排除。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { editDistance, extractFingerprints, findConflicts, findDuplicate, findSimilar } from '../src/dedup.js';

const TODAY = '2026-09-20';

/**
 * 造一条 Entry 形状的对象（只填本模块用到的字段，其余给默认值）。
 *
 * @param {Record<string, unknown>} overrides
 * @returns {any}
 */
function entry(overrides) {
  return {
    id: '#0001',
    kind: 'fact',
    title: '',
    detail: '',
    status: 'active',
    pinned: false,
    priority: 'medium',
    confidence: 'observed',
    created: '2026-09-19',
    updated: '2026-09-19',
    expiresAt: '永久',
    tags: [],
    aliases: [],
    related: [],
    supersedes: [],
    supersededBy: null,
    relatedJournal: [],
    source: '',
    archivedAt: null,
    archivedReason: null,
    archivedStatusBefore: null,
    unknownFields: [],
    presentFields: [],
    orphanNotes: [],
    filePath: '/tmp/memory/M-2026-09-19.md',
    fileDate: '2026-09-19',
    order: 0,
    raw: '',
    ...overrides,
  };
}

describe('findDuplicate：精确重复', () => {
  test('规范化后完全相同 → 返回编号', () => {
    const entries = [entry({ id: '#0003', title: 'web profile 使用 3080 端口' })];
    assert.deepEqual(findDuplicate('web profile 使用 3080 端口', entries, { today: TODAY }), { id: '#0003' });
  });

  test('NFKC／大小写／空白折叠后相同也算重复', () => {
    const entries = [entry({ id: '#0003', title: 'WEB  Profile   使用 3080 端口' })];
    assert.deepEqual(findDuplicate('web profile 使用 3080 端口', entries, { today: TODAY }), { id: '#0003' });
  });

  test('不同标题返回 null；空标题不判', () => {
    const entries = [entry({ id: '#0003', title: 'web profile 使用 3080 端口' })];
    assert.equal(findDuplicate('web profile 使用 3180 端口', entries, { today: TODAY }), null);
    assert.equal(findDuplicate('', entries, { today: TODAY }), null);
  });
});

describe('findSimilar：只提示不拒绝', () => {
  test('子串关系 → reason substring', () => {
    const entries = [entry({ id: '#0008', title: 'bundle 成员变化后必须重启 profile' })];
    const hits = findSimilar('DSH bundle 成员变化后必须重启 profile 的实测结论', entries, { today: TODAY });
    assert.deepEqual(hits, [{ id: '#0008', reason: 'substring' }]);
  });

  test('编辑距离 ≤ 较长标题 20% → reason edit-distance', () => {
    const entries = [entry({ id: '#0008', title: 'DSH bundle 成员变化后必须重启 profile' })];
    const hits = findSimilar('DSH bundle 成员变化必须重启 profile', entries, { today: TODAY });
    assert.deepEqual(hits, [{ id: '#0008', reason: 'edit-distance' }]);
  });

  test('完全相同不重复提示（那是 duplicate 的事）；差异过大不提示；归档条目不提示', () => {
    const entries = [
      entry({ id: '#0008', title: 'web profile 使用 3080 端口' }),
      entry({ id: '#0009', title: '完全不相干的一条记录' }),
      entry({ id: '#0010', title: 'web profile 使用 3080 端口（归档）', status: 'archived', archivedAt: '2026-09-19 10:00' }),
    ];
    assert.deepEqual(findSimilar('web profile 使用 3080 端口', entries, { today: TODAY }), []);
    assert.deepEqual(findSimilar('nginx 反向代理把 3185 端口转发到后端', entries, { today: TODAY }), []);
  });

  test('编辑距离按 Unicode 码点计算', () => {
    assert.equal(editDistance('重启', '重启'), 0);
    assert.equal(editDistance('重启', '重起'), 1);
    assert.equal(editDistance('', 'abc'), 3);
  });
});

describe('extractFingerprints：端口／版本／路径／独立数字', () => {
  test('端口（三种写法）', () => {
    assert.ok(extractFingerprints('web profile 使用 3080 端口').has('3080'));
    assert.ok(extractFingerprints('listen on port 3180').has('3180'));
    assert.ok(extractFingerprints('监听 :8080').has('8080'));
  });

  test('版本与路径', () => {
    assert.ok(extractFingerprints('升级到 v1.2.3').has('1.2.3'));
    assert.ok(extractFingerprints('改 src/tools/write.js 里的判断').has('src/tools/write.js'));
    // 路径分隔符两种写法等价（normalize 统一成 /）
    assert.ok(extractFingerprints('改 src\\tools\\write.js').has('src/tools/write.js'));
  });

  test('独立数字；版本里的数字不重复贡献指纹', () => {
    assert.ok(extractFingerprints('重试 3 次').has('3'));
    const fingerprints = extractFingerprints('升级到 v1.2.3');
    assert.ok(!fingerprints.has('1'));
  });

  test('没有指纹时返回空集合', () => {
    assert.equal(extractFingerprints('web profile 必须重启').size, 0);
  });
});

describe('findConflicts：四要素缺一不判', () => {
  /** #0011：事实 · web profile 使用 3080 端口（标签 port） */
  function existing() {
    return [entry({ id: '#0011', kind: 'fact', title: 'web profile 使用 3080 端口', tags: ['port'] })];
  }

  test('四要素齐全 → 判冲突，理由含主题键与指纹差异（§8.3 的范例）', () => {
    const conflicts = findConflicts({ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['port'], aliases: [] }, existing(), {
      today: TODAY,
      excludeIds: [],
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].id, '#0011');
    assert.match(conflicts[0].reason, /同主题 标签=port/);
    assert.match(conflicts[0].reason, /端口 3180 ≠ 3080/);
  });

  test('要素①不成立：kind 不同 → 不判冲突', () => {
    const conflicts = findConflicts({ kind: 'procedure', title: 'web profile 监听 3180 端口', tags: ['port'] }, existing(), {
      today: TODAY,
      excludeIds: [],
    });
    assert.deepEqual(conflicts, []);
  });

  test('要素②不成立：标签/别名交集为空 → 不判冲突', () => {
    const conflicts = findConflicts({ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['network'] }, existing(), {
      today: TODAY,
      excludeIds: [],
    });
    assert.deepEqual(conflicts, []);
  });

  test('要素③不成立：指纹集合相同 → 不判冲突', () => {
    const conflicts = findConflicts({ kind: 'fact', title: 'web profile 使用 3080 端口', tags: ['port'] }, existing(), {
      today: TODAY,
      excludeIds: [],
    });
    assert.deepEqual(conflicts, []);
  });

  test('要素④不成立：其余文本差别很大 → 不判冲突', () => {
    const conflicts = findConflicts({ kind: 'fact', title: 'nginx 反向代理把 3185 端口转发到后端', tags: ['port'] }, existing(), {
      today: TODAY,
      excludeIds: [],
    });
    assert.deepEqual(conflicts, []);
  });

  test('别名命中也算主题键命中', () => {
    const entries = [entry({ id: '#0011', kind: 'fact', title: 'web profile 使用 3080 端口', aliases: ['web profile'] })];
    const conflicts = findConflicts({ kind: 'fact', title: 'web profile 使用 3180 端口', tags: [], aliases: ['web profile'] }, entries, {
      today: TODAY,
      excludeIds: [],
    });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0].reason, /别名=web profile/);
  });

  test('§7.1 的排除规则：excludeIds（本批 supersedes 目标）不再判冲突', () => {
    const conflicts = findConflicts({ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['port'] }, existing(), {
      today: TODAY,
      excludeIds: ['#0011'],
    });
    assert.deepEqual(conflicts, [], '没有这条排除规则，§11 示例 D 的第二通调用会被同样的理由再拒一次');
  });

  test('已 superseded / 已归档的条目不参与', () => {
    const superseded = [entry({ id: '#0011', kind: 'fact', title: 'web profile 使用 3080 端口', tags: ['port'], status: 'superseded' })];
    assert.deepEqual(
      findConflicts({ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['port'] }, superseded, { today: TODAY, excludeIds: [] }),
      [],
    );
    const archived = [
      entry({ id: '#0011', kind: 'fact', title: 'web profile 使用 3080 端口', tags: ['port'], status: 'archived', archivedAt: '2026-09-19 10:00' }),
    ];
    assert.deepEqual(
      findConflicts({ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['port'] }, archived, { today: TODAY, excludeIds: [] }),
      [],
    );
  });

  test('候选自身没有主题键 → 直接不判（不做文本相似度猜主题）', () => {
    assert.deepEqual(
      findConflicts({ kind: 'fact', title: 'web profile 监听 3180 端口', tags: [], aliases: [] }, existing(), { today: TODAY, excludeIds: [] }),
      [],
    );
  });
});
