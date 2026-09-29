/**
 * `memory_write` 的验收测试（设计 §7.1、§7.6、§8.3、§14.13/14/38/52/68/71）。
 *
 * 全部通过**真实的工具定义**驱动：`definition.execute(args, exec)` + `definition.output.render(args, value)`，
 * 工作区一律是 `fs.mkdtempSync(os.tmpdir())` 造出来的临时目录，绝不碰真实项目目录。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS } from '../src/config.js';
import * as parse from '../src/parse.js';
import * as dedicatedDedup from '../src/dedup.js';
import * as dedicatedSensitive from '../src/sensitive.js';
import * as dedicatedErrors from '../src/errors.js';
import { applyBatch, loadProject, recordUsage } from '../src/store.js';
import { createWriteTool } from '../src/tools/write.js';

/** 固定的"此刻"：所有日期断言都以它为准 */
const NOW = new Date('2026-09-20T14:32:00');
const TODAY = parse.todayLocal(NOW);
const YESTERDAY = parse.addDays(TODAY, -1);
const TOMORROW = parse.addDays(TODAY, 1);

/** @type {string[]} */
const temps = [];

after(() => {
  for (const dir of temps) {
    // 双保险：只删本测试自己建出来的 dshmem- 前缀目录
    if (path.basename(dir).startsWith('dshmem-')) rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一个临时工作区（memory/ 由 store 在首次写入时创建） */
function makeWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dshmem-'));
  temps.push(dir);
  return dir;
}

/**
 * @param {string} workspace
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function makeDeps(workspace, overrides = {}) {
  void workspace;
  /** @type {string[]} */
  let boundary = Array.isArray(overrides.boundary) ? [...overrides.boundary] : [];
  return {
    config: { ...DEFAULTS, .../** @type {Record<string, unknown>} */ (overrides.config ?? {}) },
    ctx: { logger: { warn() {}, info() {}, error() {}, debug() {} } },
    parse,
    dedup: dedicatedDedup,
    sensitive: dedicatedSensitive,
    errors: dedicatedErrors,
    loadProject,
    applyBatch,
    recordUsage,
    now: () => NOW,
    isAllowedSession: () => overrides.allowed !== false,
    takeBoundaryWarnings: () => {
      const out = boundary;
      boundary = [];
      return out;
    },
    writeToolNames: ['memory_write', 'memory_edit', 'memory_archive', 'memory_log'],
    searchToolName: 'memory_search',
  };
}

/**
 * @param {string} workspace
 * @returns {any}
 */
function makeExec(workspace) {
  return {
    agent: { id: 'session-1', session: { id: 'session-1', header: { cwd: workspace } } },
    signal: new AbortController().signal,
  };
}

/**
 * 真实驱动一次工具调用。
 *
 * @param {any} tool
 * @param {unknown} args
 * @param {any} exec
 * @returns {Promise<{ value: any, text: string }>}
 */
async function run(tool, args, exec) {
  const value = await tool.execute(args, exec);
  const blocks = /** @type {Array<{ text: string }>} */ (tool.output.render(args, value));
  return { value, text: blocks.map((raw) => raw.text).join('\n') };
}

/**
 * 预置一个记忆文件。
 *
 * @param {string} workspace
 * @param {string} date
 * @param {string} body
 * @returns {string} 文件路径
 */
function seedMemory(workspace, date, body) {
  const memoryDir = path.join(workspace, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, `M-${date}.md`);
  writeFileSync(file, `# 记忆 · ${date}\n\n${body}`);
  return file;
}

/**
 * 读出某天记忆文件的文本。
 *
 * @param {string} workspace
 * @param {string} date
 * @returns {string}
 */
function memoryText(workspace, date) {
  return readFileSync(path.join(workspace, 'memory', `M-${date}.md`), 'utf8');
}

describe('memory_write：正常写入', () => {
  test('整批写入成功：返回编号、状态与下一步；文件里出现标题', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    const { value, text } = await run(
      tool,
      {
        entries: [
          {
            kind: 'lesson',
            title: 'DSH bundle 成员变化后必须重启 profile',
            detail: 'profile patch 支持热加载，但依赖清单变化不会随 patch 热加载。',
            confidence: 'confirmed',
            tags: ['bundle', 'restart'],
            source: '实测',
            relatedJournal: ['J-20260918-1542'],
          },
        ],
      },
      exec,
    );

    assert.equal(value.ok, true);
    assert.match(text, /^\[memory_write 完成\]/);
    assert.match(text, /做了什么：/);
    assert.match(text, /下一步建议：/);
    assert.match(text, /#\d{4}/);
    assert.match(text, /经验/);
    const file = memoryText(workspace, TODAY);
    assert.match(file, /DSH bundle 成员变化后必须重启 profile/);
    assert.match(file, /## 经验/);
  });

  test('status: candidate 可写入（未验证的结论）', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: '疑似 DNS 导致连接超时', status: 'candidate' }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, true);
    assert.match(text, /状态：candidate/);
    assert.match(memoryText(workspace, TODAY), /状态：candidate/);
  });

  test('会话边界的降级告警会附在返回里（§12.3）', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace, { boundary: ['parse-damaged: 某文件解析降级'] }));
    const { text } = await run(tool, { entries: [{ kind: 'fact', title: '边界告警要带出来' }] }, makeExec(workspace));
    assert.match(text, /parse-damaged/);
    assert.match(text, /降级告警/);
  });
});

