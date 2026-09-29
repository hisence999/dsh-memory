/**
 * `memory_edit`（设计 §7.2）。
 *
 * 关键语义（写错就丢信息）：
 *  - 字段**省略** = 不修改；`detail: null` = 清空详细；`tags: []`／`aliases: []` = 清空该字段；
 *    `expiresAt: null` = 改回永久（早于今天同样拒绝）；
 *  - `title: null`／`kind: null`／`status: null`／`id: null` 一律非法；
 *  - 改 `kind` 必须把条目移动到目标类型的 H2 分节（渲染按分节走），返回必须报告"已从「X」分节移动到「Y」分节"；
 *  - 归档编号 → `not_found`，并提示先用 `memory_archive` 的 `restore` 恢复；
 *  - 人工兜底：`id` 缺失时允许用 `title` 精确匹配；命中多条必须拒绝并返回命中的编号列表；
 *  - 改标题／类型／状态／优先级／置信度后重新执行查重与冲突检查。
 *
 * 落盘走 `deps.applyBatch`（唯一写入入口）。
 */

import { CONFIDENCES, KIND_LABEL, KINDS, LABEL_KIND, PRIORITIES, normalize } from '../parse.js';
import {
  EXPIRES_TEXT,
  asRecord,
  asStringList,
  boundarySectionText,
  canonicalId,
  checkCall,
  defineMemoryTool,
  failureText,
  failResult,
  joinSections,
  modulesOf,
  normalizeDetail,
  nowOf,
  okResult,
  storeWarningsSection,
  takeBoundaryWarnings,
  throwParamError,
  todayOf,
  unknownKeys,
  workspaceOf,
} from './shared.js';

const TOOL = 'memory_edit';

/** 一条 edit 允许出现的键。 */
const EDIT_KEYS = ['id', 'title', 'detail', 'kind', 'status', 'priority', 'confidence', 'tags', 'aliases', 'expiresAt'];

const DESCRIPTION = [
  '修改既有长期记忆，编号不变。字段省略 = 不修改。',
  '什么时候用：补充/修正某条已有记忆的措辞、详细、标签、类型、状态、置信度、有效至。',
  '清空语义：detail: null 清空「详细」；tags: []／aliases: [] 清空该字段；expiresAt: null 改回永久。',
  '改 type（kind）会把条目移动到目标类型的 H2 分节，编号与所在文件不变。',
  '失败与原因：归档编号不能编辑（先用 memory_archive 的 restore 恢复）；expiresAt 早于今天会被拒绝。',
  '注意：编号优先。只有当 id 缺失时才允许用 title 精确匹配（命中多条会被拒绝并返回编号列表）。',
  '修正结论用本工具；替代旧结论请用 memory_write + supersedes（一次原子完成）。',
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      minItems: 1,
      description: '要修改的条目列表（整批全成或全败）',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要修改的编号，如 #0008；缺失时才回退到 title 精确匹配' },
          title: { type: 'string', description: '改标题（单行、非空、≤160 字符）；id 缺失时它被当作匹配键' },
          detail: { type: ['string', 'null'], description: 'null = 清空详细；字符串**不能包含空行**，也**不要用 `- `／`* ` 项目符号分行**（两者都会让后半段变成条目字段／无法归类的行，落盘后工具无法清理）' },
          kind: { type: 'string', enum: [...KINDS], description: '改类型 = 移动到目标分节' },
          status: { type: 'string', enum: ['active', 'candidate'], description: '只允许 active / candidate' },
          priority: { type: 'string', enum: [...PRIORITIES] },
          confidence: { type: 'string', enum: [...CONFIDENCES] },
          tags: { type: 'array', items: { type: 'string' }, description: '[] = 清空标签' },
          aliases: { type: 'array', items: { type: 'string' }, description: '[] = 清空别名' },
          expiresAt: { type: ['string', 'null'], description: 'YYYY-MM-DD；null = 改回永久；早于今天会被拒绝' },
        },
        additionalProperties: false,
      },
    },
  },
  required: ['edits'],
  additionalProperties: false,
};

/**
 * @param {any} entry
 * @returns {boolean}
 */
function isArchivedEntry(entry) {
  return entry?.status === 'archived' || (typeof entry?.archivedAt === 'string' && entry.archivedAt.length > 0);
}

/**
 * @param {string} kind
 * @returns {string}
 */
