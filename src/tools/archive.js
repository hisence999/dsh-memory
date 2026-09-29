/**
 * `memory_archive`（设计 §7.3、§6.2、§6.4）与宿主命令 `/memory` 的共享实现。
 *
 * 职责边界：**只**做参数校验与返回文本；恢复的前置检查（编号冲突、与活动记忆精确重复、
 * 归档条目字段是否可容纳）由 store 实现，这里不重复实现（INTERFACES §3.9）。
 *
 * 措辞纪律：归档**不是删除**。条目仍完整保留在 `memory/archive/` 下、可追溯、可恢复，
 * 返回里绝不能说"已删除"（§6.4）。
 *
 * 两条入口——`memory_archive` 工具与宿主 `/memory` 命令——共用本文件的
 * `runArchiveAction`：归档/恢复一律经 `deps.applyBatch` → store 的锁、编号水位与
 * `INDEX.md` 重建；命令层**不新增任何文件操作**（task-1 的硬约束）。
 */

import { asRecord, asStringList, boundarySectionText, canonicalId, checkCall, defineMemoryTool, failResult, joinSections, modulesOf, nowOf, okResult, storeWarningsSection, takeBoundaryWarnings, throwParamError, todayOf, workspaceOf, warningsSection } from './shared.js';

const TOOL = 'memory_archive';

const DESCRIPTION = [
  '归档或恢复单条长期记忆。归档 = 从活动记忆移入 memory/archive/ 并退出注入与默认搜索；**不是删除**，随时可用 restore 恢复。',
  '什么时候用：某条记忆写错了、或已被新结论取代但不想物理删除（可追溯优先于整洁）。用户说"忘掉/删掉这条"时也用归档，并说明它仍可追溯。',
  'action: "archive" 归档（reason 建议填写，例如"已被 #0018 取代"）；action: "restore" 恢复（按归档前状态回填，reason 被忽略）。',
  '恢复的前置检查：编号冲突、与活动记忆标题精确重复、归档条目字段不可容纳 → 命中即拒绝，不自动合并。',
  '日志（JOURNAL-*）不提供逐条归档或编辑；如需更正，请再追加一条更正日志。',
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['archive', 'restore'], description: 'archive = 隐藏但保留；restore = 放回原日期文件' },
    ids: { type: 'array', minItems: 1, items: { type: 'string' }, description: '要归档/恢复的长期记忆编号，如 ["#0012"]' },
    reason: { type: 'string', description: '归档原因（归档时建议填写；恢复时忽略）' },
  },
  required: ['action', 'ids'],
  additionalProperties: false,
};

/**
 * @param {string} action
 * @param {string[]} ids
 * @param {any} result
 * @returns {string}
 */
function successText(action, ids, result) {
  const done = action === 'archive' ? result?.archived : result?.restored;
  const list = Array.isArray(done) && done.length > 0 ? done : ids;

  if (action === 'archive') {
    return [
      '[memory_archive 完成]',
      `做了什么：把 ${list.length} 条长期记忆归档（从活动文件移入 memory/archive/ 下同日期文件）。`,
      '结果：',
      ...list.map((id) => `- ${String(id)}：状态 = archived，正文与编号完整保留，已退出注入与默认搜索`),
      '下一步建议：这不是删除——条目仍可追溯；需要时用 memory_archive(action:"restore", ids:[...]) 恢复。',
    ].join('\n');
  }

  return [
    '[memory_archive 完成]',
    `做了什么：恢复 ${list.length} 条长期记忆（放回原日期文件）。`,
    '结果：',
    ...list.map((id) => `- ${String(id)}：状态按「归档前状态」回填，归档时间／归档原因／归档前状态三个字段已移除`),
    '下一步建议：如需确认内容，用 memory_search(ids:["' + String(list[0] ?? '') + '"], detail:"full")。',
  ].join('\n');
}

/**
 * 归档/恢复的**共享实现**：`memory_archive` 工具与宿主 `/memory` 命令都调它。
 *
 * 调用方负责各自的入口校验（工具：`checkCall` + 未知参数；命令：子命令语法），
 * 本函数负责参数语义校验（action/ids/reason）、敏感信息扫描、落盘与返回文本。
 * 参数形状非法时**抛 Error**（沿用工具层约定：参数校验失败要抛，不返回错误字符串）——
 * 命令层在自己的 try/catch 里把它转成 `{kind:'error', text}`。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状
 * @param {{ action: unknown, rawIds: unknown, reason?: unknown, workspace: string, sessionId: string }} input
 * @returns {Promise<{ ok: boolean, text: string, warnings: string[] }>}
 */
