/**
 * `memory_log`（设计 §7.5）。
 *
 * 关键语义：
 *  - **只追加**，不进入长期记忆索引，也不参与 usage；
 *  - 自动落到当天 `JOURNAL-YYYY-MM-DD.md`，编号由 store 用 `parse.makeJournalId(date, time, 当天已有编号)`
 *    生成并保证唯一（不重复实现编号逻辑）；
 *  - **不做长期记忆查重**（过程本来就会重复尝试）；
 *  - 仍走敏感信息检测（§7.6）；
 *  - `relatedMemoryIds` 引用不存在的编号只告警但**照写**（日志不该因引用笔误丢内容）。
 */

import {
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
  nowOf,
  okResult,
  storeWarningsSection,
  takeBoundaryWarnings,
  throwParamError,
  todayOf,
  unknownKeys,
  warningsSection,
  workspaceOf,
} from './shared.js';

const TOOL = 'memory_log';

/** 一条日志 entry 允许出现的键（§7.5 的 JSON 示例）。 */
const ENTRY_KEYS = ['title', 'content', 'result', 'tags', 'relatedMemoryIds'];

const DESCRIPTION = [
  '记录项目过程：尝试、结果、证据、决策、后续。只追加到当天 JOURNAL-YYYY-MM-DD.md，不进入长期记忆索引。',
  '什么时候用：做完一件事、试错、验证、踩坑的过程与结论（尤其是"这次是怎么解决的"）。',
  '与 memory_write 的分工：过程与证据 → memory_log；可复用的结论 → memory_write（日志不会自动升级为长期记忆）。',
  '本工具不做查重：同一件事可以记多次（过程本来就会重复尝试）。',
  '禁止：不要写入密钥、Token、Cookie、私钥、口令、含账号口令的 URL、身份证号、完整手机号、银行卡号；命中即拒绝该条。',
  'relatedMemoryIds 只接受形如 #0008 的编号；引用不存在的编号只告警但照写。',
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      minItems: 1,
      description: '要追加的日志条目（整批全成或全败）',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '必填：单行标题，一句话说清这次干了什么' },
          content: { type: 'string', description: '必填：过程与证据（怎么做的、看到什么）' },
          result: { type: 'string', description: '结果／结论' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          relatedMemoryIds: { type: 'array', items: { type: 'string' }, description: '关联的长期记忆编号，如 ["#0008"]' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['entries'],
  additionalProperties: false,
};

/**
 * 校验一条日志 entry。
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {{ deps: any, sensitive: any, known: any[], warnings: string[] }} ctx
 * @returns {{ ok: true, entry: Record<string, unknown> } | { ok: false, failures: Array<{ entryIndex: number, code: string, message: string, nextStep?: string }> }}
 */
function planLog(raw, index, ctx) {
  const { sensitive, known, warnings } = ctx;
  /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
  const failures = [];
  /** @param {string} code @param {string} message @param {string} nextStep */
  const fail = (code, message, nextStep) => failures.push({ entryIndex: index, code, message, nextStep });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_param', `entry 必须是对象（收到 ${Array.isArray(raw) ? 'array' : typeof raw}）`, '按 schema 给出条目对象');
    return { ok: false, failures };
  }
  const input = /** @type {Record<string, unknown>} */ (raw);

  const extraKeys = unknownKeys(input, ENTRY_KEYS);
  if (extraKeys.length > 0) {
    fail('invalid_param', `不接受的字段：${extraKeys.join('、')}；日志条目只接受 ${ENTRY_KEYS.join('／')}`, '删掉多余字段后重试');
  }

  let title = '';
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    fail('invalid_param', 'title 必填且不能为空', '给一句话标题');
  } else {
    title = input.title.trim();
    if (title.includes('\n') || title.includes('\r')) fail('invalid_param', 'title 必须是单行', '把细节放进 content');
  }

  let content = '';
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    fail('invalid_param', 'content 必填且不能为空', '写下过程与证据；只想要标题的话请补上正文');
  } else {
    content = input.content;
  }

  let result = '';
  if (input.result !== undefined && input.result !== null) {
    if (typeof input.result !== 'string') fail('invalid_param', 'result 必须是字符串', '去掉该字段或用字符串');
    else result = input.result;
  }

  const tags = asStringList(input.tags);
  if (tags === null) fail('invalid_param', 'tags 必须是字符串数组', '给出字符串数组，或省略该字段');

  /** @type {string[]} */
  const relatedMemoryIds = [];
  const rawRelated = asStringList(input.relatedMemoryIds);
  if (rawRelated === null) {
    fail('invalid_param', 'relatedMemoryIds 必须是字符串数组', '给出形如 ["#0008"] 的数组');
  } else {
    for (const rawId of rawRelated) {
      const id = canonicalId(rawId);
      if (id === null) {
        fail('invalid_param', `relatedMemoryIds 里的编号非法：${rawId}`, '只接受形如 #0008 的编号');
        continue;
      }
      if (!known.some((entry) => entry?.id === id)) {
        warnings.push(`日志引用不存在的记忆编号 ${id}（仍写入：日志不该因引用笔误丢内容）`);
      }
      relatedMemoryIds.push(id);
    }
  }

  // ── 敏感信息（§7.6：日志同规则，命中即拒绝该条）──
  const hits = sensitive.scanEntryTexts({ title, detail: content, tags: tags ?? [], aliases: [] });
  if (Array.isArray(hits) && hits.length > 0) {
    const described = hits
      .map((hit) => `${hit.field === '详细' ? '内容' : hit.field}（${hit.category}）`)
      .join('、');
    fail('sensitive', `命中敏感信息：${described}；不回显命中原文。${sensitive.SENSITIVE_HINT ?? ''}`, '改写为不含具体值的说明性文字后重试');
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entry: { title, content, result, tags: tags ?? [], relatedMemoryIds } };
}

