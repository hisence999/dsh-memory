/**
 * 五个工具共用的管道：会话闸门、调用形状校验、返回文本装配、编号归一。
 *
 * 依据：设计 §7.0（执行层第二道防线）、§7.6（三段式返回）、§10.4（返回模板）、
 * §12.3（降级告警必须出现在工具返回里）。
 *
 * 约定：`execute` 返回的 JSON 值只带 `ok / text / warnings`，模型看到的话由 `output.render`
 * 原样投影 `text`——"返回值"与"模型看到的话"是两件事（手册 §5.3）。
 */

import * as parseModule from '../parse.js';
import * as dedupModule from '../dedup.js';
import * as sensitiveModule from '../sensitive.js';
import * as errorsModule from '../errors.js';
import * as storeModule from '../store.js';

/** @typedef {import('../parse.js').Warning} Warning */

/**
 * @typedef {object} ToolDeps 装配层构造的冻结形状（INTERFACES §3.12）
 * @property {any} config
 * @property {any} [ctx] 只用于 ctx.logger，工具里不得注册任何东西
 * @property {any} [parse]
 * @property {any} [dedup]
 * @property {any} [sensitive]
 * @property {any} [errors]
 * @property {(input: any) => Promise<any>} loadProject
 * @property {(model: any, ops: any[], opts: any) => Promise<any>} applyBatch
 * @property {() => Date} [now]
 * @property {(agent: any) => boolean} [isAllowedSession]
 * @property {(sessionId: string) => string[]} [takeBoundaryWarnings]
 * @property {string[]} [writeToolNames] 保留：装配层用它做子代理 restrict
 * @property {string} [searchToolName]
 * @property {any} [recordUsage] 装配层的形状里没有它；缺失时回落到 store.recordUsage
 */

/**
 * @typedef {object} ToolResult execute 的返回值（由 output.schema 校验）
 * @property {boolean} ok
 * @property {string} text 模型看到的话
 * @property {string[]} warnings 结构化告警（同时已拼进 text）
 */

/**
 * @typedef {object} Failure 批次里一条失败
 * @property {number} entryIndex 0 起
 * @property {string} code §7.6 错误码
 * @property {string} message
 * @property {string} [nextStep]
 */

/**
 * 取四个判定/文本模块：优先用 deps 注入的命名空间，缺失时回落到本模块的直接导入
 * （同一份实现，两条入口，便于测试单独替换）。
 *
 * @param {ToolDeps} deps
 * @returns {{ parse: any, dedup: any, sensitive: any, errors: any }}
 */
export function modulesOf(deps) {
  return {
    parse: deps?.parse ?? parseModule,
    dedup: deps?.dedup ?? dedupModule,
    sensitive: deps?.sensitive ?? sensitiveModule,
    errors: deps?.errors ?? errorsModule,
  };
}

/** 冻结的返回形状：`render` 是纯函数，UI 可以重放。 */
export const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '本次调用是否成功' },
    text: { type: 'string', description: '面向模型的中文返回文本' },
    warnings: { type: 'array', items: { type: 'string' }, description: '降级/忽略类告警' },
  },
  required: ['ok', 'text', 'warnings'],
  additionalProperties: false,
};

/**
 * 构造 `output`（工具定义必填项，手册 §5.1）。
 *
 * @returns {{ schema: object, render: (args: unknown, value: any) => Array<{ type: string, text: string }> }}
 */
export function textOutput() {
  return {
    schema: RESULT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
  };
}

/**
 * 归一长期记忆编号：`#7` / `0007` / `#0007` → `#0007`。
 *
 * @param {unknown} raw
 * @returns {string|null} 非法返回 null
 */
export function canonicalId(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const match = /^#?\s*(\d{1,6})$/.exec(text);
  if (match === null) return null;
  return `#${String(Number(match[1])).padStart(4, '0')}`;
}

/**
 * 是否日志编号（`J-YYYYMMDD-HHMM`，同分钟追加序号）。
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isJournalId(raw) {
  return typeof raw === 'string' && /^J-\d{8}-\d{4}(?:-\d+)?$/i.test(raw.trim());
}

/**
 * 归一日志编号（统一大写，其余原样）。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function canonicalJournalId(raw) {
  if (!isJournalId(raw)) return null;
  return String(raw).trim().toUpperCase();
}

/**
 * 会话 id（`exec` 上取会话身份的唯一途径是 `exec.agent`，手册 §5.3）。
 *
 * @param {any} exec
 * @returns {string}
 */
