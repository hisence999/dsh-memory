/**
 * 插件入口：装配。
 *
 * 行为依据：设计 §9.1（会话边界与宿主 source 映射）、§9.2（注入只读缓存 + 日志标题段）、§7.0（子代理可见性）、
 * §17（交付完成提醒）、§12.3（降级告警必须可见）、§1.4（注入路径只读）。
 * 事实依据：手册 §3.1／§3.3／§3.4（事件时序与真实参数形状）、§4.1（提示词贡献每 step 求值）、
 * §5.3（工具定义必须带 output）、§7（子代理白名单）。
 *
 * 装配纪律：
 *   - 一切注册走 `ctx.effect()` / `ctx.on()`，随 fiber 自动撤销；
 *   - 所有事件监听器内部 try/catch：记忆功能坏掉绝不能拖垮会话；
 *   - `systemPrompt.context` 的 `text()` 每个 step 都会求值，**只读缓存、绝不做 IO**。
 */

import path from 'node:path';

import { PLUGIN_NAME, PROMPT_NAME, PROMPT_ORDER, resolveConfig } from './config.js';
import * as parseModule from './parse.js';
import { createAllowlist, describeIdentity, isExplicitTopLevel, isForkedTopLevel, isSubagent } from './identity.js';
import { applyBatch, loadProject, recordUsage, syncAtBoundary } from './store.js';
import { buildSnapshot } from './snapshot.js';
import {
  createDeliveryState,
  evaluateTurnStopping,
  onDeliverablePresented,
  onToolResult,
  onTurnStart,
} from './delivery.js';
import { buildReminderMessage } from './reminder-text.js';
import * as dedup from './dedup.js';
import * as sensitive from './sensitive.js';
import * as errors from './errors.js';
import { createWriteTool } from './tools/write.js';
import { createEditTool } from './tools/edit.js';
import { createArchiveTool, createMemoryCommand } from './tools/archive.js';
import { createSearchTool } from './tools/search.js';
import { createLogTool } from './tools/log.js';

/** 插件名（进日志、进 `MessageSource.plugin`）。 */
export const name = PLUGIN_NAME;

/** 依赖的宿主服务（每个用到的 `ctx.*` 都要在这里列出，否则静默不注入）。 */
export const inject = ['systemPrompt', 'tools'];

/** 四个写入类工具名：子代理的模型可见面里必须**没有**它们（设计 §7.0／§14.65）。 */
export const WRITE_TOOL_NAMES = Object.freeze([
  'memory_write',
  'memory_edit',
  'memory_archive',
  'memory_log',
]);

/** 只读工具名：子代理可用。 */
export const SEARCH_TOOL_NAME = 'memory_search';

/**
 * 会话的绝对工作目录；没有工作区时回退进程目录（设计 §2.1）。
 * @param {import('../types/dsh.d.ts').Agent|undefined} agent
 * @returns {string}
 */
export function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return cwd;
  return process.cwd();
}

/**
 * 当天记忆文件名（设计 §2.3 固定为 `M-YYYY-MM-DD.md`）。
 * @param {string} date
 * @returns {string}
 */
export function memoryFileName(date) {
  return `M-${date}.md`;
}

/**
 * 记忆文件的绝对路径。
 * @param {string} workspace
 * @param {string} memoryDirName
 * @param {string} date
 * @returns {string}
 */
export function memoryFilePath(workspace, memoryDirName, date) {
  return path.join(workspace, memoryDirName, memoryFileName(date));
}