function kindLabelOf(kind) {
  return /** @type {Record<string, string>} */ (KIND_LABEL)[kind] ?? kind;
}

/**
 * 解析一条 edit 的目标条目。
 *
 * @param {Record<string, unknown>} input
 * @param {number} index
 * @param {any[]} entries
 * @returns {{ ok: true, target: any, titleAsKey: boolean } | { ok: false, failures: Array<{ entryIndex: number, code: string, message: string, nextStep?: string }> }}
 */
function resolveTarget(input, index, entries) {
  /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
  const failures = [];
  /** @type {any[]} */
  const visible = entries.filter((entry) => !isArchivedEntry(entry));

  if (input.id !== undefined) {
    if (typeof input.id !== 'string') {
      failures.push({ entryIndex: index, code: 'invalid_param', message: 'id 不能为 null，也不能是非字符串', nextStep: '给出形如 #0008 的编号' });
      return { ok: false, failures };
    }
    const id = canonicalId(input.id);
    if (id === null) {
      failures.push({ entryIndex: index, code: 'invalid_param', message: `id 非法：${input.id}`, nextStep: '给出形如 #0008 的编号' });
      return { ok: false, failures };
    }
    const target = entries.find((entry) => entry?.id === id);
    if (target === undefined) {
      failures.push({ entryIndex: index, code: 'not_found', message: `编号 ${id} 不存在`, nextStep: '用 memory_search 确认编号' });
      return { ok: false, failures };
    }
    if (isArchivedEntry(target)) {
      failures.push({
        entryIndex: index,
        code: 'not_found',
        message: `${id} 已归档，请先用 memory_archive 的 restore 恢复再编辑`,
        nextStep: `先调用 memory_archive(action:"restore", ids:["${id}"])，再编辑`,
      });
      return { ok: false, failures };
    }
    return { ok: true, target, titleAsKey: false };
  }

  // 人工兜底：没有 id 时用 title 精确匹配
  const titleRaw = input.title;
  if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
    failures.push({ entryIndex: index, code: 'invalid_param', message: 'id 必填（或用 title 精确匹配）', nextStep: '给出形如 #0008 的编号' });
    return { ok: false, failures };
  }
  const wanted = normalize(titleRaw);
  const matched = visible.filter((entry) => normalize(entry.title) === wanted);
  if (matched.length === 0) {
    failures.push({
      entryIndex: index,
      code: 'not_found',
      message: `没有标题精确等于「${titleRaw.trim()}」的长期记忆`,
      nextStep: '用 memory_search(query:[...]) 找到编号后改用 id 指定',
    });
    return { ok: false, failures };
  }
  if (matched.length > 1) {
    const ids = matched.map((entry) => entry.id ?? '(无编号)');
    failures.push({
      entryIndex: index,
      code: 'invalid_param',
      message: `标题「${titleRaw.trim()}」匹配到多条：${ids.join('、')}；不猜你要改哪一条`,
      nextStep: '改用 id 精确指定要修改的编号',
    });
    return { ok: false, failures };
  }
  return { ok: true, target: matched[0], titleAsKey: true };
}

/**
 * 校验并构造一条 edit。
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {{ deps: any, dedup: any, sensitive: any, today: string, entries: any[], similar: Array<{ id: string, reason: string }> }} ctx
 * @returns {{ ok: true, edit: Record<string, unknown>, target: any, changes: string[], titleAsKey: boolean } | { ok: false, failures: Array<{ entryIndex: number, code: string, message: string, nextStep?: string }> }}
 */