export function sessionIdOf(exec) {
  const id = exec?.agent?.id;
  return typeof id === 'string' ? id : '';
}

/**
 * 工作区根：`exec.agent.session.header.cwd`，缺失时回退进程目录
 * （与 `src/index.js` 的 `workspaceOf` 同一口径，设计 §2.1）。
 *
 * @param {any} exec
 * @returns {string}
 */
export function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * "今天"：本机本地日历日（不读系统 UTC，设计 §4.2）。
 *
 * @param {ToolDeps} deps
 * @returns {string}
 */
export function todayOf(deps) {
  const now = typeof deps?.now === 'function' ? deps.now() : new Date();
  return modulesOf(deps).parse.todayLocal(now instanceof Date ? now : new Date());
}

/**
 * 现在时刻（测试可替换）。
 *
 * @param {ToolDeps} deps
 * @returns {Date}
 */
export function nowOf(deps) {
  const value = typeof deps?.now === 'function' ? deps.now() : new Date();
  return value instanceof Date ? value : new Date();
}

/** 设计 §7.1／§7.2 指定的原话：`expiresAt` 早于今天的拒绝理由（两处必须逐字一致）。 */
export const EXPIRES_TEXT = '有效至不得早于今天；如需记录历史结论，请留空（永久）并在「详细」中说明。';

/**
 * 三段式"拒绝执行"文本（权限闸门用；不套错误码，避免把权限问题说成参数问题）。
 *
 * @param {string} toolName
 * @param {string} reason
 * @param {string} nextStep
 * @returns {string}
 */
export function refusalText(toolName, reason, nextStep) {
  return [
    `[${toolName} 拒绝执行]`,
    `做了什么：${toolName} 未执行，本次没有任何写入、也没有改动任何文件。`,
    `结果：${reason}`,
    `下一步建议：${nextStep}`,
  ].join('\n');
}

/**
 * 执行层闸门（设计 §7.0 的第二道防线）。
 *
 * @param {ToolDeps} deps
 * @param {any} exec
 * @param {string} toolName
 * @param {{ allowAnySession?: boolean }} [options] 只读工具（`memory_search`）允许子代理：只要求有会话上下文
 * @returns {string} sessionId
 */
export function checkCall(deps, exec, toolName, options = {}) {
  if (exec?.signal !== undefined && exec.signal !== null && exec.signal.aborted === true) {
    throw new Error(refusalText(toolName, '调用已被取消（signal.aborted === true）', '如仍需这次操作，请重新发起一次调用'));
  }

  const sessionId = sessionIdOf(exec);
  if (sessionId === '') {
    throw new Error(refusalText(toolName, '缺少会话上下文（exec.agent.id 为空）', '请在会话内调用本工具'));
  }

  if (options.allowAnySession === true) return sessionId;

  const allowed = typeof deps?.isAllowedSession === 'function' ? deps.isAllowedSession(exec?.agent) : false;
  if (allowed !== true) {
    const searchName = typeof deps?.searchToolName === 'string' ? deps.searchToolName : 'memory_search';
    throw new Error(
      refusalText(
        toolName,
        '调用者不是被允许的主会话（子代理或未登记会话）；四个写入类工具在子代理侧不可见（设计 §7.0）',
        `请由主会话调用 ${toolName}；子代理请改用 ${searchName} 只读查询已有记忆`,
      ),
    );
  }
  return sessionId;
}

/**
 * 参数形状：必须是普通对象。
 *
 * @param {unknown} rawArgs
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
export function asRecord(rawArgs, toolName) {
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throwParamError(toolName, `参数必须是对象（收到 ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}）`, '按工具 schema 重新给出参数');
  }
  return /** @type {Record<string, unknown>} */ (rawArgs);
}

/**
 * 找出不在白名单里的键（工具不接受 `pinned`／`scope` 这类字段，设计 §7.1/§7.2/§14.19）。
 *
 * @param {Record<string, unknown>} input
 * @param {string[]} allowed
 * @returns {string[]}
 */