/**
 * 插件入口。
 *
 * @param {import('../types/dsh.d.ts').PluginContext} ctx
 * @param {unknown} rawConfig patch 里 `config:` 的原样对象（整行替换、不深合并）
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = resolveConfig(rawConfig);
  for (const message of warnings) ctx.logger.warn(`memory: 配置项 %s`, message);

  if (config.enabled !== true) {
    ctx.logger.info('memory: enabled=false，不注册任何监听器与工具');
    return;
  }

  /** 会话边界生成的快照文本：注入求值只读它（§9.2）。 */
  /** @type {Map<string, string>} */
  const snapshots = new Map();
  /** 扫描期/边界期的降级告警：由下一次工具返回带出（§12.3）。 */
  /** @type {Map<string, string[]>} */
  const boundaryWarnings = new Map();
  /** 交付态状态机（每个会话一份）。 */
  /** @type {Map<string, ReturnType<typeof createDeliveryState>>} */
  const deliveryStates = new Map();
  const allowlist = createAllowlist();

  // ───────────────────────── 工具注册 ─────────────────────────

  const deps = {
    config,
    ctx,
    parse: parseModule,
    dedup,
    sensitive,
    errors,
    loadProject,
    applyBatch,
    recordUsage,
    now: () => new Date(),
    /** 子代理判定（工具层用它区分"子代理只读搜索"与"未登记会话"）。 */
    isSubagent,
    /** 该 agent 是否是被允许的主会话（写入类工具的执行层第二道防线）。 */
    /** @param {import('../types/dsh.d.ts').Agent|undefined} agent */
    isAllowedSession: (agent) => {
      const sessionId = agent?.id;
      if (typeof sessionId !== 'string') return false;
      if (config.includeSubagents === true) return true;
      if (isSubagent(agent?.session?.header)) return false;
      return allowlist.has(sessionId);
    },
    /** 取出并清空本会话的边界告警（工具返回里带出一次）。 */
    /** @param {string} sessionId */
    takeBoundaryWarnings: (sessionId) => {
      const list = boundaryWarnings.get(sessionId) ?? [];
      boundaryWarnings.delete(sessionId);
      return list;
    },
    writeToolNames: WRITE_TOOL_NAMES,
    searchToolName: SEARCH_TOOL_NAME,
  };

  for (const factory of [createWriteTool, createEditTool, createArchiveTool, createSearchTool, createLogTool]) {
    ctx.effect(() => ctx.tools.register(factory(deps)));
  }

  // ─────────────── 宿主命令：`/memory`（记忆可视化面板的归档/恢复入口） ───────────────
  //
  // 数据通路：面板按钮 → `session.command('/memory archive #0012 原因')` → 这里的 handler。
  // 归档/恢复**复用** tools/archive.js 的 `runArchiveAction`：锁、编号水位、INDEX 重建全在 store 里，
  // 命令层不新增任何文件操作（task-1 的硬约束）。
  //
  // 为什么**不**把 `'commands'` 写进本文件的 `inject`：宿主命令是**可选面**。写进 inject 会让
  // 旧宿主线（没有 commands 服务）整插件加载失败；用 cordis 的 deferred inject，服务缺席时
  // 回调根本不会被调用 → 自动降级成"只有五个工具、没有 /memory 命令"，零版本判断。
  // 签名出处：`@deepseek-ai/cordis/lib/types/registry.d.ts:185`
  //   `inject(inject: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>`
  // 官方同款用法：`dsh-agent-loop/lib/index.js:1570-1579`（`ctx.effect(() => ctx.inject([...], cb).dispose)`）。
  //
  // **必须用 `.call(ctx, …)`**：`inject` 是 cordis Context 上的**方法**，实现体是 `this.plugin({…})`
  // （`@deepseek-ai/cordis/lib/index.js:1599-1605`）。解引用成 `injectFn(…)` 会丢 `this`，真机直接抛
  // "Cannot read properties of undefined (reading 'plugin')"。
  const injectFn = ctx.inject;
  if (typeof injectFn === 'function') {
    ctx.effect(
      () =>
        injectFn.call(ctx, ['commands'], (childCtx) => {
          const commands = childCtx?.commands;
          if (commands === undefined || typeof commands.register !== 'function') {
            ctx.logger.warn('memory: commands 服务不可用，/memory 命令未注册（五个工具照常可用）');
            return;
          }
          childCtx.effect(() => commands.register(createMemoryCommand(deps)), 'dsh-memory: /memory 命令');
        }).dispose,
      'dsh-memory: /memory 命令',
    );
  } else {
    // 旧宿主线/测试桩：只少一个入口，工具面与注入面完全不受影响（手册 §9.7 的反面：可选服务不写进 inject）。
    ctx.logger.warn('memory: 宿主未提供 ctx.inject，/memory 命令未注册（五个工具照常可用）');
  }

  // ───────────── 注入内容：只有 C 层会话边界快照（A/B 固定说明已按用户要求整层移除） ─────────────

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: PROMPT_NAME,
      order: PROMPT_ORDER,
      text: (assemble) => {
        try {
          const scope = /** @type {{ id?: unknown, session?: { header?: object } }|undefined} */ (
            /** @type {unknown} */ (assemble?.scope)
          );
          const sessionId = typeof scope?.id === 'string' ? scope.id : undefined;
          if (sessionId === undefined) return '';

          // 只读缓存：主会话与子代理都只在**自己的会话边界**写这份文本（§9.1 会话内不重注入）。
          // 没有快照就注入空串——"边界尚未处理完""目录不可读""会话已清理"都落在这里：
          // 宁可少注入，也不注入半份内容。
          const snapshot = snapshots.get(sessionId);
          return snapshot === undefined ? '' : snapshot;
        } catch (error) {
          ctx.logger.warn(`memory: 提示词求值失败（已降级为空串）${describeError(error)}`);
          return '';
        }
      },
    }),
  );

  // ────────────────────── agent/created：会话边界 ──────────────────────

  /**
   * 子代理的会话边界快照：**只读** —— 只扫描 + 渲染，不校正编号、不重建 `INDEX.md`、不写任何文件
   * （子代理没有写入类工具，注入侧也不得替它写盘）。
   *
   * 抛错由调用方的 `try/catch` 兜住（只记 warn、该会话注入为空）：拿不到快照就少注入，
   * 绝不能让 `agent/created` 失败。
   *
   * @param {import('../types/dsh.d.ts').Agent|undefined} agent
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async function buildReadonlySnapshot(agent, sessionId) {
    const workspace = workspaceOf(agent);
    const today = parseModule.todayLocal(deps.now());
    const model = await loadProject({ workspace, config });
    for (const item of model.warnings ?? []) {
      ctx.logger.warn('memory: %s — %s', item.code, item.message);
    }
    const snapshot = buildSnapshot(model, config, { today });
    snapshots.set(sessionId, snapshot.text);
    ctx.logger.info(
      'memory: 已生成子代理只读快照（记忆 %d 条，日志标题 %d/%d 条，%d 字符）',
      snapshot.stats.indexed,
      snapshot.stats.journalShown,
      snapshot.stats.journalTotal,
      snapshot.stats.chars,
    );
  }

  ctx.on('agent/created', async (payload) => {
    try {
      const agent = payload?.agent;
      const sessionId = agent?.id;
      if (typeof sessionId !== 'string') return;
      const header = agent?.session?.header;

      // 子代理：把四个写入类工具从它的可见面里摘掉（§7.0），并建一份**只读**快照供注入
      // （不再有主/子两套固定说明——注入内容两角色一致，都是快照块）。
      if (isSubagent(header) && config.includeSubagents !== true) {
        restrictSubagentTools(agent, ctx);
        await buildReadonlySnapshot(agent, sessionId);
        return;
      }

      // lineage 闸门：只放行**显式顶层**（正向特征白名单；缺省值会被持久化物化，不能当判据）
      if (config.includeSubagents !== true && !isExplicitTopLevel(header)) {
        ctx.logger.warn(`memory: 会话 lineage 不明确，按隔离处理（${describeIdentity(header)}）`);
        return;
      }

      const firstAdmission = !allowlist.has(sessionId);
      allowlist.add(sessionId);
      // fork 出来的顶层会话与恢复会话同形（parentSession 有、origin 缺省、delegationDepth 0），
      // 但**不是子代理**：不能 restrict，注入与写入按主会话走。这条 info 是真机排查的唯一线索；
      // 只在**首次**登记时打（同一会话后续的 compact 等边界会再进这里，重复打会淹日志）。
      if (firstAdmission && isForkedTopLevel(header)) {
        ctx.logger.info('memory: 检测到 fork 顶层会话，按主会话处理（不摘写入类工具）');
      }

      const source = payload?.source;
      // §9.1 映射：compact 不算边界；其它未知来源在无快照时兜底一次
      if (source === 'compact') {
        ctx.logger.info('memory: 会话压缩不算边界，沿用已有快照');
        return;
      }
      if (source !== 'startup' && source !== 'resume' && source !== 'clear') {
        if (snapshots.has(sessionId)) return;
        ctx.logger.warn(`memory: 未知的会话来源「${String(source)}」，按新会话兜底处理一次`);
      }
      if (source === 'clear') snapshots.delete(sessionId);

      const workspace = workspaceOf(agent);
      const today = parseModule.todayLocal(deps.now());

      // 边界动作：一次性 IO（读 → 校验/自愈 → 建快照），随后注入只读缓存
      const model = await loadProject({ workspace, config });
      const synced = await syncAtBoundary(model, { config, today });
      const collected = dedupeWarnings([...(model.warnings ?? []), ...(synced.warnings ?? [])]);
      if (synced.ok !== true) {
        ctx.logger.warn(`memory: 会话边界写回未完成（${String(synced.error ?? '未知原因')}），会话继续`);
      }
      if (collected.length > 0) {
        boundaryWarnings.set(sessionId, collected.map((item) => `${item.code}: ${item.message}`));
        for (const item of collected) ctx.logger.warn('memory: %s — %s', item.code, item.message);
      }

      const fresh = synced.wrote === true ? await loadProject({ workspace, config }) : model;
      const snapshot = buildSnapshot(fresh, config, { today });
      snapshots.set(sessionId, snapshot.text);
      const stats = snapshot.stats;
      ctx.logger.info(
        'memory: 已生成会话边界快照（记忆 %d 条，置顶 %d 条，日志标题 %d/%d 条，省略记忆 %d 条、日志 %d 条，超限 %d 条，%d 字符）',
        stats.indexed,
        stats.pinnedShown,
        stats.journalShown,
        stats.journalTotal,
        stats.omitted,
        stats.journalsOmitted,
        stats.overlength,
        stats.chars,
      );
      // snapshot.js 的"已知边界"：固定表头／置顶段／说明行不可省，所以预算小到放不下它们时仍会超限。
      // 这条 warn 是唯一能从日志看出"快照被环境配置挤爆"的线索。
      if (stats.chars > config.maxSnapshotChars) {
        ctx.logger.warn(
          'memory: 快照块 %d 字符超出 maxSnapshotChars=%d（固定表头/置顶段/说明行按设计不可省），条目已按让步顺序省略到下限',
          stats.chars,
          config.maxSnapshotChars,
        );
      }
    } catch (error) {
      // 记忆功能坏掉绝不能拖垮会话创建（§1.3 第 5 条）
      ctx.logger.warn(`memory: agent/created 处理失败 ${describeError(error)}`);
    }
  });

  // ────────────────────── 交付态：轮界、交付信号、静默轮 ──────────────────────

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string') return;
      const state = deliveryStates.get(sessionId);
      if (state === undefined) return;
      if (event?.type === 'turn/start') {
        onTurnStart(state);
        return;
      }
      if (event?.type === 'deliverables/presented') {
        const item = /** @type {{ data?: { turn?: unknown } }} */ (event);
        const eventTurn = item?.data?.turn;
        onDeliverablePresented(state, typeof eventTurn === 'number' ? eventTurn : undefined, (message) =>
          ctx.logger.warn(`memory: ${message}`),
        );
      }
    } catch (error) {
      ctx.logger.warn(`memory: session/event 处理失败 ${describeError(error)}`);
    }
  });

  // `tools/result` 只用来标记「本轮有工具活动」——交付判定绝不看工具参数（§17.2）
  ctx.on('tools/result', (exec, result) => {
    try {
      const sessionId = exec?.agent?.id;
      if (typeof sessionId !== 'string' || !allowlist.has(sessionId)) return;
      if (typeof exec?.name !== 'string' || exec.name.length === 0) return;
      if (result?.isError !== false) return;
      const state = deliveryStates.get(sessionId) ?? createDeliveryState();
      deliveryStates.set(sessionId, state);
      onToolResult(state);
    } catch (error) {
      ctx.logger.warn(`memory: tools/result 处理失败 ${describeError(error)}`);
    }
  });

  // ────────────────────── 轮末：决定是否提醒（§17.3） ──────────────────────

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent;
      const sessionId = agent?.id;
      if (typeof sessionId !== 'string' || !allowlist.has(sessionId)) return;
      if (payload?.signal?.aborted === true) return;

      const turn = Number(payload?.turn);
      // `Number(null)`／`Number('')` 都是 0：必须显式要求正整数
      if (!Number.isInteger(turn) || turn <= 0) {
        ctx.logger.warn(`memory: turn-stopping 缺少有效轮次号（${String(payload?.turn)}），已跳过本轮`);
        return;
      }

      const state = deliveryStates.get(sessionId) ?? createDeliveryState();
      deliveryStates.set(sessionId, state);
      const decision = evaluateTurnStopping({
        state,
        turn,
        completionIdleTurns: config.completionIdleTurns,
        reminderCooldownTurns: config.reminderCooldownTurns,
        remindOnDelivery: config.remindOnDelivery,
      });

      if (decision.cooldownHit === true) {
        // 冷却命中：放弃这一发、不补发（§17.3）。这条日志是排查"为什么没提醒"的唯一线索
        ctx.logger.warn(
          'memory: 第 %d 轮命中提醒冷却（距上次提醒不足 %d 轮），本发放弃且不补发',
          turn,
          config.reminderCooldownTurns,
        );
        return;
      }
      if (decision.remind !== true) return;

      const workspace = workspaceOf(agent);
      const today = parseModule.todayLocal(deps.now());
      const fileName = memoryFileName(today);
      const filePath = memoryFilePath(workspace, config.memoryDirName, today);
      if (typeof agent?.steer !== 'function') {
        ctx.logger.warn('memory: agent.steer 不可用，跳过本次提醒');
        return;
      }
      agent.steer(
        buildReminderMessage({
          msgPrefix: config.reminderPrefix,
          fileName,
          filePath,
          pluginName: name,
        }),
      );
      ctx.logger.info('memory: 已提醒沉淀可复用信息（turn=%d）', turn);
    } catch (error) {
      ctx.logger.warn(`memory: turn-stopping 处理失败 ${describeError(error)}`);
    }
  });

  // ───────────────────────── 清理 ─────────────────────────

  ctx.on('agent/disposed', (payload) => {
    try {
      const sessionId = payload?.agent?.id;
      if (typeof sessionId !== 'string') return;
      allowlist.remove(sessionId);
      snapshots.delete(sessionId);
      deliveryStates.delete(sessionId);
      boundaryWarnings.delete(sessionId);
    } catch (error) {
      ctx.logger.warn(`memory: agent/disposed 处理失败 ${describeError(error)}`);
    }
  });
}