describe('memory_write：敏感信息（§14.52 正反例）', () => {
  test('标题含 Authorization: Bearer abc123 被拒：给字段名与类别，且不回显原文', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: 'Authorization: Bearer abc123' }] },
      makeExec(workspace),
    );

    assert.equal(value.ok, false);
    assert.match(text, /标题/);
    assert.match(text, /凭据|credential/);
    assert.match(text, /不回显/);
    assert.ok(!text.includes('abc123'), '绝不能回显命中原文');
    assert.ok(!existsSync(path.join(workspace, 'memory', `M-${TODAY}.md`)), '命中即拒绝整批写入');
  });

  test('"如何配置 TOKEN 刷新流程" 必须写入成功（误伤反例）', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const { value } = await run(
      tool,
      { entries: [{ kind: 'procedure', title: '如何配置 TOKEN 刷新流程', detail: '这里只讲流程，不写具体值。' }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, true);
    assert.match(memoryText(workspace, TODAY), /如何配置 TOKEN 刷新流程/);
  });

  test('敏感命中时附上"误伤请改写"的提示句', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const { text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: '数据库口令：s3cr3t-pass-9' }] },
      makeExec(workspace),
    );
    assert.match(text, /如何配置 TOKEN 刷新流程/);
    assert.match(text, /改写为不含具体值/);
    assert.ok(!text.includes('s3cr3t-pass-9'));
  });
});