export function unknownKeys(input, allowed) {
  return Object.keys(input).filter((key) => !allowed.includes(key));
}

/**
 * 参数校验失败：抛 Error（手册 §5.3：参数校验失败要抛 Error，不要返回错误字符串）。
 *
 * @param {string} toolName
 * @param {string} reason
 * @param {string} [nextStep]
 * @param {number} [entryIndex]
 * @returns {never}
 */
export function throwParamError(toolName, reason, nextStep = '按工具 schema 修正参数后重试', entryIndex) {
  const where = Number.isInteger(entryIndex) ? `第 ${Number(entryIndex) + 1} 条：` : '';
  throw new Error(
    [
      `[${toolName} 参数校验未通过]`,
      `做了什么：${toolName} 未执行，本次没有任何写入。`,
      `结果：${where}${reason}（错误码：invalid_param）`,
      `下一步建议：${nextStep}`,
    ].join('\n'),
  );
}

/**
 * 拼装"做了什么 / 结果 / 下一步建议"三段式失败文本（批次内的逐条原因）。
 *
 * @param {{ toolName: string, action: string, failures: Failure[], nextStep?: string }} input
 * @returns {string}
 */
export function failureText({ toolName, action, failures, nextStep }) {
  /** @type {string[]} */
  const lines = [`[${toolName} 未执行]`, `做了什么：${action}`, '结果：'];
  for (const item of failures) {
    const where = Number.isInteger(item.entryIndex) ? `第 ${item.entryIndex + 1} 条` : '整批';
    const advice = typeof item.nextStep === 'string' && item.nextStep.length > 0 ? `（下一步：${item.nextStep}）` : '';
    lines.push(`- ${where}（${item.code}）：${item.message}${advice}`);
  }
  lines.push(`下一步建议：${nextStep ?? '按上面每条的原因修正后重发整批；本次一条都没有写入。'}`);
  return lines.join('\n');
}

/**
 * 告警段（结构化告警 → 中文列表）。
 *
 * @param {unknown} list
 * @param {string} title
 * @returns {string}
 */
function section(list, title) {
  const items = (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? item : describeWarning(item)))
    .filter((item) => item.length > 0);
  if (items.length === 0) return '';
  return [title, ...items.map((item) => `- ${item}`)].join('\n');
}

/**
 * @param {unknown} warning
 * @returns {string}
 */
function describeWarning(warning) {
  if (warning === null || typeof warning !== 'object') return '';
  const item = /** @type {Warning} */ (warning);
  if (typeof item.message !== 'string' || item.message.length === 0) return '';
  return typeof item.code === 'string' && item.code.length > 0 ? `${item.code}: ${item.message}` : item.message;
}

/**
 * 会话边界降级告警段（§12.3：取一次就清空，必须出现在工具返回里）。
 *
 * @param {ToolDeps} deps
 * @param {string} sessionId
 * @returns {string[]} 供返回的 warnings 数组
 */