export async function runArchiveAction(deps, input) {
  const { sensitive, errors } = modulesOf(deps);

  const action = input?.action;
  if (action !== 'archive' && action !== 'restore') {
    throwParamError(TOOL, `action 只接受 archive 或 restore（收到 ${String(action)}）`, '用 action:"archive" 或 action:"restore"');
  }

  const rawIds = asStringList(input?.rawIds);
  if (rawIds === null || rawIds.length === 0) {
    throwParamError(TOOL, 'ids 必须是非空字符串数组', '给出至少一个形如 #0012 的编号');
  }
  const reason = input?.reason;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throwParamError(TOOL, 'reason 必须是字符串', '去掉 reason 或用字符串');
  }

  /** @type {string[]} */
  const ids = [];
  /** @type {Array<{ entryIndex: number, code: string, message: string, nextStep?: string }>} */
  const failures = [];
  for (let index = 0; index < rawIds.length; index += 1) {
    const id = canonicalId(rawIds[index]);
    if (id === null) {
      failures.push({ entryIndex: index, code: 'invalid_param', message: `编号非法：${rawIds[index]}`, nextStep: '给出形如 #0012 的编号' });
      continue;
    }
    if (ids.includes(id)) continue;
    ids.push(id);
  }

  /** @type {string[]} */
  const extraWarnings = [];
  if (action === 'restore' && typeof reason === 'string' && reason.length > 0) {
    extraWarnings.push('恢复时 reason 被忽略（设计 §7.3）：归档前状态会被回填，「归档原因」字段会被移除。');
  }
  // 归档原因不检测敏感信息（它同样落盘到 Markdown，按 §7.6 的检测范围含标题/详细/标签/别名与日志正文）
  if (typeof reason === 'string' && reason.length > 0) {
    const hit = sensitive.scanSensitive(reason);
    if (hit.hit === true) {
      failures.push({
        entryIndex: 0,
        code: 'sensitive',
        message: `归档原因命中敏感信息（${hit.category}）；不回显命中原文。${sensitive.SENSITIVE_HINT ?? ''}`,
        nextStep: '把原因改写成不含具体值的说明性文字后重试',
      });
    }
  }

  const today = todayOf(deps);
  const boundary = takeBoundaryWarnings(deps, input?.sessionId ?? '');

  if (failures.length > 0) {
    const text = [
      `[${TOOL} 未执行]`,
      '做了什么：参数校验未通过，没有改动任何条目。',
      '结果：',
      ...failures.map((item) => `- 第 ${item.entryIndex + 1} 项（${item.code}）：${item.message}（下一步：${item.nextStep ?? '修正后重试'}）`),
      '下一步建议：修正后重发；本次未改动任何文件。',
    ].join('\n');
    return failResult(joinSections(text, [warningsSection(extraWarnings), boundarySectionText(boundary)]), [...extraWarnings, ...boundary]);
  }

  const model = await deps.loadProject({ workspace: input.workspace, config: deps.config });
  const op = action === 'archive' ? { type: 'archive', ids, reason: typeof reason === 'string' ? reason : undefined } : { type: 'restore', ids };
  const result = await deps.applyBatch(model, [op], { config: deps.config, today, now: nowOf(deps) });

  if (result?.ok !== true) {
    const text = errors.errorToText(
      {
        ok: false,
        code: typeof result?.code === 'string' ? result.code : 'degraded',
        message: typeof result?.message === 'string' ? result.message : `${action} 未完成`,
        nextStep: typeof result?.nextStep === 'string' ? result.nextStep : '稍后重试',
        action: `${action === 'archive' ? '归档' : '恢复'}在落盘阶段失败，记忆文件保持原样（整批不动）。`,
      },
      { title: `[${TOOL} 未执行]` },
    );
    return failResult(joinSections(text, [storeWarningsSection(result?.warnings), warningsSection(extraWarnings), boundarySectionText(boundary)]), [
      ...extraWarnings,
      ...boundary,
    ]);
  }

  let text = successText(action, ids, result.result);
  if (action === 'restore') text = joinSections(text, [expiredHint(model, ids, today)]);
  return okResult(
    joinSections(text, [storeWarningsSection(result.warnings), warningsSection(extraWarnings), boundarySectionText(boundary)]),
    [...extraWarnings, ...boundary],
  );
}

/**
 * 五工具之一：`memory_archive`。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状
 * @returns {any} ToolDefinition
 */
export function createArchiveTool(deps) {
  return defineMemoryTool({
    name: TOOL,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(rawArgs, exec) {
      const sessionId = checkCall(deps, exec, TOOL);
      const args = asRecord(rawArgs, TOOL);

      const extra = Object.keys(args).filter((key) => !['action', 'ids', 'reason'].includes(key));
      if (extra.length > 0) throwParamError(TOOL, `不接受的参数：${extra.join('、')}`, '去掉多余参数后重试');

      return runArchiveAction(deps, {
        action: args.action,
        rawIds: args.ids,
        reason: args.reason,
        workspace: workspaceOf(exec),
        sessionId,
      });
    },
  });
}

// ───────────────────── 宿主命令 `/memory`（记忆面板的归档/恢复入口） ─────────────────────

/** 命令名：`CommandDefinition.name` 要求小写、不带前导斜杠。 */
export const MEMORY_COMMAND_NAME = 'memory';

/**
 * 用法说明：空输入、未知子命令、缺编号都返回它（**绝不抛错**）。
 * 语法冻结（task-1）：`/memory archive <#NNNN> [原因文本...]`、`/memory restore <#NNNN>`。
 */
