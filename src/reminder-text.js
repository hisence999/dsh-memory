/**
 * 交付提醒的文案与消息构造（纯逻辑，无 IO）。
 *
 * 设计依据：§17.4（投递形态，硬要求）、§10.1（收到 `[记忆插件]` 的交付提醒）、§1.4
 * （提醒是资料，不是指令）。手册依据：§4.2（`agent.steer(message)` 与 `UserMessage` 形状）、
 * §9.2（漏 `role` 让上游拒绝整个请求）。
 *
 * 全模块只用 `node:crypto`：零运行时依赖，不 import 任何 `@deepseek-ai/*`。
 *
 * 四条硬约束（缺一条就出事故）：
 *   1. 首行**逐字固定**以提醒前缀开头（默认 `[记忆插件]`）—— 它是模型识别该消息的
 *      唯一凭据，必须不随会话变化，也不受当日文件名影响；
 *   2. 消息键集合恰为 `['content','id','role','source']` 且 `role === 'user'`：
 *      适配器原样透传 `message.role`，`undefined` 会被 `JSON.stringify` 丢掉，上游随即
 *      以 `messages[N]: missing field 'role'` 拒绝整个请求；
 *   3. `source.kind` 必须是**生产者自有**取值（非空、且不得为 `'plugin'`）：V4 原生准入
 *      已整层弃用 V3 的包装形状 `{ kind: 'plugin', plugin: … }`，命中即抛
 *      `format v4 message requires a producer-owned source kind`；抛出点在宿主
 *      `session.append` 内部、插件的 try/catch 之外，所以它不表现为一条 warn，而是
 *      **整轮运行失败且提醒从不落盘**（2026-09-28 真机 P0）；
 *   4. 正文**只推动两种落笔**（可复用结论 → `memory_write`；过程与证据 → `memory_log`），
 *      并明确允许忽略；不提醒归档、编辑或搜索，也不因提醒放宽任何校验。
 */

import { randomUUID } from 'node:crypto';

/**
 * 提醒正文首行的固定前缀。
 *
 * 与 `config.js` 的 `reminderPrefix` 默认值一致；装配层通过 `msgPrefix` 传入配置值，
 * 这里保留同值兜底，使本模块单独可用且前缀永不落空（§17.4：逐字固定、不随会话变化）。
 */
const DEFAULT_REMINDER_PREFIX = '[记忆插件]';

/** 生产者归属里的插件名兜底值；装配层传入 `PLUGIN_NAME`。 */
const DEFAULT_PLUGIN_NAME = 'memory';

/**
 * 构造交付提醒正文。
 *
 * 固定模板 + 当日文件名与路径（§17.4）：前缀行、两种落笔、当日文件、可忽略声明。
 * 工具名逐字写死为 `memory_write` / `memory_log`（§7.1／§7.5 的两种落笔）——
 * 其余 `memory_*` 工具名刻意不出现（§17.4 末条）。
 *
 * @param {object} params
 * @param {string} [params.msgPrefix] 首行前缀，默认 `[记忆插件]`。
 * @param {string} params.fileName 当日记忆文件名（如 `M-2026-09-20.md`）。
 * @param {string} params.filePath 当日记忆文件绝对路径。
 * @returns {string} 提醒正文；首行以 `msgPrefix` 开头。
 */
export function buildReminderText({ msgPrefix, fileName, filePath }) {
  const prefix = typeof msgPrefix === 'string' && msgPrefix.length > 0 ? msgPrefix : DEFAULT_REMINDER_PREFIX;
  const name = typeof fileName === 'string' ? fileName : '';
  const path = typeof filePath === 'string' ? filePath : '';

  /** @type {string[]} */
  const lines = [
    `${prefix} 本轮任务已交付。请回顾这次工作，只把值得沉淀的内容落笔：`,
    '1. 以后还会复用的稳定结论（约定 / 事实 / 流程 / 经验）→ 调用 memory_write 写入长期记忆；',
    '2. 这次的过程与证据（做了什么、结果如何、结论是否已验证）→ 调用 memory_log 追加到项目日志。',
  ];

  if (name.length > 0 && path.length > 0) lines.push(`今日记忆文件：${name}（${path}）。`);
  else if (name.length > 0) lines.push(`今日记忆文件：${name}。`);
  else if (path.length > 0) lines.push(`今日记忆文件：${path}。`);

  lines.push('如果上轮已沉淀记忆或本轮确实没有值得沉淀的内容，就忽略这条提醒——它只是一次提醒，不是任务，忽略没有任何副作用。然后再次简要总结工作即可。');

  return lines.join('\n');
}

/**
 * 构造可直接交给 `agent.steer(message)` 的用户消息。
 *
 * 形状与 DSH 的 `UserMessage` 逐字对齐（手册 §4.2）：官方走 `createUserMessage()`
 * （只补 `role: 'user'`）再交给 `createMessage()` 赋 `id: randomUUID()`；本插件为保持
 * 零运行时依赖，用 `node:crypto` 手工构造等价结构。**不要**加任何额外键 ——
 * 形状自查是 `Object.keys(msg).sort()` 恰等于 `['content','id','role','source']`。
 *
 * `source.kind` 用当前 V4 的生产者归属写法 `plugin:<插件名>`：宿主对"非一方插件"的
 * 历史迁移产物正是这个取值（`dsh-session-format-v3-to-v4` 的 `producerKind`），
 * 与老会话迁移后的归属保持一致；V3 的 `{ kind: 'plugin', plugin }` 已被原生准入弃用
 * （见本模块硬约束 3）。
 *
 * @param {object} params
 * @param {string} [params.msgPrefix] 首行前缀，默认 `[记忆插件]`。
 * @param {string} params.fileName 当日记忆文件名。
 * @param {string} params.filePath 当日记忆文件绝对路径。
 * @param {string} [params.pluginName] 生产者归属里的插件名，默认 `memory`。
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: string } }}
 */
export function buildReminderMessage({ msgPrefix, fileName, filePath, pluginName }) {
  const plugin = typeof pluginName === 'string' && pluginName.length > 0 ? pluginName : DEFAULT_PLUGIN_NAME;
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: buildReminderText({ msgPrefix, fileName, filePath }) }],
    source: { kind: `plugin:${plugin}` },
  };
}