export function takeBoundaryWarnings(deps, sessionId) {
  if (typeof deps?.takeBoundaryWarnings !== 'function' || sessionId.length === 0) return [];
  try {
    const list = deps.takeBoundaryWarnings(sessionId);
    return (Array.isArray(list) ? list : []).filter((item) => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

/**
 * 把若干段文本拼到正文后面（空段忽略）。
 *
 * @param {string} text
 * @param {Array<string|string[]>} sections
 * @returns {string}
 */
export function joinSections(text, sections) {
  /** @type {string[]} */
  const parts = [text];
  for (const item of sections) {
    if (typeof item === 'string' && item.length > 0) parts.push(item);
  }
  return parts.join('\n\n');
}

/**
 * 告警列表 → 文本段。
 *
 * @param {string[]} list
 * @returns {string}
 */
export function warningsSection(list) {
  return section(list, '【告警】');
}

/**
 * 会话边界降级告警段（§12.3：必须出现在工具返回里，取一次就清空）。
 *
 * @param {string[]} list `takeBoundaryWarnings` 取回的字符串列表
 * @returns {string}
 */
export function boundarySectionText(list) {
  return section(list, '【降级告警（来自上次会话边界扫描；只报一次）】');
}

/**
 * store 的 warnings（`{code, message}` 对象数组）→ 文本段。
 *
 * @param {unknown} list
 * @returns {string}
 */
export function storeWarningsSection(list) {
  return section(list, '【告警（来自记忆文件扫描／写入）】');
}

/**
 * usage 记录器：`deps.recordUsage` 优先，缺失时回落到 store 的真实实现
 * （装配层的 deps 形状里没有这一项，见本次交付说明的偏差清单）。
 *
 * @param {ToolDeps} deps
 * @returns {(model: any, ids: string[], opts: { now: Date }) => Promise<any>}
 */
export function usageRecorder(deps) {
  if (typeof deps?.recordUsage === 'function') return deps.recordUsage;
  return storeModule.recordUsage;
}

/**
 * 拼一个成功的返回对象。
 *
 * @param {string} text
 * @param {string[]} warnings
 * @returns {ToolResult}
 */
export function okResult(text, warnings = []) {
  return { ok: true, text, warnings: warnings.slice() };
}

/**
 * 拼一个失败（但正常返回给模型）的返回对象。
 *
 * @param {string} text
 * @param {string[]} warnings
 * @returns {ToolResult}
 */
export function failResult(text, warnings = []) {
  return { ok: false, text, warnings: warnings.slice() };
}

/**
 * 规范化并校验 `详细`：**不允许空行，也不允许用 `- `／`* ` 项目符号分行**。
 *
 * 依据 §5.5 第 5、6 条与 §7.1：
 *   - 空行会**终止条目**：含空行的 detail 落盘后再解析时，后半段会变成孤儿行／未知字段，
 *     而且每次编辑都会再累积一批残留（真实宿主冒烟发现的缺陷：同一编号下越改越脏）；
 *   - 以 `- `／`* ` 开头的续行会被解析成**条目字段**（已知或未知）或"**无法归类的行**"（`free-field`），
 *     同样落盘后**工具再也清不掉**（孤儿行按第 6 条原样回写），并且同样**逐代累积**
 *     （2026-09-20 真机实测：一条 detail 用项目符号分行 → 之后每次编辑多留一代，`free-field` 告警从 4 条涨到 8 条）。
 *
 * 两者都因此必须**当场拒绝**，而不是"写进去再说"（§1.4 绝不静默）。
 * 允许并顺手去掉**首尾**的空白行；内部只要有空白行或项目符号行就拒绝。
 *
 * @param {string} value
 * @param {(reason: string, nextStep: string) => void} fail 调用方的失败回调（各工具的 fail 形态不同）
 * @returns {string} 规范化后的 detail
 */
export function normalizeDetail(value, fail) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  while (lines.length > 0 && (lines[0] ?? '').trim().length === 0) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length === 0) lines.pop();
  if (lines.some((line) => line.trim().length === 0)) {
    fail(
      'detail 不能包含空行',
      '空行会终止条目、让后半段残留成孤儿行并随编辑累积；需要分段请用中文分号／句号，或写成单行多句',
    );
  } else if (lines.some((line) => /^\s*[-*]\s/.test(line))) {
    fail(
      'detail 不能用 -／* 项目符号分行',
      '以 `- `／`* ` 开头的行会被解析成条目字段或"无法归类的行"，落盘后工具无法清理且会随每次编辑累积；需要分段请用中文分号／句号写在同一段里',
    );
  }
  return lines.join('\n');
}

/**
 * 字符串或字符串数组 → 规范化后的字符串数组（不合法时返回 null，由调用方报错）。
 *
 * @param {unknown} value
 * @returns {string[]|null}
 */
export function asStringList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length === 0 ? [] : [text];
  }
  if (!Array.isArray(value)) return null;
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

/**
 * 工具定义的三条硬要求（手册 §5.1／§5.3）：`output` 必填、`isConcurrencySafe` 一律 false。
 *
 * @param {{ name: string, description: string, parameters: object, execute: (args: unknown, exec: any) => Promise<any> }} input
 * @returns {any}
 */
export function defineMemoryTool(input) {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    output: textOutput(),
    isConcurrencySafe: () => false,
    execute: input.execute,
  };
}