/**
 * @param {any} result
 * @param {string[]} ids
 * @returns {string}
 */
function successText(result, ids) {
  /** @type {unknown[]} */
  const rawPaths = Array.isArray(result?.paths) ? result.paths : [];
  const paths = [...new Set(rawPaths.map((item) => basenameOf(item)))];
  const journalFiles = paths.filter((name) => name.startsWith('JOURNAL-'));
  /** @type {string[]} */
  const assigned = Array.isArray(result?.journalIds) && result.journalIds.length > 0 ? result.journalIds : ids;
  /** @type {string[]} */
  const lines = [
    '[memory_log 完成]',
    `做了什么：追加 ${assigned.length} 条项目日志${journalFiles.length > 0 ? `到 ${journalFiles.join('、')}` : '到当天日志文件'}。`,
    '结果：',
    ...assigned.map((id) => `- ${String(id)}`),
    '下一步建议：需要过程细节时用 memory_search(ids:["' + String(assigned[0] ?? '') + '"], detail:"full") 取全文；若其中已有可复用结论，请另用 memory_write 沉淀为长期记忆。',
  ];
  return lines.join('\n');
}

/**
 * @param {unknown} filePath
 * @returns {string}
 */
function basenameOf(filePath) {
  const parts = String(filePath ?? '').split(/[\\/]/);
  return parts[parts.length - 1] ?? String(filePath ?? '');
}

/**
 * 五工具之一：`memory_log`。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状
 * @returns {any} ToolDefinition
 */
export function createLogTool(deps) {
  return defineMemoryTool({
    name: TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(rawArgs, exec) {
      const sessionId = checkCall(deps, exec, TOOL);
      const { dedup, sensitive, errors } = modulesOf(deps);
      const args = asRecord(rawArgs, TOOL);

      const extra = unknownKeys(args, ['entries']);
      if (extra.length > 0) throwParamError(TOOL, `不接受的参数：${extra.join('、')}；本工具只接受 entries`, '去掉多余参数后重试');

      const rawEntries = args.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        throwParamError(TOOL, 'entries 必须是非空数组', '至少给出一条要记录的日志');
      }

      const today = todayOf(deps);
      const boundary = takeBoundaryWarnings(deps, sessionId);
      const model = await deps.loadProject({ workspace: workspaceOf(exec), config: deps.config });
      const known = Array.isArray(model?.entries) ? model.entries : [];

      /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
      const failures = [];
      /** @type {Array<Record<string, unknown>>} */
      const prepared = [];
      /** @type {string[]} */
      const referenceWarnings = [];

      for (let index = 0; index < rawEntries.length; index += 1) {
        const planned = planLog(rawEntries[index], index, { deps, sensitive, known, warnings: referenceWarnings });
        if (planned.ok === false) failures.push(...planned.failures);
        else prepared.push(planned.entry);
      }

      if (failures.length > 0) {
        const text = failureText({
          toolName: TOOL,
          action: `校验了 ${rawEntries.length} 条日志，其中 ${failures.length} 处不通过，按"整批全成或全败"没有追加任何一条。`,
          failures,
          nextStep: '按上面每条的原因修正后重发；本次日志文件未被改动。',
        });
        return failResult(joinSections(text, [warningsSection(referenceWarnings), boundarySectionText(boundary)]), [
          ...referenceWarnings,
          ...boundary,
        ]);
      }

      const result = await deps.applyBatch(model, [{ type: 'log', entries: prepared }], {
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
            message: typeof result?.message === 'string' ? result.message : '日志写入未完成',
            nextStep: typeof result?.nextStep === 'string' ? result.nextStep : '稍后重试',
            entryIndex: Number.isInteger(result?.entryIndex) ? result.entryIndex : undefined,
            action: '日志追加在落盘阶段失败，日志文件保持原样。',
          },
          { title: `[${TOOL} 未执行]` },
        );
        return failResult(
          joinSections(text, [storeWarningsSection(result?.warnings), warningsSection(referenceWarnings), boundarySectionText(boundary)]),
          [...referenceWarnings, ...boundary],
        );
      }

      const text = successText(result.result, []);
      return okResult(
        joinSections(text, [storeWarningsSection(result.warnings), warningsSection(referenceWarnings), boundarySectionText(boundary)]),
        [...referenceWarnings, ...boundary],
      );
    },
  });
}
