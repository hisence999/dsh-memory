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
 *
 * 另外三个命令子命令（`on` / `off` / `status`）**不碰任何文件**：开关表在内存里
 * （`src/memory-toggle.js`），关闭时只改两件事——注入返回空串（`src/index.js`）与
 * 五个工具从该会话可见面消失（`restrict`，只能经 `agent.ctx`）。
 */

import { TOGGLE_TOOL_NAMES, toggleResultText, toggleVerbOf, withToggleUsage } from '../memory-toggle.js';
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
 * 语法冻结（task-1）：`/memory archive <#NNNN> [原因文本...]`、`/memory restore <#NNNN>`、
 * `/memory on|off|status`（后三个由共享契约 `withToggleUsage` 并进来，本文件不再手写）。
 */
export const MEMORY_COMMAND_USAGE = withToggleUsage(
  [
    '[memory] 用法说明',
    '做了什么：本次没有改动任何条目。',
    '用法：/memory archive <#NNNN> [原因文本...] —— 归档（移入 memory/archive/，不是删除，可恢复）',
    '用法：/memory restore <#NNNN> —— 恢复（按归档前状态回填）',
    '下一步建议：编号形如 #0012；archive 的原因文本可省略，restore 不需要原因。',
  ].join('\n'),
);

/**
 * `status` 子命令的状态标记：**机器可判定**，客户端按这两个字符串初始化开关 UI
 * （跨半边契约，task-1：`/memory status` 的返回文本里必须固定含其中之一）。
 */
export const TOGGLE_STATUS_ON_TEXT = '状态：记忆已开启';
export const TOGGLE_STATUS_OFF_TEXT = '状态：记忆已关闭';

/** `/memory status` 的动词（不是开关动词，`toggleVerbOf` 不认它，故单独判定）。 */
const TOGGLE_STATUS_VERB = 'status';

/**
 * 解析 `/memory` 之后的原始输入。
 *
 * 依据宿主契约：`CommandInvocation.rawInput` 是"命令名之后的**原样**文本，含分隔空白"
 * （`@deepseek-ai/dsh-commands/lib/types/index.d.ts:24`），所以先 `trim` 再切词。
 *
 * 返回五态，调用方据此决定 `CommandResult.kind`：
 *   - `usage`：空输入或未知子命令 → 按 task-1 要求**成功**返回用法说明；
 *   - `invalid`：已知子命令但缺编号 → 按 `error` 返回用法说明；
 *   - `op`：`{ action, id, reason? }` 交给共享实现（编号是否合法由 `canonicalId` 判定）；
 *   - `toggle`：`{ on }` —— `/memory on|off`（动词判定交给共享契约 `toggleVerbOf`，大小写与空白都吃）；
 *   - `status`：只读查询，**解析层不做任何状态读写**（无副作用是硬要求）。
 *
 * 解析层只回答"用户想干什么"，不碰开关表、不碰工具面——改状态与施加/撤销 restrict 全在 handler 里。
 *
 * @param {unknown} rawInput
 * @returns {{ kind: 'usage', text: string }
 *   | { kind: 'invalid', text: string }
 *   | { kind: 'op', action: 'archive'|'restore', id: string, reason?: string }
 *   | { kind: 'toggle', on: boolean }
 *   | { kind: 'status' }}
 */
export function parseMemoryCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (text.length === 0) return { kind: 'usage', text: MEMORY_COMMAND_USAGE };

  const tokens = text.split(/\s+/);
  const verb = (tokens[0] ?? '').toLowerCase();

  const toggleOn = toggleVerbOf(verb);
  if (toggleOn !== undefined) return { kind: 'toggle', on: toggleOn };
  if (verb === TOGGLE_STATUS_VERB) return { kind: 'status' };

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
 * 五个子命令的分工：`archive`/`restore` 走 store；`on`/`off` 改本会话开关并**立即**对齐工具面；
 * `status` **只读**（客户端拿它初始化开关 UI，必须幂等且零副作用）。
 *
 * @param {any} deps INTERFACES §3.12 的冻结形状 + `toggleState`（每会话记忆开关表，装配层注入）
 * @returns {import('../../types/dsh.d.ts').CommandDefinitionShape}
 */
