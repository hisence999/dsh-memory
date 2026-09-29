/**
 * 开发期类型声明（declare-only，运行时零依赖）。
 *
 * 本插件不 import 任何 `@deepseek-ai/*` 包：宿主在运行时提供全部服务。
 * 工具定义以裸对象注册（`parameters` 本就是 JSON Schema），注入消息按结构构造。
 *
 * 这里声明一个**自洽的最小宿主接口**，形状逐条对照本机 DSH 0.1.6-alpha.2 检出书写，
 * 只覆盖本插件实际读取的面。**不对真实 cordis 做 module augmentation**——那依赖
 * 解析器的合并行为，容易静默失效。
 *
 * 相对旧工程（dsh-memory-hook）的两处收紧，都是为了把真实事故变成编译期错误：
 *   1. `UserMessage` 现在**要求 `id` 与 `role: 'user'`**——漏 `role` 曾让上游
 *      以 `messages[N]: missing field 'role'` 拒绝整个请求（整轮失败）。
 *   2. 补上 `tools.restrict()` 与 `Agent.ctx`——子代理"写入工具不可见"只能走这条通道
 *      （`dsh-tools/lib/types/index.d.ts:619`：`restrict(filter)` 需要作用域上下文，
 *      只约束继承的全局层，未知名字直接抛错）。
 */

/** 一条投递给模型历史的 user 角色消息（按结构消费，故不引 dsh-llm）。 */
export interface UserMessage {
  id: string;
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
  /**
   * 生产者归属：`kind` 必须非空，且**不得为 `'plugin'`**——V4 原生准入
   * （`dsh-session-format-v3-to-v4` 的 `assertV4MessageSources`）已把 V3 的
   * `{ kind: 'plugin', plugin }` 包装列为硬拒，抛出 `format v4 message requires a
   * producer-owned source kind`；抛出点在 `session.append` 内、插件 try/catch 之外，
   * 会直接把整轮打成失败（2026-09-28 真机 P0）。本插件因此用 `plugin:<插件名>`。
   */
  source: { kind: string };
}

/** SessionHeader 中本插件用到的字段（dsh-session types/types.d.ts）。 */
export interface AgentHeader {
  /** 会话创建时的绝对工作目录。注意：子会话会继承父的 cwd，不能用于身份判定。 */
  cwd?: string;
  /** 派生自哪个会话；subagent 子会话必有此字段。 */
  parentSession?: string;
  /** 粗粒度产品分类；取值域只有 'subagent'。 */
  origin?: 'subagent';
  /** 委托深度：逻辑类型可选、物理 header 必填；顶层为 0。 */
  delegationDepth?: number;
  /** 是否含 fork 继承的事件前缀。主会话 fork 也为 true，故不可用于 subagent 判定。 */
  isSeeded?: boolean;
}

export interface AgentSession {
  readonly id: string;
  readonly header: AgentHeader;
  /** 写自定义领域事件进会话日志（官方做法：`exec.agent.session.append(type, data)`）。 */
  append(type: string, data: unknown): void;
}

/** `tools.restrict` 的过滤器：只作用于继承来的全局层，两者可同时给（取交集）。 */
export interface ToolRestriction {
  /** 只保留这些全局工具名；其余全部不可见。 */
  allow?: readonly string[];
  /** 隐藏这些全局工具名。 */
  deny?: readonly string[];
}

/** 作用域上下文（`agent.ctx`）。restrict 必须通过它调用，否则会抛错。 */
export interface AgentScopedContext {
  readonly tools: ToolsService;
}

export interface Agent {
  readonly id: string;
  readonly session: AgentSession;
  /** 该 agent 的作用域上下文（通过它注册/限制的效果只作用于该 agent）。 */
  readonly ctx?: AgentScopedContext;
  /** 把模型可见上下文排入下一个 pre-step，不唤醒空闲 agent。（保留备选通道） */
  inject(message: UserMessage): void;
  /** 提交 steering 以影响最近步骤；空闲 driver 会因此开启一个轮次。 */
  steer(message: UserMessage): void;
}

/** `system-prompt/assemble` 的调用方上下文。DSH 以活跃 Agent 对象作为 scope key。 */
export interface AssembleContext {
  scope?: unknown;
}

/** 动态运行时上下文贡献（物化为带来源的 user 角色快照）。 */
export interface PromptContext {
  /** 必须全局唯一，重名注册会抛异常——一律带插件前缀。 */
  name: string;
  /** 必须是有限数；不同贡献按升序拼接。 */
  order: number;
  /** 每个模型 step 之前都会被求值；必须快、必须稳、异常必须内部吞掉并返回空串。 */
  text: string | ((context: AssembleContext) => string);
}

export interface SystemPromptService {
  context(context: PromptContext): () => void;
}

/** 工具注册所需的 schema 形状。 */
export interface ToolSchemaShape {
  name: string;
  description: string;
  /** 参数 JSON Schema 对象。 */
  parameters: Record<string, unknown>;
}

