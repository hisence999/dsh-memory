/**
 * 身份判定与主会话白名单。
 *
 * 行为依据：设计 §7.0（子代理只见 `memory_search`，四个写入类工具不可见）、§17.5（只有主会话能收提醒）。
 * 事实依据（手册 §6.3／§7 的两次真实 P0，＋ 2026-09-26 的 fork 误判 P0）：
 *   - **不要用"某字段缺失"做判据**：持久化会把 `delegationDepth` 补成 0、`isSeeded` 物化出来，
 *     于是"必须缺省"的条件会把所有恢复会话判成 lineage 不明（不注入、不能写、不提醒，且全程静默）；
 *   - **不要用 `cwd` 判子会话**：子会话直接继承父的工作区，判不出来；
 *   - **不要用 `parentSession` 判子会话**：宿主 **fork 顶层会话**时同样写 `parentSession`
 *     （`dsh-session` 的 `SessionStore.fork()`、`dsh-api-session-controller` 的 `commands.fork()` 都写
 *     `meta = { cwd, parentSession: 源会话 id, isSeeded: true }`，没有 `origin`）。真子代理的权威正向特征
 *     是 `origin === 'subagent'`（`dsh-subagent` 的 `childSessionMeta()` 同时写 `delegationDepth ≥ 1`）。
 *     把 fork 顶层会话误判成子代理 → `restrict({ deny })` 摘掉四个写入类工具 → 模型一调用就撞上宿主的
 *     `Error: unknown tool "<name>"`（`UNKNOWN_TOOL`）。
 *   - **用正向特征 + 白名单**：失败方向固定在"少注入 / 拒绝写入"，可见可控。
 */

/**
 * 是否子会话（真子代理）。
 *
 * 只用**正向特征**：`origin === 'subagent'`，或 `delegationDepth > 0`
 * （第三方 provider 可能不写 `origin`，但物理 header 里深度是必填项）。
 * **`parentSession` 不能单独当判据**——宿主 fork 顶层会话时同样会写它（见文件头）。
 *
 * @param {{ origin?: string, parentSession?: string, delegationDepth?: number }|undefined|null} header
 * @returns {boolean}
 */
export function isSubagent(header) {
  if (typeof header !== 'object' || header === null) return false;
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

/**
 * 是否 **fork 出来的顶层会话分支**（宿主会话 fork，**不是**子代理）。
 *
 * 宿主两条 fork 路径写出的 meta 同形：`{ cwd, parentSession: 源会话 id, isSeeded: true }`
 * （`dsh-session/lib/index.js` 的 `SessionStore.fork()`；`dsh-api-session-controller/lib/index.js` 的
 * `commands.fork()`），`origin` 缺省、`delegationDepth` 缺省（落盘时补 0）。
 * 四个条件必须同时成立：`isSeeded` 不是明确的 `true` 就按"lineage 不明"隔离（失败方向 = 少注入）。
 *
 * @param {{ origin?: string, parentSession?: string, delegationDepth?: number, isSeeded?: boolean }|undefined|null} header
 * @returns {boolean}
 */
export function isForkedTopLevel(header) {
  if (typeof header !== 'object' || header === null) return false;
  if (header.origin !== undefined) return false;
  if (header.delegationDepth !== undefined && header.delegationDepth !== 0) return false;
  if (header.isSeeded !== true) return false;
  return typeof header.parentSession === 'string' && header.parentSession.length > 0;
}

/**
 * 是否**显式顶层**：白名单的唯一准入条件（不是"不是 subagent 就放行"）。
 *
 * `delegationDepth === 0` 必须放行——任何重开的会话 header 里都带着补零后的 0。
 * `parentSession` 单独存在有两种来源：**fork 出来的顶层会话**（放行）与**未知 lineage 的子会话**（隔离）；
 * 用 `isForkedTopLevel` 区分，判不出来就隔离。
 *
 * @param {{ origin?: string, parentSession?: string, delegationDepth?: number, isSeeded?: boolean }|undefined|null} header
 * @returns {boolean}
 */
export function isExplicitTopLevel(header) {
  if (typeof header !== 'object' || header === null) return false;
  if (header.origin !== undefined) return false;
  if (header.delegationDepth !== undefined && header.delegationDepth !== 0) return false;
  if (header.parentSession !== undefined && !isForkedTopLevel(header)) return false;
  return true;
}

/**
 * 主会话白名单。
 *
 * 它是"这是主会话"这一**身份事实**的记录，与文件读写是否成功解耦：
 * 即使目录不可写，注入仍要给出方法说明，只是没有历史正文。
 *
 * @returns {{ add: (id: string) => void, has: (id: string) => boolean, remove: (id: string) => void, size: () => number }}
 */
export function createAllowlist() {
  /** @type {Set<string>} */
  const ids = new Set();
  return {
    add(id) {
      ids.add(id);
    },
    has(id) {
      return ids.has(id);
    },
    remove(id) {
      ids.delete(id);
    },
    size() {
      return ids.size;
    },
  };
}

/**
 * 供日志用的身份描述（不要往里塞会话内容）。
 * @param {{ origin?: string, parentSession?: string, delegationDepth?: number, isSeeded?: boolean, cwd?: string }|undefined|null} header
 * @returns {string}
 */
export function describeIdentity(header) {
  if (header === undefined || header === null) return 'header=缺失';
  const parts = [];
  parts.push(`origin=${header.origin === undefined ? '未提供' : String(header.origin)}`);
  parts.push(`parentSession=${header.parentSession === undefined ? '未提供' : '有'}`);
  parts.push(`delegationDepth=${header.delegationDepth === undefined ? '未提供' : String(header.delegationDepth)}`);
  parts.push(`isSeeded=${header.isSeeded === undefined ? '未提供' : String(header.isSeeded)}`);
  return parts.join(' ');
}