/**
 * 让子代理看不见四个写入类工具（设计 §7.0 的三条硬约束）。
 *
 * 必须在工具注册**之后**调用（`restrict` 只接受已存在的全局工具名）；
 * **只能用 deny**（`allow` 是"只保留这些"，会连带隐藏 bash/read/write，把子代理废掉）；
 * `execute` 层的白名单是第二道防线（子代理走非常规创建路径时兜底）。
 *
 * @param {import('../types/dsh.d.ts').Agent|undefined} agent
 * @param {import('../types/dsh.d.ts').PluginContext} ctx
 * @returns {void}
 */
function restrictSubagentTools(agent, ctx) {
  try {
    const scoped = agent?.ctx;
    if (scoped?.tools?.restrict === undefined) {
      ctx.logger.warn('memory: 子会话上下文不可用，无法隐藏写入类工具（执行层仍会拒绝调用）');
      return;
    }
    scoped.tools.restrict({ deny: [...WRITE_TOOL_NAMES] });
  } catch (error) {
    ctx.logger.warn(`memory: 隐藏子代理写入工具失败（执行层仍会拒绝调用）${describeError(error)}`);
  }
}

/**
 * 同一条告警去重。
 *
 * `loadProject` 与 `syncAtBoundary` 各自都会跑一遍扫描诊断，因此同一条告警可能出现两次；
 * 直接把两份拼起来会让工具返回里出现重复项（真机观察到的噪声）。按「码 + 文案」去重，保留首个。
 *
 * @param {Array<{ code?: string, message?: string }>} list
 * @returns {Array<{ code?: string, message?: string }>}
 */
function dedupeWarnings(list) {
  const seen = new Set();
  /** @type {Array<{ code?: string, message?: string }>} */
  const out = [];
  for (const item of list) {
    const key = `${String(item?.code ?? '')}\u0000${String(item?.message ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