export const MEMORY_COMMAND_USAGE = [
  '[memory] 用法说明',
  '做了什么：本次没有改动任何条目。',
  '用法：/memory archive <#NNNN> [原因文本...] —— 归档（移入 memory/archive/，不是删除，可恢复）',
  '用法：/memory restore <#NNNN> —— 恢复（按归档前状态回填）',
  '下一步建议：编号形如 #0012；archive 的原因文本可省略，restore 不需要原因。',
].join('\n');

/**
 * 解析 `/memory` 之后的原始输入。
 *
 * 依据宿主契约：`CommandInvocation.rawInput` 是"命令名之后的**原样**文本，含分隔空白"
 * （`@deepseek-ai/dsh-commands/lib/types/index.d.ts:24`），所以先 `trim` 再切词。
 *
 * 返回三态，调用方据此决定 `CommandResult.kind`：
 *   - `usage`：空输入或未知子命令 → 按 task-1 要求**成功**返回用法说明；
 *   - `invalid`：已知子命令但缺编号 → 按 `error` 返回用法说明；
 *   - `op`：`{ action, id, reason? }` 交给共享实现（编号是否合法由 `canonicalId` 判定）。
 *
 * @param {unknown} rawInput
 * @returns {{ kind: 'usage', text: string } | { kind: 'invalid', text: string } | { kind: 'op', action: 'archive'|'restore', id: string, reason?: string }}
 */
export function parseMemoryCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (text.length === 0) return { kind: 'usage', text: MEMORY_COMMAND_USAGE };

  const tokens = text.split(/\s+/);
  const verb = (tokens[0] ?? '').toLowerCase();
  if (verb !== 'archive' && verb !== 'restore') return { kind: 'usage', text: MEMORY_COMMAND_USAGE };

  const id = tokens[1];
  if (id === undefined) return { kind: 'invalid', text: MEMORY_COMMAND_USAGE };

  // restore 后面的多余文本同样透传：共享实现会按 §7.3 返回"reason 被忽略"告警，
  // 与工具路径逐字一致（用户直觉上会写原因，静默丢弃比告警更糟）。
  const reason = tokens.slice(2).join(' ').trim();
  return reason.length > 0 ? { kind: 'op', action: verb, id, reason } : { kind: 'op', action: verb, id };
}

/**
 * `/memory` 命令定义（`ctx.commands.register(definition)` 的实参）。
 *
 * 与 `memory_archive` 工具**共用 `runArchiveAction`**：同一套 store 锁/编号水位/INDEX 重建，
 * 命令层不碰文件。会话闸门也复用工具层的 `checkCall`（子代理与未登记会话一律拒绝，
 * 与"四个写入类工具在子代理侧不可见"同一口径，设计 §7.0）。
 *
 * handler 内部**必须** try/catch：任何异常都转成 `{kind:'error', text}`，绝不外抛
 * （宿主会把抛出的 handler 记成失败并写 `command/done`，但面板拿不到可读文案）。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状
 * @returns {import('../../types/dsh.d.ts').CommandDefinitionShape}
 */
export function createMemoryCommand(deps) {
  return {
    name: MEMORY_COMMAND_NAME,
    description: '归档或恢复长期记忆（等价于 memory_archive 工具，复用同一份 store 逻辑）',
    input: { hint: 'archive <#NNNN> [原因文本...] | restore <#NNNN>' },
    /** @param {import('../../types/dsh.d.ts').CommandInvocationShape} invocation */
    async handler(invocation) {
      try {
        const parsed = parseMemoryCommand(invocation?.rawInput);
        if (parsed.kind === 'usage') return { kind: 'success', text: parsed.text };
        if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.text };

        const sessionId = checkCall(deps, { agent: invocation?.agent, signal: invocation?.signal }, TOOL);
        const result = await runArchiveAction(deps, {
          action: parsed.action,
          rawIds: [parsed.id],
          reason: parsed.reason,
          workspace: workspaceOf({ agent: invocation?.agent }),
          sessionId,
        });
        return result.ok === true ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text };
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * 恢复后若该条已过期，补一句提示（设计 §6.2：恢复不清除过期派生，但要提醒）。
 *
 * @param {any} model 恢复前读取的模型
 * @param {string[]} ids
 * @param {string} today
 * @returns {string}
 */
function expiredHint(model, ids, today) {
  /** @type {any[]} */
  const entries = Array.isArray(model?.entries) ? model.entries : [];
  /** @type {string[]} */
  const expired = [];
  for (const id of ids) {
    const entry = entries.find((item) => item?.id === id);
    if (entry === undefined) continue;
    const expiresAt = typeof entry.expiresAt === 'string' ? entry.expiresAt : '永久';
    if (expiresAt !== '永久' && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt) && today > expiresAt) expired.push(id);
  }
  if (expired.length === 0) return '';
  return `【提示】${expired.join('、')} 已过期（派生 expired，不进入注入与默认搜索），建议同时更新「有效至」。`;
}
