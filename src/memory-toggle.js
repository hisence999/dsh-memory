/**
 * 每会话「记忆开关」的纯逻辑（无 IO、无宿主依赖，便于单测）。
 *
 * 口径（用户 2026-10-08 当场拍板）：
 *   - 关闭范围**只含记忆能力**：不注入记忆快照 + 五个 `memory_*` 工具从该会话可见面消失；
 *     其他工具（读写文件、bash 等）完全不受影响；
 *   - 关闭后**本会话一直不生效**（不是"仅这一轮"）；
 *   - **不跨重启保留**：状态放进程内存，DSH 重启后回到默认「开」。
 *
 * 本模块只回答两个问题：某会话现在开着吗？怎么改？落盘与注入由调用方负责。
 */

/** 关闭时要从该会话可见面摘掉的工具名。 */
export const TOGGLE_TOOL_NAMES = Object.freeze([
  'memory_search',
  'memory_write',
  'memory_edit',
  'memory_archive',
  'memory_log',
]);

/** `/memory` 的开关子命令动词。 */
export const TOGGLE_ON_VERB = 'on';
export const TOGGLE_OFF_VERB = 'off';

/** 开关动词到布尔值的映射；不是开关动词时返回 `undefined`。 */
export function toggleVerbOf(rawVerb) {
  if (typeof rawVerb !== 'string') return undefined;
  const verb = rawVerb.trim().toLowerCase();
  if (verb === TOGGLE_ON_VERB) return true;
  if (verb === TOGGLE_OFF_VERB) return false;
  return undefined;
}

/**
 * 建一个每会话开关表。
 *
 * 默认值策略：**缺席 = 开**。所以不需要给新会话写任何初始化，
 * 也不需要担心 `agent/created` 与 UI 下发谁先到——只有"显式关过"的会话才留痕。
 *
 * @returns {{ isOn: (sessionId: string) => boolean, set: (sessionId: string, on: boolean) => boolean, clear: (sessionId: string) => void, size: () => number }}
 */
export function createToggleState() {
  /** @type {Set<string>} 显式关闭过的会话 id */
  const off = new Set();
  return {
    /**
     * 该会话的记忆是否开启。非字符串或空串按"开"处理（宁可照旧工作，也不静默失效）。
     * @param {string} sessionId
     * @returns {boolean}
     */
    isOn(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return true;
      return !off.has(sessionId);
    },
    /**
     * 设置开关。
     * @param {string} sessionId
     * @param {boolean} on
     * @returns {boolean} 是否真的发生了变化（false = 重复设置，调用方据此返回 noop 文案）
     */
    set(sessionId, on) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      const wasOn = !off.has(sessionId);
      if (wasOn === on) return false;
      if (on) off.delete(sessionId);
      else off.add(sessionId);
      return true;
    },
    /**
     * 会话销毁时清掉痕迹（避免 id 复用时串味）。
     * @param {string} sessionId
     * @returns {void}
     */
    clear(sessionId) {
      off.delete(sessionId);
    },
    /** 当前被显式关闭的会话数（诊断用）。 */
    size() {
      return off.size;
    },
  };
}

/**
 * `/memory on|off` 的结果文案。
 *
 * 措辞纪律：必须让用户明确知道"这不是删除、记忆文件没被动过"，
 * 并说清关闭的确切边界（只关记忆能力，不影响其他工具）。
 *
 * @param {boolean} on 目标状态
 * @param {boolean} changed 是否真的发生了变化
 * @returns {string}
 */
export function toggleResultText(on, changed) {
  if (on) {
    return [
      '[memory 完成]',
      '做了什么：已为本会话开启记忆功能。',
      '结果：会话边界注入记忆快照；五个 memory_* 工具重新可见。',
      changed ? '下一步建议：无需其他操作，下一条消息起即按开启状态工作。' : '下一步建议：本会话原本就是开启状态，未做改动。',
    ].join('\n');
  }
  return [
    '[memory 完成]',
    changed ? '做了什么：已为本会话关闭记忆功能。' : '做了什么：本会话原本就是关闭状态，未做改动。',
    '结果：不再注入任何记忆内容；memory_search / memory_write / memory_edit / memory_archive / memory_log 五个工具从本会话消失。',
    '说明：**只是本会话不启用，记忆文件一个字都没动**，也没有删除任何条目；其他工具（读写文件、bash 等）完全不受影响。',
    changed
      ? '下一步建议：需要恢复时再发一次 /memory on；本会话的关闭状态不跨重启保留（重启 DSH 后回到开启）。'
      : '下一步建议：当前已是关闭态；需要恢复时发 /memory on。',
  ].join('\n');
}

/**
 * 用法说明里追加开关用法（与既有的 archive/restore 用法并列）。
 * @param {string} baseUsage 既有用法文本
 * @returns {string}
 */
export function withToggleUsage(baseUsage) {
  return [
    baseUsage,
    '用法：/memory on —— 开启本会话的记忆功能（默认即开启）',
    '用法：/memory off —— 关闭本会话的记忆功能（不注入记忆、五个 memory_* 工具不可见；不删任何文件）',
  ].join('\n');
}
