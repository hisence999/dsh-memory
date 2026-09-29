/**
 * 冒烟探针（临时，只读性质；不改任何被测代码）。
 *
 * 做的事：等第一个**顶层** agent 创建完成后，用宿主公开 API 造一次**真实形状的会话 fork**
 * （照 `dsh-api-session-controller` 的 `commands.fork()`：`ctx.agents.create({ sessionId, seed,
 * inheritedEventCount, meta: { cwd, parentSession, isSeeded: true } })`），随后用宿主自己的
 * 工具可见性解析器 `ctx.tools.get(name, agent)` 检查五个 `memory_*` 工具在 fork 会话里是否可见。
 *
 * 为什么这就是那条 BUG 的判据：模型调用工具时，`dsh-tools` 的分发路径正是用同一个
 * `resolveExecution` / `get(name, agent)` 解析；解析不到 → `ToolNotFoundError`
 * → 模型看到 `Error: unknown tool "<name>"`（code UNKNOWN_TOOL）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const name = 'fork-smoke-probe';

export const inject = ['agents', 'tools', 'sessions'];

const TOOL_NAMES = ['memory_write', 'memory_edit', 'memory_archive', 'memory_log', 'memory_search'];

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
  const outDir =
    typeof process.env.FORK_SMOKE_OUT === 'string' && process.env.FORK_SMOKE_OUT.length > 0
      ? process.env.FORK_SMOKE_OUT
      : typeof config?.outDir === 'string'
        ? config.outDir
        : process.cwd();
  const reportPath = path.join(outDir, 'fork-smoke-report.json');
  const tracePath = path.join(outDir, 'fork-smoke-trace.log');
  /** @type {string[]} */
  const trace = [];
  const say = (/** @type {string} */ line) => {
    trace.push(line);
    ctx.logger.info(`probe: ${line}`);
  };

  /** 只跑一次。 */
  let started = false;

  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent;
      const header = agent?.session?.header;
      if (typeof header?.id !== 'string') return;
      // 只对第一个顶层 agent 动作：fork 会话有 parentSession，子代理有 origin
      if (header.parentSession !== undefined || header.origin !== undefined) return;
      if (started) return;
      started = true;

      // 不在 agent/created 的 serial 派发里创建新 agent：延后一拍（headless 一次性会话寿命短，
      // 这里必须尽早开跑，否则会撞上"上下文已停用"的收尾竞态）
      setTimeout(() => {
        void run(agent, header);
      }, 150);
    } catch (error) {
      ctx.logger.warn(`probe: agent/created 处理失败 ${String(error)}`);
    }
  });

  /**
   * @param {any} parent
   * @param {any} parentHeader
   */
  async function run(parent, parentHeader) {
    /** @type {Record<string, unknown>} */
    const report = {
      pluginBuild:
        typeof process.env.FORK_SMOKE_LABEL === 'string' && process.env.FORK_SMOKE_LABEL.length > 0
          ? process.env.FORK_SMOKE_LABEL
          : typeof config?.buildLabel === 'string'
            ? config.buildLabel
            : '(未标注)',
      parent: {
        id: parentHeader.id,
        headerKeys: Object.keys(parentHeader).sort(),
        parentSession: parentHeader.parentSession ?? null,
        origin: parentHeader.origin ?? null,
        delegationDepth: parentHeader.delegationDepth ?? null,
        isSeeded: parentHeader.isSeeded ?? null,
      },
      parentVisible: {},
      fork: null,
      forkVisible: {},
      error: null,
    };

    try {
      const parentVisible = /** @type {Record<string, boolean>} */ (report.parentVisible);
      for (const toolName of TOOL_NAMES) parentVisible[toolName] = ctx.tools.get(toolName, parent) !== undefined;
      say(`父会话 ${parentHeader.id} 可见性: ${JSON.stringify(parentVisible)}`);

      const events = parent.session.snapshotEvents();
      const seed = events.slice();
      const childId = `session-fork-smoke-${Date.now()}`;
      /** @type {any} */
      let selection;
      try {
        // 没 inject 的服务读属性会抛错：拿不到就省略 agentOptions
        selection = ctx.agentDefaultModel?.currentSelection?.();
      } catch {
        selection = undefined;
      }
      say(`造 fork：seed=${seed.length} 条事件，parentSession=${parentHeader.id}`);

      const handle = await ctx.agents.create({
        sessionId: childId,
        seed,
        inheritedEventCount: seed.length,
        meta: {
          ...(parentHeader.cwd === undefined ? {} : { cwd: parentHeader.cwd }),
          parentSession: parentHeader.id,
          isSeeded: true,
        },
        ...(selection === undefined ? {} : { agentOptions: selection }),
      });

      // `agents.create()` 返回的是 AgentHandle，不是 agent 本体：必须回查注册表拿真正的 agent
      // （否则 `ctx.tools.get(name, undefined)` 会退化成"无作用域视角"，见性恒为 true → 假 PASS）
      const child = ctx.agents.get(childId) ?? handle?.agent;
      const childHeader = child?.session?.header ?? {};
      report.fork = {
        id: childHeader.id ?? childId,
        handleKeys: handle !== null && typeof handle === 'object' ? Object.keys(handle).sort() : [],
        resolvedFromRegistry: child !== undefined && childHeader.id === childId,
        headerKeys: Object.keys(childHeader).sort(),
        parentSession: childHeader.parentSession ?? null,
        origin: childHeader.origin ?? null,
        delegationDepth: childHeader.delegationDepth ?? null,
        isSeeded: childHeader.isSeeded ?? null,
      };
      if (report.fork.resolvedFromRegistry !== true) {
        throw new Error(`fork agent 未在注册表里解析出来（handle=${JSON.stringify(Object.keys(handle ?? {}))}）`);
      }
      const forkVisible = /** @type {Record<string, boolean>} */ (report.forkVisible);
      for (const toolName of TOOL_NAMES) forkVisible[toolName] = ctx.tools.get(toolName, child) !== undefined;
      say(`fork 会话 ${String(childHeader.id)} 可见性: ${JSON.stringify(forkVisible)}`);

      const writeVisible = forkVisible.memory_write === true && forkVisible.memory_log === true;
      report.verdict = writeVisible
        ? 'PASS：fork 顶层会话仍能看到四个写入类工具（不会再出现 unknown tool）'
        : 'FAIL：fork 顶层会话的写入类工具被摘掉了（就是那条 BUG）';
      say(String(report.verdict));
    } catch (error) {
      report.error = String(/** @type {any} */ (error)?.stack ?? error);
      say(`造 fork 失败：${report.error}`);
    }

    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
      fs.writeFileSync(tracePath, `${trace.join('\n')}\n`, 'utf8');
    } catch (error) {
      ctx.logger.warn(`probe: 写报告失败 ${String(error)}`);
    }
  }
}