export interface ToolOutputShape {
  schema: Record<string, unknown>;
  render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
}

/** `exec`：执行身份、取消信号与归属 agent（dsh-tools 的 ToolRunContext）。 */
export interface ToolRunContextShape {
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly agent?: Agent;
  readonly signal: AbortSignal;
}

export interface ToolDefinitionShape extends ToolSchemaShape {
  /** 必填：宿主运行时强校验 `{ schema, render }`，缺失直接抛 TypeError。 */
  output: ToolOutputShape;
  execute(args: unknown, exec: ToolRunContextShape): Promise<unknown>;
  /** 协作式超时预算，绝不发给模型。 */
  timeoutMs?: number;
  /** 严格 `=== true` 才 opt-in 并行；省略即独占。 */
  isConcurrencySafe?(args: unknown): boolean;
}

export interface ToolsService {
  register(definition: ToolDefinitionShape): () => void;
  /**
   * 限制**调用方作用域**里继承的全局工具可见性。
   * 三条硬约束（设计 §7.0）：必须在目标工具注册之后调用；只能用 `deny`（`allow`
   * 会连带隐藏 bash/read 等）；未知名字会抛错。
   */
  restrict(filter: ToolRestriction): () => void;
}

// ─────────────────── 宿主命令服务（`/memory`，记忆面板的写入口） ───────────────────
// 出处（本机 DSH 0.1.7-rc.2 检出，包 `@deepseek-ai/dsh-commands`；Lead 复核时逐条核对过行号）：
//   - 服务注入名 `commands`：`lib/types/index.d.ts:15`（`export declare const name = "commands"`），
//     并靠 `lib/types/index.d.ts:63-67` 的 `declare module '@deepseek-ai/cordis'` 挂到 `ctx.commands`；
//   - `CommandRuntime.register(definition)`：`lib/types/index.d.ts:94`，返回"注销该定义的 disposer"；
//   - `CommandDefinition`：`lib/types/index.d.ts:38-55`（`name`（小写、无前导斜杠）、`description`
//     必填；`definitionId` / `input` / `recordInput` 可选；`handler` 直接面对 UI，不过模型）；
//   - `CommandInvocation`：`lib/types/index.d.ts:19-36`（`commandId` / `agent` /
//     `rawInput`＝命令名之后的**原样**文本，含分隔空白 / `attachments` / `signal`）；
//   - `CommandInputDescriptor`：`lib/types/types.d.ts:20-31`（`hint` 必填、`attachments` 可选）；
//   - `CommandResult`：`lib/types/types.d.ts:33-41`（`{kind:'success', text?}` ｜ `{kind:'error', text}`）。
//
// **取用方式**：本插件把它当**可选服务**，用 cordis 的 deferred inject 取
// （`ctx.inject(['commands'], cb)`，签名见 `@deepseek-ai/cordis/lib/types/registry.d.ts:185`），
// 因此**不写进 `export const inject`**：旧宿主线没有该服务时自动降级为"只有工具、没有命令"。

/** 命令的自由输入提示（`@deepseek-ai/dsh-commands/lib/types/types.d.ts:20-31`）。 */
export interface CommandInputDescriptorShape {
  /** 用户输入前显示的占位提示。 */
  readonly hint: string;
  /** 是否允许随命令提交附件；本插件不用，声明仅为形状完整。 */
  readonly attachments?: boolean;
}

/** 一次命令调用的调用方上下文（`lib/types/index.d.ts:19-36`）。 */
export interface CommandInvocationShape {
  /** 已写入 `command/run` 事件的配对 id。 */
  readonly commandId: unknown;
  /** 收到该命令的确切 agent。 */
  readonly agent: Agent;
  /** 命令名之后的**原样**文本（含分隔空白）——解析前必须自行 trim/切词。 */
  readonly rawInput: string;
  /** 随命令提交的附件块；未声明 `input.attachments` 时为空数组。 */
  readonly attachments: readonly unknown[];
  /** 派发该 UI 请求持有的取消信号。 */
  readonly signal: AbortSignal;
}

/** 命令结果（`lib/types/types.d.ts:33-41`）：只有两个变体，`error` 必须带文本。 */
export type CommandResultShape =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string };

/** 插件自有的命令注册（`lib/types/index.d.ts:38-55`）。 */
export interface CommandDefinitionShape {
  /** 小写命令名、**不带**前导斜杠。 */
  readonly name: string;
  /** 发现 UI 里显示的一句话说明。 */
  readonly description: string;
  /** 可选自由输入提示。 */
  readonly input?: CommandInputDescriptorShape;
  /** 是否把 `rawInput` 记进 `command/run`；缺省 true。 */
  readonly recordInput?: boolean;
  /** 直接对 agent 执行、**不发给模型**。 */
  readonly handler: (invocation: CommandInvocationShape) => CommandResultShape | Promise<CommandResultShape>;
}