function planEdit(raw, index, ctx) {
  const { deps, dedup, sensitive, today, entries } = ctx;
  const config = deps.config ?? {};
  const maxTitleChars = typeof config.maxTitleChars === 'number' ? config.maxTitleChars : 160;
  const detailMaxChars = typeof config.detailMaxChars === 'number' ? config.detailMaxChars : 8000;

  /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
  const failures = [];
  /** @param {string} code @param {string} message @param {string} nextStep */
  const fail = (code, message, nextStep) => failures.push({ entryIndex: index, code, message, nextStep });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_param', `edit 必须是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`, '按 schema 给出条目对象');
    return { ok: false, failures };
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const extraKeys = unknownKeys(input, EDIT_KEYS);
  if (extraKeys.length > 0) {
    fail('invalid_param', `不接受的字段：${extraKeys.join('、')}（本工具不接受 置顶／pinned／scope 之类字段）`, '删掉这些字段后重试');
    return { ok: false, failures };
  }

  const resolved = resolveTarget(input, index, entries);
  if (resolved.ok === false) return { ok: false, failures: [...failures, ...resolved.failures] };
  const target = resolved.target;

  const has = (/** @type {string} */ key) => Object.prototype.hasOwnProperty.call(input, key);

  /** @type {Record<string, unknown>} */
  const edit = { id: target.id };
  /** @type {string[]} */
  const changes = [];

  // ── title ──
  if (has('title')) {
    if (resolved.titleAsKey) {
      // 用作匹配键，不作为字段改动（会改标题就要用 id 指定）
    } else if (typeof input.title !== 'string') {
      fail('invalid_param', 'title 不能被清空（title: null 非法）', '要改标题请给非空字符串');
    } else {
      const title = input.title.trim();
      if (title.length === 0 || title.includes('\n') || title.includes('\r')) {
        fail('invalid_param', 'title 必须是非空单行文本', '把长解释放进 detail');
      } else if ([...title].length > maxTitleChars) {
        fail('invalid_param', `title 长度 ${[...title].length} 超过上限 ${maxTitleChars}`, '精简标题');
      } else {
        edit.title = title;
        changes.push(`标题：${target.title} → ${title}`);
      }
    }
  }

  // ── detail（null = 清空）──
  if (has('detail')) {
    if (input.detail === null) {
      edit.detail = null;
      changes.push('详细已清空');
    } else if (typeof input.detail === 'string') {
      if ([...input.detail].length > detailMaxChars) {
        fail('too_long', `detail 长度 ${[...input.detail].length} 超过上限 ${detailMaxChars}`, '拆条或精简');
      } else {
        // 与 memory_write 同一条约束：空行会终止条目，导致后半段残留为孤儿行并随编辑累积（§5.5 第 5 条）
        edit.detail = normalizeDetail(input.detail, (reason, nextStep) => fail('invalid_param', reason, nextStep));
        changes.push('详细已更新');
      }
    } else {
      fail('invalid_param', 'detail 必须是字符串或 null（null = 清空）', 'null 表示清空详细');
    }
  }

  // ── kind（改类型 = 移动分节）──
  if (has('kind')) {
    const value = input.kind;
    if (typeof value !== 'string') {
      fail('invalid_param', 'kind 不能被清空', `给出 ${KINDS.join(' / ')} 之一`);
    } else {
      const kind = /** @type {Record<string, string>} */ (LABEL_KIND)[value] ?? value;
      if (!KINDS.includes(/** @type {any} */ (kind))) {
        fail('invalid_param', `kind 非法：${value}`, `合法值 ${KINDS.join(' / ')}`);
      } else {
        edit.kind = kind;
        changes.push(`已从「${kindLabelOf(target.kind)}」分节移动到「${kindLabelOf(kind)}」分节`);
      }
    }
  }

  // ── status ──
  if (has('status')) {
    if (input.status !== 'active' && input.status !== 'candidate') {
      fail('invalid_param', `status 只能改成 active 或 candidate（收到 ${String(input.status)}）`, '状态只允许这两个值');
    } else {
      edit.status = input.status;
      changes.push(`状态：${String(target.status)} → ${String(input.status)}`);
    }
  }

  // ── priority / confidence ──
  if (has('priority')) {
    if (typeof input.priority !== 'string' || !PRIORITIES.includes(/** @type {any} */ (input.priority))) {
      fail('invalid_param', `priority 非法：${String(input.priority)}`, `合法值 ${PRIORITIES.join(' / ')}`);
    } else {
      edit.priority = input.priority;
      changes.push(`优先级：${String(target.priority)} → ${String(input.priority)}`);
    }
  }
  if (has('confidence')) {
    if (typeof input.confidence !== 'string' || !CONFIDENCES.includes(/** @type {any} */ (input.confidence))) {
      fail('invalid_param', `confidence 非法：${String(input.confidence)}`, `合法值 ${CONFIDENCES.join(' / ')}`);
    } else {
      edit.confidence = input.confidence;
      changes.push(`置信度：${String(target.confidence)} → ${String(input.confidence)}`);
    }
  }

  // ── expiresAt（null = 永久；早于今天拒绝）──
  if (has('expiresAt')) {
    if (input.expiresAt === null) {
      edit.expiresAt = null;
      changes.push('有效至改回永久');
    } else if (typeof input.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) {
      fail('invalid_param', `expiresAt 必须是 YYYY-MM-DD 或 null（收到 ${String(input.expiresAt)}）`, 'null = 永久');
    } else if (input.expiresAt < today) {
      fail('invalid_param', EXPIRES_TEXT, '改成今天或之后，或留空表示永久');
    } else {
      edit.expiresAt = input.expiresAt;
      changes.push(`有效至：${String(target.expiresAt)} → ${input.expiresAt}`);
    }
  }

  // ── tags / aliases（[] = 清空）──
  for (const [key, label] of /** @type {Array<[string, string]>} */ ([['tags', '标签'], ['aliases', '别名']])) {
    if (!has(key)) continue;
    const list = asStringList(input[key]);
    if (list === null) {
      fail('invalid_param', `${key} 必须是数组（[] = 清空）`, '空数组表示清空该字段');
      continue;
    }
    edit[key] = list;
    changes.push(list.length === 0 ? `${label}已清空` : `${label}更新为 ${list.length} 项`);
  }

  if (failures.length > 0) return { ok: false, failures };
  if (changes.length === 0) {
    fail('invalid_param', '这条 edit 没有要修改的字段', '给出至少一个字段（detail:null 也是修改）');
    return { ok: false, failures };
  }

  // ── 敏感信息（改后的可见文本，§7.6）──
  const nextTitle = typeof edit.title === 'string' ? edit.title : String(target.title);
  const nextDetail = edit.detail === null ? '' : typeof edit.detail === 'string' ? edit.detail : String(target.detail);
  const nextTags = /** @type {string[]} */ (Array.isArray(edit.tags) ? edit.tags : target.tags);
  const nextAliases = /** @type {string[]} */ (Array.isArray(edit.aliases) ? edit.aliases : target.aliases);
  const hits = sensitive.scanEntryTexts({ title: nextTitle, detail: nextDetail, tags: nextTags, aliases: nextAliases });
  if (Array.isArray(hits) && hits.length > 0) {
    const described =
      typeof sensitive.describeHits === 'function'
        ? sensitive.describeHits(hits)
        : hits.map((hit) => `${hit.field}（${hit.category}）`).join('、');
    fail('sensitive', `命中敏感信息：${described}；不回显命中原文。${sensitive.SENSITIVE_HINT ?? ''}`, '改写为不含具体值的说明性文字后重试');
    return { ok: false, failures };
  }

  // ── 改标题 / 类型 / 状态 / 优先级 / 置信度后重新查重与冲突（§7.2）──
  const nextKind = typeof edit.kind === 'string' ? edit.kind : String(target.kind);
  const others = entries.filter((entry) => entry !== target);
  const changed = ['title', 'kind', 'status', 'priority', 'confidence', 'tags', 'aliases'].some((key) => has(key));
  if (changed) {
    const duplicate = dedup.findDuplicate(nextTitle, others, { today });
    if (duplicate !== null && duplicate !== undefined) {
      fail(
        'duplicate',
        `改后的标题与 ${duplicate.id} 规范化后完全相同`,
        duplicate.id.startsWith('#') ? `请改写标题，或直接编辑 ${duplicate.id}` : '请改写标题',
      );
    }
    const similar = dedup.findSimilar(nextTitle, others, { today });
    for (const hit of Array.isArray(similar) ? similar : []) ctx.similar.push({ id: hit.id, reason: hit.reason });

    const conflicts = dedup.findConflicts(
      { kind: nextKind, title: nextTitle, tags: nextTags, aliases: nextAliases },
      others,
      { today, excludeIds: typeof target.id === 'string' ? [target.id] : [] },
    );
    if (Array.isArray(conflicts) && conflicts.length > 0) {
      const list = conflicts.map((item) => `${item.id}（${item.reason}）`).join('、');
      fail('conflict', `改后的内容与已有记忆冲突：${list}`, '决定是改写本条、改写对方，还是用 memory_write + supersedes 替代旧条');
    }
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, edit, target, changes, titleAsKey: resolved.titleAsKey };
}