export function createMemoryCommand(deps) {
  return {
    name: MEMORY_COMMAND_NAME,
    description: '归档或恢复长期记忆（等价于 memory_archive 工具，复用同一份 store 逻辑）；on/off/status 开关本会话记忆',
    input: { hint: 'archive <#NNNN> [原因文本...] | restore <#NNNN> | on | off | status' },
    /** @param {import('../../types/dsh.d.ts').CommandInvocationShape} invocation */
    async handler(invocation) {
      try {
        const parsed = parseMemoryCommand(invocation?.rawInput);
        if (parsed.kind === 'usage') return { kind: 'success', text: parsed.text };
        if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.text };

        // 三个开关子命令的会话闸门：
        //   - `on` / `off` 是**写入类**（改状态、动工具面）→ 走完整闸门，与工具路径逐字同口径；
        //   - `status` 是**只读**查询，客户端要靠它初始化开关 UI，**必须总能拿到状态标记**，
        //     所以按本仓库对只读路径的既有约定用 `allowAnySession`（与 `memory_search` 同一档：
        //     只要求有会话上下文）。它仍然只读：不写状态、不施加/撤销 restrict、不碰文件。
        if (parsed.kind === 'status') {
          const sessionId = checkCall(deps, { agent: invocation?.agent, signal: invocation?.signal }, TOOL, {
            allowAnySession: true,
          });
          return { kind: 'success', text: toggleStatusText(deps, sessionId) };
        }
        if (parsed.kind === 'toggle') {
          const sessionId = checkCall(deps, { agent: invocation?.agent, signal: invocation?.signal }, TOOL);
          return { kind: 'success', text: applyToggle(deps, invocation?.agent, sessionId, parsed.on) };
        }

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
 * `/memory status` 的返回文本：**只读**，不改开关、不施加/撤销 restrict、不碰任何文件。
 *
 * 跨半边契约（task-1）：状态行**固定**写成 `状态：记忆已开启` / `状态：记忆已关闭`
 * ——客户端 `session.command('/memory status')` 后按这两个字符串判定开关 UI 的初始位置。
 * 因此这一行必须原样出现在文本里（前缀/后缀都不行），改一个字就等于改协议。
 *
 * @param {any} deps 装配层注入的 deps（读 `deps.toggleState`）
 * @param {string} sessionId
 * @returns {string}
 */
export function toggleStatusText(deps, sessionId) {
  const on = toggleStateOf(deps).isOn(sessionId);
  return [
    '[memory] 记忆开关状态',
    on ? TOGGLE_STATUS_ON_TEXT : TOGGLE_STATUS_OFF_TEXT,
    on
      ? '结果：本会话正在注入记忆快照，五个 memory_* 工具可见可用。'
      : '结果：本会话不注入任何记忆内容，五个 memory_* 工具不可见（记忆文件未被改动）。',
    // 两个动词都写出来（客户端/用户都按"可切换"理解），但建议项按当前状态给，避免"已关还建议你关"
    on
      ? '下一步建议：需要本会话不启用记忆时，用 /memory off 关闭。'
      : '下一步建议：需要恢复时用 /memory on 开启；本会话的关闭状态不跨重启保留（重启 DSH 后回到开启）。',
  ].join('\n');
}

/**
 * `/memory on|off` 的落笔：改开关 → 对齐工具面 → 返回文案。
 *
 * 为什么这里也要动工具面：命令是会话**运行中**执行的，而另一处施加点 `agent/created` 只在
 * 会话创建时跑过一次（那时还没关过记忆），不会替它摘——所以 `/memory off` 必须当场施加，
 * `/memory on` 必须调用同一份 disposer 撤销。时序与失败口径的完整说明见 `applyMemoryToolGate`。
 *
 * 施加/撤销都**只记 warn 不外抛**：命令绝不能因为工具面操作失败而让用户看不到开关结果。
 * 文案里仍然照实说状态已改（开关表与 restrict 是两件事：前者决定注入，后者决定工具可见面）。
 *
 * @param {any} deps
 * @param {any} agent `invocation.agent`（restrict 只能经它的 ctx）
 * @param {string} sessionId
 * @param {boolean} on
 * @returns {string}
 */
export function applyToggle(deps, agent, sessionId, on) {
  const state = toggleStateOf(deps);
  const changed = state.set(sessionId, on);

  if (on) {
    liftMemoryToolGate(deps, sessionId);
  } else if (changed || !hasMemoryToolGate(deps, sessionId)) {
    // 只在"状态真的变了"或"该会话还没有活闸门"时施加：
    //   - 重复 /memory off 不该再叠一层限制（`restrict` 的限制层取交集，越叠越摘不掉）；
    //   - 但若状态已是关、却没有活闸门（例如上一轮 `agent.ctx` 不可用导致施加失败），
    //     这里补一次，让命令具备自愈性——否则"关掉了但工具还在"会一直留在那儿。
    // 施加函数内部也会先撤销旧记录再施加新的一条。
    applyMemoryToolGate(deps, agent, sessionId);
  }

  return toggleResultText(on, changed);
}

/**
 * 该会话当前是否有活着的记忆工具闸门（诊断 + 幂等判据）。
 *
 * @param {any} deps
 * @param {string} sessionId
 * @returns {boolean}
 */
function hasMemoryToolGate(deps, sessionId) {
  const map = deps?.toggleRestrictors;
  return map instanceof Map && map.has(sessionId);
}

/**
 * 施加"五个记忆工具不可见"的会话级闸门，并记住撤销器。
 *
 * **时序理由（关键联动，task-1 第 6 条）**：`tools.restrict` 只在 `agent.ctx` 上生效
 * （全局 ctx 会抛错），所以它有两处调用点，缺一不可：
 *   ① `agent/created`：会话**创建时**若已是关闭态，摘掉五个工具；
 *   ② `/memory off`：命令是会话**运行中**执行的，会话创建时还没关过记忆，① 不会替它摘，
 *      所以关闭动作必须当场施加。
 * 两处都走本函数，保证日志措辞、失败行为、撤销器登记完全一致（"静默降级"是 task-1 明令要防的）。
 *
 * 撤销器存进 `deps.toggleRestrictors`（装配层创建、与会话同寿命的 Map）：`/memory on` 与
 * `agent/disposed` 靠它**精确**撤销。**先撤销旧记录再施加新的**——`restrict()` 每次调用
 * 返回一条独立限制层的撤销器，叠加只会取交集，撤销不掉旧的。
 *
 * @param {any} deps 装配层注入的 deps（读 `deps.toggleRestrictors`，写 `deps.ctx.logger.warn`）
 * @param {any} agent `invocation.agent` 或 `agent/created` 的 agent（restrict 只能经它的 ctx）
 * @param {string} sessionId
 * @returns {void}
 */
export function applyMemoryToolGate(deps, agent, sessionId) {
  const restrictors = deps?.toggleRestrictors;
  if (!(restrictors instanceof Map)) {
    // 没有可追踪的撤销器表：**不施加**。施加了也撤不掉（`/memory on` 找不到 disposer），
    // 那会让"关掉再打开"变成单向门——失败方向固定在不碰工具面这一侧。
    warnFnOf(deps)('memory: 缺少 toggleRestrictors 表，未隐藏五个 memory_* 工具（工具仍然可见；注入已按关闭处理）');
    return;
  }
  const stale = restrictors.get(sessionId);
  if (stale !== undefined) {
    restrictors.delete(sessionId);
    restoreMemoryTools(stale, warnFnOf(deps));
  }
  const dispose = disableMemoryTools(agent, warnFnOf(deps));
  // 失败时**不登记**：表里只放"真的还活着"的闸门，这样重复 /memory off 会自然重试，
  // 而不是留下一条管不住的记录把重试也挡掉。
  if (dispose !== null) restrictors.set(sessionId, dispose);
}

/**
 * 撤销该会话的记忆工具闸门（**幂等**：没有记录时什么也不做）。
 *
 * @param {any} deps
 * @param {string} sessionId
 * @returns {void}
 */
export function liftMemoryToolGate(deps, sessionId) {
  const restrictors = deps?.toggleRestrictors;
  if (!(restrictors instanceof Map)) return;
  const dispose = restrictors.get(sessionId);
  // 先删再调：disposer 抛错时表里不能留一条已经死掉的记录（否则下次 on 会去调它）
  restrictors.delete(sessionId);
  restoreMemoryTools(dispose, warnFnOf(deps));
}

/**
 * 把五个 `memory_*` 工具从**这个 agent** 的可见面摘掉，返回撤销器。
 *
 * 三条硬约束（task-1，缺一条就在真机上变成"工具还在"或"整插件加载失败"）：
 *   (a) **只能在 `agent.ctx` 上调**：`dsh-tools` 的 `restrict()` 拿不到作用域上下文会直接抛
 *       "tools.restrict() requires a scoped context (agent.ctx)"（`dsh-tools/lib/index.js:2895-2897`）；
 *   (b) **只能在工具注册之后调**：`restrict()` 会校验名字必须是"已知的全局工具"，
 *       未注册的名字直接抛错（同文件 `:2906-2908`）——本插件五个工具在 `apply()` 里同步注册，
 *       所以 `agent/created` 与命令 handler 两个调用点都晚于注册；
 *   (c) **失败必须 warn 且写明"工具仍然可见"**：静默降级是真机排查黑洞（`restrictSubagentTools`
 *       的教训）。这里把级别提到 warn，并把失败后果（工具仍然可见）写进日志原文。
 *
 * 失败返回 `null`（而不是 no-op 撤销器）：调用方据此**不登记**这条闸门，
 * 于是重复关闭会自然重试，而不是留下一条管不住的记录把重试也挡掉。
 *
 * 导出原因：装配层（`src/index.js` 的 `agent/created`）与命令层（`/memory off`）要用**同一份**
 * 实现，否则两条路径的日志措辞与失败行为会漂移（这正是 task-1 要防的"静默降级"）。
 *
 * @param {any} agent
 * @param {(message: string) => void} [warn] 告警出口（装配层传 ctx.logger.warn）
 * @returns {(() => void)|null} 撤销器；失败时 null
 */
export function disableMemoryTools(agent, warn) {
  const log = typeof warn === 'function' ? warn : () => {};
  const scoped = agent?.ctx;

  // ⚠️ 两条真机教训（2026-10-08 端到端冒烟抓出，单测桩测不到）：
  //
  // ① `ctx` 是 cordis 的 Proxy，读一个**该 fiber 没有 inject 过**的服务名会**抛错**而不是
  //    返回 undefined：`cannot get property "tools" without inject`（`cordis/lib/index.js:676`）。
  //    所以 `scoped.tools` 这句本身就可能抛，**必须整段在 try 里**；
  //    写成 `if (scoped?.tools?.restrict === undefined)` 会让异常逃出函数。
  //    真机形态下它是能解析的——`agent.ctx = createScope(loopCtx, agent).ctx`，而 AgentLoop
  //    声明了 `static inject = [..., 'tools', ...]`（`dsh-agent-loop/lib/index.js:1524-1531`），
  //    所以**直接属性访问是正确姿势**。
  //
  // ② **不要改用 `scoped.inject(['tools'], cb)` 去取服务**：该回调**不在同步栈上执行**
  //    （实测：`inject()` 返回 Fiber，回调要 await 之后才跑到），同步函数里拿到的是 undefined，
  //    结果是"闸门永远施加不上"——比 ① 更隐蔽。本函数是同步的，故只能直接属性访问。
  try {
    if (scoped === undefined || scoped === null || typeof scoped !== 'object') {
      log('memory: 会话上下文不可用，无法隐藏五个 memory_* 工具（工具仍然可见；注入已按关闭处理）');
      return null;
    }
    const tools = scoped.tools;
    if (tools === undefined || tools === null || typeof tools.restrict !== 'function') {
      log('memory: 会话上下文不可用，无法隐藏五个 memory_* 工具（工具仍然可见；注入已按关闭处理）');
      return null;
    }
    const dispose = tools.restrict({ deny: [...TOGGLE_TOOL_NAMES] });
    return typeof dispose === 'function' ? dispose : () => {};
  } catch (error) {
    log(`memory: 隐藏五个 memory_* 工具失败（工具仍然可见；注入已按关闭处理）${describeError(error)}`);
    return null;
  }
}

/**
 * 撤销一次 `disableMemoryTools` 施加的限制（**幂等**，调用方可重复调）。
 *
 * @param {(() => void)|null|undefined} dispose
 * @param {(message: string) => void} [warn]
 * @returns {void}
 */
export function restoreMemoryTools(dispose, warn) {
  if (typeof dispose !== 'function') return;
  try {
    dispose();
  } catch (error) {
    const log = typeof warn === 'function' ? warn : () => {};
    log(`memory: 撤销记忆工具限制失败（五个 memory_* 工具可能仍然不可见）${describeError(error)}`);
  }
}

/**
 * 取 deps 上的开关表。
 *
 * 缺省时**现造一个空的**：`isOn` 恒为 true、`set` 恒为 false，于是"没有开关表"退化成
 * "记忆一直开着、命令改不动状态"——失败方向固定在**不静默关掉用户记忆**这一侧
 * （与 `memory-toggle.js` 的"缺席 = 开"同一口径）。装配层总会注入真的那一份。
 *
 * @param {any} deps
 * @returns {{ isOn: (sessionId: string) => boolean, set: (sessionId: string, on: boolean) => boolean, clear: (sessionId: string) => void, size: () => number }}
 */
function toggleStateOf(deps) {
  const state = deps?.toggleState;
  if (state !== undefined && state !== null && typeof state.isOn === 'function' && typeof state.set === 'function') return state;
  return { isOn: () => true, set: () => false, clear: () => {}, size: () => 0 };
}

/**
 * 命令层的告警出口：走 `deps.ctx.logger.warn`（测试桩也实现了 warn），没有就静默。
 *
 * @param {any} deps
 * @returns {(message: string) => void}
 */
function warnFnOf(deps) {
  const logger = deps?.ctx?.logger;
  if (logger !== undefined && typeof logger.warn === 'function') {
    return (/** @type {string} */ message) => logger.warn(message);
  }
  return () => {};
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
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