describe('memory_write：重复与相似（§14.13／§14.14）', () => {
  test('精确重复被拒绝，且返回重复的编号；整批不写入', async () => {
    const workspace = makeWorkspace();
    seedMemory(
      workspace,
      '2026-09-19',
      ['## 事实', '- [#0011] web profile 使用 3080 端口', '  - 标签：port', '  - 创建：2026-09-19', ''].join('\n'),
    );
    const tool = createWriteTool(makeDeps(workspace));

    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: 'web profile 使用 3080 端口' }] },
      makeExec(workspace),
    );

    assert.equal(value.ok, false);
    assert.match(text, /#0011/);
    assert.match(text, /duplicate/);
    assert.ok(!existsSync(path.join(workspace, 'memory', `M-${TODAY}.md`)), '整批不写入');
  });

  test('规范化后相同（全角/大小写）也算重复', async () => {
    const workspace = makeWorkspace();
    seedMemory(workspace, '2026-09-19', ['## 事实', '- [#0003] WEB Profile 使用 3080 端口', ''].join('\n'));
    const tool = createWriteTool(makeDeps(workspace));
    const { value } = await run(tool, { entries: [{ kind: 'fact', title: 'web profile 使用 3080 端口' }] }, makeExec(workspace));
    assert.equal(value.ok, false);
  });

  test('高度相似只提示不拒绝（返回候选编号与判据，条目仍写入）', async () => {
    const workspace = makeWorkspace();
    seedMemory(
      workspace,
      '2026-09-19',
      ['## 经验', '- [#0008] DSH bundle 成员变化后必须重启 profile', '  - 创建：2026-09-19', ''].join('\n'),
    );
    const tool = createWriteTool(makeDeps(workspace));

    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'lesson', title: 'DSH bundle 成员变化必须重启 profile' }] },
      makeExec(workspace),
    );

    assert.equal(value.ok, true, '相似不拒绝');
    assert.match(text, /相似提示/);
    assert.match(text, /#0008/);
    assert.match(text, /substring|edit-distance/);
    assert.match(memoryText(workspace, TODAY), /DSH bundle 成员变化必须重启 profile/);
  });
});

describe('memory_write：机械冲突与 supersedes（§7.1、§14.68）', () => {
  /**
   * 预置 #0011：事实 · web profile 使用 3080 端口（标签 port）
   *
   * @param {string} workspace
   * @returns {void}
   */
  function seed0011(workspace) {
    seedMemory(
      workspace,
      '2026-09-19',
      ['## 事实', '- [#0011] web profile 使用 3080 端口', '  - 标签：port', '  - 创建：2026-09-19', ''].join('\n'),
    );
  }

  test('第一通：命中冲突 → 不写入 + 给出"重发并带 supersedes"的下一步', async () => {
    const workspace = makeWorkspace();
    seed0011(workspace);
    const tool = createWriteTool(makeDeps(workspace));

    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['port'] }] },
      makeExec(workspace),
    );

    assert.equal(value.ok, false);
    assert.match(text, /冲突/);
    assert.match(text, /#0011/);
    assert.match(text, /supersedes:\["#0011"\]/);
    assert.ok(!existsSync(path.join(workspace, 'memory', `M-${TODAY}.md`)), '冲突条目不写入');
  });

  test('第二通：带 supersedes 重发成功，被取代条目退出注入（原子替换）', async () => {
    const workspace = makeWorkspace();
    seed0011(workspace);
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: 'web profile 监听 3180 端口', tags: ['port'], supersedes: ['#0011'] }] },
      exec,
    );

    assert.equal(value.ok, true, text);
    assert.match(text, /已取代 #0011/);
    const old = memoryText(workspace, '2026-09-19');
    assert.match(old, /状态：superseded/);
    assert.match(old, /取代者：#\d{4}/);
    assert.match(memoryText(workspace, TODAY), /web profile 监听 3180 端口/);
  });

  test('四要素缺一不判冲突：跨类型 / 主题键无交集 / 其余文本不同', async () => {
    const workspace = makeWorkspace();
    seedMemory(
      workspace,
      '2026-09-19',
      [
        '## 事实',
        '- [#0011] web profile 使用 3080 端口',
        '  - 标签：port',
        '',
        '## 流程',
        '- [#0013] web profile 使用 3080 端口的排障流程',
        '  - 标签：port',
        '',
      ].join('\n'),
    );
    const tool = createWriteTool(makeDeps(workspace));

    // 同 kind（流程）里"其余文本不同"：不判冲突
    const different = await run(
      tool,
      { entries: [{ kind: 'procedure', title: 'nginx 反向代理把 3185 端口转发到后端', tags: ['port'] }] },
      makeExec(workspace),
    );
    assert.equal(different.value.ok, true, different.text);

    // 主题键无交集（标签 network 对不上 port）：不判冲突
    const noTopic = await run(
      tool,
      { entries: [{ kind: 'fact', title: 'web profile 使用 3181 端口', tags: ['network'] }] },
      makeExec(workspace),
    );
    assert.equal(noTopic.value.ok, true, noTopic.text);

    // 跨类型（事实候选 vs 事实 #0011 之外都是不同 kind 的候选）：kind 相同才有第四要素可谈
    const crossKind = await run(
      tool,
      { entries: [{ kind: 'lesson', title: 'web profile 使用 3080 端口的经验教训', tags: ['port'] }] },
      makeExec(workspace),
    );
    assert.equal(crossKind.value.ok, true, crossKind.text);
  });

  test('指纹相同（数值没变）不判冲突', async () => {
    const workspace = makeWorkspace();
    seed0011(workspace);
    const tool = createWriteTool(makeDeps(workspace));
    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: 'web profile 使用 3080 端口', tags: ['port'], status: 'candidate' }] },
      makeExec(workspace),
    );
    // 标题完全相同 → 命中 duplicate（不是 conflict）：说明"指纹相同"这一支不会走到冲突判定
    assert.equal(value.ok, false);
    assert.match(text, /duplicate/);
  });

  test('supersedes 指向已 superseded 的条目 → 拒绝并返回它现有的取代者', async () => {
    const workspace = makeWorkspace();
    seedMemory(
      workspace,
      '2026-09-19',
      ['## 事实', '- [#0011] 旧结论', '  - 状态：superseded', '  - 取代者：#0020', ''].join('\n'),
    );
    const tool = createWriteTool(makeDeps(workspace));
    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: '新结论', supersedes: ['#0011'] }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, false);
    assert.match(text, /#0020/);
    assert.match(text, /conflict/);
  });
});