/**
 * @param {Array<{ id: unknown, changes: string[], titleAsKey: boolean }>} planned
 * @returns {string}
 */
function successText(planned) {
  /** @type {string[]} */
  const lines = ['[memory_edit 完成]', `做了什么：修改 ${planned.length} 条长期记忆（编号不变、创建日期不变）。`, '结果：'];
  for (const item of planned) {
    lines.push(`- ${String(item.id)}：${item.changes.join('；')}`);
    if (item.titleAsKey) {
      lines.push('  （本次是按 title 精确匹配定位的；如需同时改标题，请用 id 指定并另给 title）');
    }
  }
  const first = planned[0]?.id;
  lines.push(
    typeof first === 'string'
      ? `下一步建议：本会话已注入的快照不会刷新；需要查看新值请用 memory_search(ids:["${first}"], detail:"full")。`
      : '下一步建议：本会话已注入的快照不会刷新；需要查看新值请用 memory_search 查询。',
  );
  return lines.join('\n');
}

/**
 * 五工具之一：`memory_edit`。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状
 * @returns {any} ToolDefinition
 */
export function createEditTool(deps) {
  return defineMemoryTool({
    name: TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(rawArgs, exec) {
      const sessionId = checkCall(deps, exec, TOOL);
      const { dedup, sensitive, errors } = modulesOf(deps);
      const args = asRecord(rawArgs, TOOL);

      const extra = unknownKeys(args, ['edits']);
      if (extra.length > 0) throwParamError(TOOL, `不接受的参数：${extra.join('、')}；本工具只接受 edits`, '去掉多余参数后重试');

      const rawEdits = args.edits;
      if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
        throwParamError(TOOL, 'edits 必须是非空数组', '至少给出一条要修改的条目');
      }

      const today = todayOf(deps);
      const boundary = takeBoundaryWarnings(deps, sessionId);
      const model = await deps.loadProject({ workspace: workspaceOf(exec), config: deps.config });
      const entries = Array.isArray(model?.entries) ? model.entries : [];

      /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
      const failures = [];
      /** @type {Array<Record<string, unknown>>} */
      const prepared = [];
      /** @type {Array<{ id: unknown, changes: string[], titleAsKey: boolean }>} */
      const planned = [];
      /** @type {Array<{ id: string, reason: string }>} */
      const similar = [];

      for (let index = 0; index < rawEdits.length; index += 1) {
        const result = planEdit(rawEdits[index], index, { deps, dedup, sensitive, today, entries, similar });
        if (result.ok === false) {
          failures.push(...result.failures);
          continue;
        }
        prepared.push(result.edit);
        planned.push({ id: result.target.id, changes: result.changes, titleAsKey: result.titleAsKey === true });
      }

      if (failures.length > 0) {
        const text = failureText({
          toolName: TOOL,
          action: `校验了 ${rawEdits.length} 条修改，其中 ${failures.length} 处不通过，按"整批全成或全败"没有改动任何条目。`,
          failures,
          nextStep: '按上面每条的原因修正后重发整批；本次记忆文件未被改动。',
        });
        return failResult(joinSections(text, [boundarySectionText(boundary)]), boundary);
      }

      const result = await deps.applyBatch(model, [{ type: 'edit', edits: prepared }], {
        config: deps.config,
        today,
        now: nowOf(deps),
        validators: {
          findDuplicate: dedup.findDuplicate,
          findSimilar: dedup.findSimilar,
          findConflicts: dedup.findConflicts,
          scanEntryTexts: sensitive.scanEntryTexts,
        },
      });

      if (result?.ok !== true) {
        const text = errors.errorToText(
          {
            ok: false,
            code: typeof result?.code === 'string' ? result.code : 'degraded',
            message: typeof result?.message === 'string' ? result.message : '修改未完成',
            nextStep: typeof result?.nextStep === 'string' ? result.nextStep : '稍后重试',
            entryIndex: Number.isInteger(result?.entryIndex) ? result.entryIndex : undefined,
            action: '整批修改在落盘阶段失败，记忆文件保持原样。',
          },
          { title: `[${TOOL} 未执行]` },
        );
        return failResult(joinSections(text, [storeWarningsSection(result?.warnings), boundarySectionText(boundary)]), boundary);
      }

      const text = successText(planned);
      return okResult(joinSections(text, [storeWarningsSection(result.warnings), boundarySectionText(boundary)]), boundary);
    },
  });
}
