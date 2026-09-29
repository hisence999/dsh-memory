/**
 * 统一错误码与错误返回文本（设计 §7.6）。
 *
 * 两条硬约束：
 *  1. 码表就是设计 §7.6 的九种，不增不减；`makeError` 只接受这九种（写错码是编程错误，直接抛）；
 *  2. 模型看到的文本**永远包含三件事**——做了什么 / 结果如何（编号或原因）/ 下一步建议；
 *     缺任何一段，模型只能盲猜、容易陷入重试循环（§7.1 的失败返回要求）。
 *
 * 本模块只做"把错误对象整理成文本"，不碰磁盘、不依赖任何其它模块。
 */

/**
 * 九种错误码（顺序与设计 §7.6 的码表一致）。
 * @type {readonly string[]}
 */
export const CODES = Object.freeze([
  'invalid_param',
  'not_found',
  'duplicate',
  'conflict',
  'sensitive',
  'too_long',
  'write_conflict',
  'locked',
  'degraded',
]);

/** 码 → 模型应做什么（设计 §7.6 码表最后列的"模型应做什么"，用于兜底 nextStep）。 @type {Record<string, string>} */
const DEFAULT_NEXT_STEP = {
  invalid_param: '按返回信息修正参数后重试',
  not_found: '用 memory_search 确认编号',
  duplicate: '改用 memory_edit 补充已有条目，或改写标题',
  conflict: '决定编辑旧条、改写新条，或用 memory_write + supersedes 替代',
  sensitive: '改写为不含具体值后再写入',
  too_long: '拆条或精简标题／详细',
  write_conflict: '重新读取后重试',
  locked: '稍后重试（另一个会话正在写同一个项目）',
  degraded: '看返回里的具体信息处理；必要时人工检查记忆目录',
};

/**
 * 码 → 默认的"做了什么"。工具层没有显式给 `action` 时用这段，
 * 保证三段式文本第一段永远不空。
 * @type {Record<string, string>}
 */
const DEFAULT_ACTION = {
  invalid_param: '参数校验未通过，本次没有执行任何写入。',
  not_found: '按编号查找失败，本次没有写入任何内容。',
  duplicate: '写入前的查重未通过，整批未写入。',
  conflict: '写入前的冲突检测命中，整批未写入（避免留下互相矛盾的两条）。',
  sensitive: '写入前的敏感信息检测命中，已拒绝整批写入（不回显命中原文）。',
  too_long: '长度校验未通过（超出 §5.6 的上限），本次没有写入。',
  write_conflict: '写入时发现文件被外部改动，本次没有写入（绝不覆盖人工修改）。',
  locked: '拿不到跨进程写锁，本次没有写入。',
  degraded: '运行在降级状态，本次操作未完成。',
};

/**
 * @typedef {object} ToolError 面向模型的错误对象（§7.6）
 * @property {false} ok
 * @property {string} code
 * @property {string} message 发生了什么（不回显敏感原文）
 * @property {string} nextStep 下一步建议
 * @property {number} [entryIndex] 批次内序号（0 起；渲染成"第 N 条"）
 * @property {string} [field] 出问题的字段名
 * @property {string} [action] 覆盖默认的"做了什么"
 */

/**
 * 构造一个错误对象。
 *
 * @param {string} code 必须是 §7.6 九种错误码之一
 * @param {{ message?: string, nextStep?: string, entryIndex?: number, field?: string, action?: string }} [info]
 * @returns {ToolError}
 */
export function makeError(code, info = {}) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError(`makeError 需要非空字符串错误码，收到 ${String(code)}`);
  }
  if (!CODES.includes(code)) {
    throw new TypeError(`未知的错误码「${code}」；合法值 ${CODES.join(' / ')}`);
  }

  /** @type {ToolError} */
  const error = {
    ok: false,
    code,
    message: typeof info.message === 'string' && info.message.length > 0 ? info.message : `（${code}：没有更多信息）`,
    nextStep: typeof info.nextStep === 'string' && info.nextStep.length > 0 ? info.nextStep : (DEFAULT_NEXT_STEP[code] ?? '请检查参数后重试'),
    action: typeof info.action === 'string' && info.action.length > 0 ? info.action : (DEFAULT_ACTION[code] ?? '操作未完成。'),
  };
  if (Number.isInteger(info.entryIndex)) error.entryIndex = info.entryIndex;
  if (typeof info.field === 'string' && info.field.length > 0) error.field = info.field;
  return error;
}

/**
 * 判定一个值是不是合法的错误码。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCode(value) {
  return typeof value === 'string' && CODES.includes(value);
}

/**
 * 错误对象 → 面向模型的三段式中文文本。
 *
 * 三段固定为 `做了什么：` / `结果：` / `下一步建议：`，保证任何路径下的失败返回
 * 都能回答"做了什么、结果如何、下一步怎么办"（§7.6）。
 *
 * @param {Partial<ToolError>|null|undefined} error
 * @param {{ title?: string }} [options] 可选的标题行（例如 `[memory_write 未执行]`）
 * @returns {string}
 */
export function errorToText(error, options = {}) {
  const code = isCode(error?.code) ? String(error?.code) : 'degraded';
  const message =
    typeof error?.message === 'string' && error.message.length > 0 ? error.message : (DEFAULT_ACTION[code] ?? '操作未完成');
  const nextStep =
    typeof error?.nextStep === 'string' && error.nextStep.length > 0 ? error.nextStep : (DEFAULT_NEXT_STEP[code] ?? '请检查参数后重试');
  const action =
    typeof error?.action === 'string' && error.action.length > 0 ? error.action : (DEFAULT_ACTION[code] ?? '操作未完成。');

  /** @type {string[]} */
  const lines = [];
  if (typeof options.title === 'string' && options.title.length > 0) lines.push(options.title);
  lines.push(`做了什么：${action}`);

  const index = error?.entryIndex;
  const where = Number.isInteger(index) ? `第 ${Number(index) + 1} 条：` : typeof error?.field === 'string' ? `${error.field}：` : '';
  lines.push(`结果：${where}${message}（错误码：${code}）`);
  lines.push(`下一步建议：${nextStep}`);
  return lines.join('\n');
}