describe('memory_write：参数机械校验（§14.71）', () => {
  test('title 为空 / 带换行 / 161 字 → invalid_param 且整批不写入', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    const empty = await run(tool, { entries: [{ kind: 'fact', title: '   ' }] }, exec);
    assert.equal(empty.value.ok, false);
    assert.match(empty.text, /invalid_param/);
    assert.match(empty.text, /第 1 条/);

    const multiline = await run(tool, { entries: [{ kind: 'fact', title: '第一行\n第二行' }] }, exec);
    assert.equal(multiline.value.ok, false);
    assert.match(multiline.text, /单行/);

    const tooLong = await run(tool, { entries: [{ kind: 'fact', title: 'A'.repeat(161) }] }, exec);
    assert.equal(tooLong.value.ok, false);
    assert.match(tooLong.text, /161/);

    assert.ok(!existsSync(path.join(workspace, 'memory', `M-${TODAY}.md`)), '三次都不写入');
  });

  test('批量中一条失败 → 整批不写入，并逐条给原因', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const { value, text } = await run(
      tool,
      {
        entries: [
          { kind: 'fact', title: '第一条是合法的' },
          { kind: 'fact', title: '' },
          { kind: 'bogus', title: '第三条 kind 非法' },
        ],
      },
      makeExec(workspace),
    );

    assert.equal(value.ok, false);
    assert.match(text, /第 2 条/);
    assert.match(text, /第 3 条/);
    assert.match(text, /整批/);
    assert.ok(!existsSync(path.join(workspace, 'memory', `M-${TODAY}.md`)), '整批不写入');
  });

  test('expiresAt 早于今天被拒并返回设计原话；未来日期可写入', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    const past = await run(tool, { entries: [{ kind: 'fact', title: '历史结论', expiresAt: YESTERDAY }] }, exec);
    assert.equal(past.value.ok, false);
    assert.match(past.text, /有效至不得早于今天；如需记录历史结论，请留空（永久）并在/);

    const future = await run(tool, { entries: [{ kind: 'fact', title: '临时结论', expiresAt: TOMORROW }] }, exec);
    assert.equal(future.value.ok, true);
    assert.match(memoryText(workspace, TODAY), /有效至：2026-09-21/);
  });

  test('status 只接受 active／candidate；不接受 pinned／scope 等字段', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    const badStatus = await run(tool, { entries: [{ kind: 'fact', title: '状态非法', status: 'archived' }] }, exec);
    assert.equal(badStatus.value.ok, false);
    assert.match(badStatus.text, /status/);

    const pinned = await run(tool, { entries: [{ kind: 'fact', title: '试图置顶', pinned: true }] }, exec);
    assert.equal(pinned.value.ok, false);
    assert.match(pinned.text, /pinned/);

    const badKind = await run(tool, { entries: [{ kind: 'note', title: '类型非法' }] }, exec);
    assert.equal(badKind.value.ok, false);
  });

  test('relatedMemory 指向不存在编号 → not_found', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const { value, text } = await run(
      tool,
      { entries: [{ kind: 'fact', title: '引用不存在的编号', relatedMemory: ['#9999'] }] },
      makeExec(workspace),
    );
    assert.equal(value.ok, false);
    assert.match(text, /#9999/);
    assert.match(text, /not_found/);
  });

  test('顶层参数形状非法（缺 entries）抛错', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    await assert.rejects(() => tool.execute({}, makeExec(workspace)), /参数校验未通过|entries/);
    await assert.rejects(() => tool.execute({ entries: [] }, makeExec(workspace)), /entries/);
  });

  test('detail 含空行必须被拒（空行会终止条目并残留孤儿行，§5.5 第 5 条）', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    const bad = await run(
      tool,
      { entries: [{ kind: 'fact', title: '带空行详细的条目', detail: '第一段\n\n第二段' }] },
      exec,
    );
    assert.match(bad.text, /不能包含空行/, '必须当场拒绝，而不是写进去制造孤儿行');

    // 首尾空行会被去掉后正常写入；内部空行才拒绝
    const ok = await run(
      tool,
      { entries: [{ kind: 'fact', title: '多行但无空行的条目', detail: '\n第一段\n第二段\n' }] },
      exec,
    );
    assert.equal(ok.value?.ok, true, `多行 detail（无空行）应当写入成功：${ok.text.slice(0, 200)}`);
  });

  test('detail 用 -／* 项目符号分行必须被拒（会被解析成字段/游离行，且逐代累积）', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace));
    const exec = makeExec(workspace);

    for (const detail of ['口径如下：\n- 第一条\n- 第二条', '口径如下：\n* 第一条']) {
      const bad = await run(tool, { entries: [{ kind: 'fact', title: '带项目符号详细的条目', detail }] }, exec);
      assert.equal(bad.value?.ok, false, '必须当场拒绝');
      assert.match(bad.text, /不能用 -／\* 项目符号分行/, '必须给出这条原因');
      assert.match(bad.text, /无法归类的行/, '必须说明后果');
    }
    assert.ok(!existsSync(path.join(workspace, 'memory', 'M-2026-09-20.md')), '被拒时不得落盘');
  });
});

describe('memory_write：权限（§7.0／§14.65）', () => {
  test('子代理／未登记会话调用被拒（执行层第二道防线）', async () => {
    const workspace = makeWorkspace();
    const tool = createWriteTool(makeDeps(workspace, { allowed: false }));
    await assert.rejects(
      () => tool.execute({ entries: [{ kind: 'fact', title: '子代理试图写记忆' }] }, makeExec(workspace)),
      /拒绝执行/,
    );
    assert.ok(!existsSync(path.join(workspace, 'memory')), '被拒时不得创建 memory/');
  });

  test('工具定义带 output（schema + render）且 isConcurrencySafe 恒为 false', () => {
    const tool = createWriteTool(makeDeps(makeWorkspace()));
    assert.equal(tool.name, 'memory_write');
    assert.equal(typeof tool.output?.render, 'function');
    assert.equal(typeof tool.output?.schema, 'object');
    assert.equal(tool.isConcurrencySafe(), false);
    assert.ok(tool.parameters?.properties?.entries);
  });
});