/** 命令注册表（`lib/types/index.d.ts:80-113`，此处只声明本插件用到的 `register`）。 */
export interface CommandsService {
  /** 注册一条命令，返回注销它的 disposer（`lib/types/index.d.ts:94`）。 */
  register(definition: CommandDefinitionShape): () => void;
}

/** 与 cordis LoggerService 一致的按级别调用形状。 */
export interface LoggerService {
  error(format: unknown, ...params: unknown[]): void;
  info(format: unknown, ...params: unknown[]): void;
  warn(format: unknown, ...params: unknown[]): void;
  debug(format: unknown, ...params: unknown[]): void;
}

/** 一次工具执行的执行期视图（dsh-tools 的 ToolExecution）。**没有 turn 字段**。 */
export interface ToolExecutionShape {
  readonly callId?: string;
  readonly name: string;
  readonly arguments?: unknown;
  readonly agent?: Agent;
  readonly signal: AbortSignal;
}

/** 一次工具执行的终局结果（判别键 isError）。 */
export interface ToolExecutionResultShape {
  readonly isError: boolean;
}

/**
 * 会话日志事件的最小视图。
 * 真实形状是 `{ type, seq, time, data }` —— `turn/start` 的轮次号在 `event.data.turn`。
 */
export interface SessionEventShape {
  readonly type: string;
  readonly data?: { readonly turn?: number };
}

/**
 * DSH `present` 工具在成功呈现文件之后追加的交付事件
 * （`{ turn, callId, files }`）——**本插件唯一的交付信号**。
 */
export interface DeliverablesPresentedShape {
  readonly type: 'deliverables/presented';
  readonly data: {
    readonly turn: number;
    readonly callId: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly description?: string }>;
  };
}

/** 会话对象的最小视图（session/event 的第一个参数）。 */
export interface SessionShape {
  readonly id: string;
}

/** 本插件监听的宿主事件载荷。 */
export interface HostEvents {
  /** 新 agent 就绪，在首条消息进入 loop 之前被 await。serial（监听器抛错会影响创建流程） */
  'agent/created': (payload: {
    agent: Agent;
    source: 'startup' | 'resume' | 'clear' | 'compact';
    signal?: AbortSignal;
  }) => void | Promise<void>;
  /** 该轮已判结束且 next-step 队列为空；可 steer 让它再跑一步。serial */
  'agent/turn-stopping': (payload: { agent: Agent; turn: number; signal: AbortSignal }) => Promise<void> | void;
  /** agent 离开注册表。emit */
  'agent/disposed': (payload: { agent: Agent }) => void;
  /** 会话日志追加。**真实签名是 `(session, event)` 双参**。emit */
  'session/event': (session: SessionShape, event: SessionEventShape | DeliverablesPresentedShape) => void;
  /** 冻结的权威工具结果。**真实签名是 `(exec, result)` 双参**，按 exec.agent 作用域过滤。emit */
  'tools/result': (exec: Readonly<ToolExecutionShape>, result: Readonly<ToolExecutionResultShape>) => undefined;
}

/** 插件实际使用的宿主上下文面。 */
export interface PluginContext {
  readonly logger: LoggerService;
  readonly systemPrompt: SystemPromptService;
  readonly tools: ToolsService;
  /**
   * 命令注册表（`/memory` 用它注册）。**可选**：本插件用 deferred inject 取，
   * 旧宿主线（或测试桩）没有它时只少一个入口。
   * 出处：`@deepseek-ai/dsh-commands/lib/types/index.d.ts:63-67`
   * （`declare module '@deepseek-ai/cordis' { interface Context { commands: CommandRuntime } }`）。
   */
  readonly commands?: CommandsService;
  /**
   * cordis 的**延迟注入**：依赖就绪时回调被调用，缺席时回调永不执行（不报错、不阻塞加载）。
   *
   * 出处：`@deepseek-ai/cordis/lib/types/registry.d.ts:185`
   * `inject(inject: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>`；
   * 本插件只取返回值上的 `.dispose` 当 effect 的撤销器。官方同款用法见
   * `@deepseek-ai/dsh-agent-loop/lib/index.js:1570-1579`。
   *
   * **`this` 是必需的**：它是 Context 上的方法，实现体为 `this.plugin({ inject, apply })`
   * （`@deepseek-ai/cordis/lib/index.js:1599-1605`），解引用后必须 `.call(ctx, …)`。
   *
   * 这是**可选**成员：为兼容没有该 API 的旧宿主线/测试桩，调用前必须 `typeof` 判函数。
   */
  readonly inject?: (this: PluginContext, deps: readonly string[], callback: (childCtx: PluginContext) => void) => { dispose: () => void };
  /**
   * cordis 的 effect 注册：回调**立即执行**，其返回的 disposer 被收集，
   * 在"返回的 disposer 被调用"或"fiber 卸载"时逆序执行。
   * 所有注册（提示词贡献、工具、监听器）都应当走它，否则热重载会泄漏。
   */
  effect(execute: () => (() => void) | void, label?: string): () => void;
  on<K extends keyof HostEvents>(name: K, listener: HostEvents[K]): () => void;
}
