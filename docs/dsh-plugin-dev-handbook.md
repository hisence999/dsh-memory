# DSH 插件开发手册 · 记忆类插件的 API / 定义 / 坑

> 来源：`dsh-memory-hook` 这个插件的完整开发与两次线上故障复盘。目标是**下一个项目不用再重新调研**。
> 所有"已核验"条目都对着本机 DSH `0.1.6-alpha.2` 检出的真实定义与线上日志确认过；未核验的会明确标注。
> 阅读顺序建议：**第 3 章（事件总线）→ 第 4 章（消息投递）→ 第 5 章（工具注册）→ 第 7 章（子代理隔离）→ 第 9 章（坑清单）**。

---

## 0. 一句话定位

DSH 插件 = 一个 Cordis 插件，向宿主**注册**四类东西：**提示词贡献**、**工具**、**事件监听器**、**HTTP 路由/服务**。
本手册覆盖前三类（记忆类插件只需要这三类）。

配套材料（属于 `dsh-plugin-studio` skill，讲"怎么建工程"）：

| 主题 | 位置 |
|---|---|
| package/patch/client 合同 | `~/.agents/skills/dsh-plugin-studio/references/contracts.md` |
| 症状 → 原因 → 修复 | `…/references/troubleshooting.md` |
| 能力面 × 形态全览 | `…/references/capability-map.md` |
| 八套配方（命令/HTTP/服务/事件/设置面板/工作区/状态栏/根布局） | `…/recipes/` |

**本手册补的是那些文档缺的东西**：真实签名与行号。skill 的 reference 里多处写着"以目标版本类型提示为准"，示例代码还是 `ctx.tool?.register?()`、`router.static?.()` 这种猜测写法——按那个写会静默失效。

---

## 1. 插件模型与生效规则（先记住这张表，能省一半调试时间）

DSH 插件有四层，**改动后生效方式完全不同**：

| 层 | 是什么 | 改动后如何生效 |
|---|---|---|
| profile `cordis.patch.yml` 里的 insert 行 | 挂载一行插件 | **配置热更**即可挂载 |
| 插件的 `config:` 段 | 传进 `apply(ctx, config)` 的配置 | 热更（注意 patch 是**整行替换 config，不深合并**） |
| `package.json#dsh.bundle.patch` 指向的 patch | 组合包（bundle）层 | **必须重启进程** |
| **bundle 成员变化**（新增/删除一个包） | 插件树结构变了 | **必须重启进程** |
| 插件 `src/` 代码 | `main`/`exports` 指向的入口文件 | **必须重启进程**（Node ESM 缓存不热更）|

> 这是最容易浪费时间的坑：**"装了但没生效"十有八九是没重启**。bundle 图重组合 + Node ESM 缓存都不会热更。
> 本插件当时的记录：`DSH 的 bundle 成员变化必须重启 profile 才生效，只有 patch 文件改动走热加载`。
> 因此开发期最顺手的验证方式不是反复重装，而是 `dsh web --patch <绝对路径>\cordis.patch.yml` 做 overlay 试跑。

**Cordis 插件契约（已核验）**：

| 导出 | 形状 | 说明 |
|---|---|---|
| `name` | `string` | 插件名，日志/诊断用 |
| `inject` | `string[]` **或** `{ 服务名?: 配置 }` 对象 | 依赖声明；两种形态都合法 |
| `apply` | `(ctx, config) => void \| Promise<void>` | 函数插件入口 |
| `default` | 同 `apply` | 可选，**仅供某些加载器**；官方包两种都有，稳妥起见两者都写 |

- `inject` 的**对象形态**是给"带拦截配置的服务"用的（值的类型是 `Context[K]` 的 intercept config，不是 boolean 开关）。
- **两条纪律**：① 每个 `ctx.*` 用到的服务都要进 `inject`；② `ctx.foo?.method?.()` 这种"可选链兜底"会让注入失败**静默跳过**，宁可让它报错。
- **`inject` 未就绪时 apply 根本不会执行**（已核验，语义比"报错"更值得记住）：cordis 把 `inject` 归一成依赖集，**任一依赖缺失 → epoch = `INACTIVE` → fiber 停在 `PENDING`，`apply` 不跑**；等到提供者出现（`ctx.provide` → `notify` → `_refresh`）才会在**微任务**里执行 `apply`；提供者注销时同一路径把 fiber 打回 INACTIVE 并跑 disposer。在未就绪的 fiber 里访问所需服务会抛 `cannot get required service "<name>" in inactive context`。
  > 实践含义：**"插件没加载"未必是加载失败，可能只是在等依赖**。DSH 侧文档的说法是"a valid unresolved inject may remain pending"。

**注册必须走 `ctx.effect()` / `ctx.on()`**（已核验 `cordis/src/fiber.ts:402-417`）：

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

精确语义（**容易记错的两点**）：

- `execute` **立即执行**；它产生的 disposer 被**收集**，并在"返回的 disposer 被调用"或"fiber 卸载"时**逆序执行**，谁先到算谁。
- **`ctx.effect(fn)` 返回的是一个"新的"拆解整个 effect 的 disposer，不等于 `fn` 返回的那个函数。** 别把它俩当同一个。
- 返回的 disposer **重复调用是 no-op**；异步 effect 的 disposer 可以 await。
- fiber 已被释放时再建 effect 会抛 `CordisError('INACTIVE_EFFECT')`（`cannot create effect on inactive context`）。
- `ctx.on(name, listener)` **内部就是在 fiber 上建 effect**（`cordis/src/events.ts:254-259`），所以监听器随 fiber 自动移除，返回的 disposer 是"移除该监听器"的函数（类型标 `() => boolean`，`true` 表示移除时它还在注册表里）。
- 用 `Service` 基类或 `ctx.provide()` 注册的服务也随 fiber 自动移除。

入口形态——**照官方包抄（已核验 `dsh-tool-todo/lib/index.js:196`、`dsh-tool-present/lib/index.js:123`）**：

```js
export const name = 'memory-hook';                 // 插件名
export const inject = ['systemPrompt', 'tools'];   // 依赖服务
export const Config = z.object({ /* … */ });       // 可选：@deepseek-ai/schemastery 配置 schema
export function apply(ctx, rawConfig) { /* 注册 */ }
export { Config, apply, inject, name };            // ← 官方包就是这个具名导出集合，没有 default
```

- **不要写 `export default`**：官方包一律具名导出（理由是"具名导出保留 loader 注入元数据"）。本插件写不写都能跑，但**跟着官方走**最稳。
- `name` 与 `package.json#name` 不必相同（本插件 `name='memory-hook'`、包名 `dsh-memory-hook`），但 `cordis.patch.yml` 的 insert `id` 与 `name` 必须能被宿主解析到包名——**三处一致最省事**。
- `apply` 的 `config` 是 patch 里 `config:` 的原样对象。**校验要保守回退而非抛错**：`apply` 顶层抛异常会让整个 profile 加载失败。本插件 `src/config.js` 的做法是非法值一律回退默认值，只对显式危险的取值（如 `fileNameFormat` 含路径分隔符）warn。
  若用 `Config`（Schemastery）声明，宿主会先做 schema 校验——**这是更"官方"的做法**，代价是要引 `@deepseek-ai/schemastery`（它属于"DSH profile 已提供"的包）。

---

## 2. 宿主 API 的获取方式：两种流派，先选一个

| 流派 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 零依赖手写声明**（本插件采用） | 不 import 任何 `@deepseek-ai/*`；自己写一份最小 `types/dsh.d.ts`；工具定义以裸对象注册 | 无构建步骤、源码即产物、升级宿不易崩 | 宿主改签名时**类型检查不会报错**，只能靠测试兜 |
| B. 声明 `@deepseek-ai/*` 类型依赖 | 直接 import 真实类型 | 类型准确、跟着宿主走 | 需要构建/版本耦合；且**宿主包不能写进 `dependencies`**，官方做法是 peer + dev 双份（见下） |

本插件的判断：**A 适合小而稳的插件**，但必须配一份"真实形状"的集成测试（见第 11 章）。
`types/dsh.d.ts` 的写法要点：文件头写清"这是对宿主的最小声明、只覆盖实际读取的面"，并**逐条标注行号出处**，方便日后核对。

**三个官方工具包的 `package.json` 实际声明方式（已核验，值得照抄）**：

| 项 | 做法 |
|---|---|
| 宿主包（`@deepseek-ai/dsh-*`、`cordis`） | **`peerDependencies` + `devDependencies` 双份**，版本 `^0.1.6-alpha.2`（cordis `^4.0.2`） |
| 第三方包（`zod`、`@deepseek-ai/schemastery`） | 正常写 `dependencies` |
| `dsh` 字段 | **宿主侧工具包不写**。该字段只出现在 client/web 侧包，形状是 `dsh.client`（含 `inject` / `platform: 'web'`） |

> 所以通俗说的"禁止声明 `@deepseek-ai/*` 依赖"，准确含义是**不能写进 `dependencies`**（那会装出第二份），而不是"不能出现在 package.json 里"。
> 本插件现在是 `private: true` 的本地目录插件，只把 `@deepseek-ai/cordis` 写在 `devDependencies`；若将来要发布，应按上表补 peer 双份。

---

## 3. 事件总线（最重要的部分）

### 3.1 本插件实际订阅的五个事件（全部已核验）

| 事件 | 真实签名 | 语义 | 调度方式 |
|---|---|---|---|
| `agent/created` | `(payload)`，`payload = { agent, source, signal? }` | 新 agent 就绪，**在首条消息进入 loop 之前被 await** | serial |
| `agent/turn-stopping` | `(payload)`，`payload = { agent, turn, signal }` | **该轮已判结束且 next-step 队列为空**时派发（在最后一步的 `step/end` 之后）；监听器可 `steer` 让它再跑一步 | serial |
| `session/event` | **`(session, event)` 两个参数** | 每次会话日志追加 | emit |
| `tools/result` | **`(exec, result)` 两个参数** | 冻结的权威工具结果；按 `exec.agent` 作用域过滤分发 | emit |
| `agent/disposed` | `(payload)`，`payload = { agent }` | agent 离开注册表 | emit |

权威出处：`tools/result` = `dsh-tools/lib/types/index.d.ts:84`（`@mode emit`）；`agent/created` = `dsh-agent/lib/types/runtime-types.d.ts:225-234`（`@mode serial`）；`agent/disposed` = 同文件 `:236-242`；`agent/turn-stopping` = 同文件 `:381-392`（`@mode serial`）。
`source` 类型名是 `SessionStartSource`，取值域 `'startup' | 'resume' | 'clear' | 'compact'`（`runtime-types.d.ts:112`）。

> ⚠️ **`'clear'` 与 `'compact'` 目前尚无发出方**（`dsh-agent/README.md` 明确标注"reserved with no emitter yet"），当前只有 `'startup'`（新建）与 `'resume'`（恢复）会真正到达。本插件按 `startup | clear` 建文件、其余只建注入缓存——逻辑对二者都安全，但**别以为 `clear` 分支已经被线上覆盖过**。

**两个必须知道的机制细节**（都容易看错）：

1. **载荷里的 `agent` 由派发器自动补**。`agent/turn-stopping` 的**调用点**只写了 `{ turn, signal }`（`dsh-agent-loop/lib/index.js:965`），但派发器 `agentEvents()` 是 `fused = (payload) => ({ ...payload, agent })`（`dsh-agent/lib/index.js:209-213`），所以**运行时载荷一定含 `agent`**，且 scope key 与 payload 的 `agent` 不可能不一致。看调用点会以为缺 `agent`——别据此改代码。
2. **`emit` 与 `serial` 的差别**：`emit` 派发是**不 await、异常被吞**的（`agentEvents.emit` 内 `try/catch` + `ctx.logger.warn`，`:222-229`）；`serial` 是**顺序 await、监听器失败会 reject**（`:231-234`）。所以 `agent/created`、`agent/turn-stopping` 的监听器**抛错会影响创建/收尾流程**——这正是"监听器内部必须自己 try/catch"的另一半理由。
3. **`serial` 的语义是"事件之间串行"**，不是"上一个监听器决定下一个"；后者是 `waterfall`（`tools/post-execute` 就是 waterfall）。

**别把单参和双参搞混**——这是本项目历史上最隐蔽的一类 bug，类型检查完全看不到（详见 §9.1）。

### 3.2 三个载荷里最容易踩的字段

- `session/event` 的 `event.data.turn`：**轮次号在 `data` 里，不在顶层**。`turn/start` 就是靠它识别轮界。
- `tools/result` 的 `exec` 上**没有 `turn` 字段**（`ToolExecutionInput` 的字段是 `callId`/`rootCallId?`/`name`/`schema?`/`arguments`/`agent?`/`parent?`/`signal`）——所以"轮次边界"只能由 `turn/start` 驱动，不能从工具结果推。
- `agent/turn-stopping` 的 `turn` 在**顶层**，且是判断"这是第几轮"的唯一可靠来源。
**`agent/turn-stopping` 的精确触发条件（已核验，容易记错）**：它**不是**"所有 step 跑完就无条件派发"，而是 `if (turnEnds && this.inbox.nextStep.length === 0)`（`dsh-agent-loop/lib/index.js:964`）。若某一步之后 `next-step` 里已经有消息，就**不派发**、直接继续同一轮。派发后还有 `signal.throwIfAborted()`（`:969`），`turn/end` 在之后的 `finally` 里才 append。

**`steer` 的两种结局（这一点我原先记漏了）**：`agent.steer(input)` = `this.send(input, "next-step", true)`（`:790-792`）。

| agent 当前状态 | steer 的效果 |
|---|---|
| **运行中**（正处在某轮里） | 只写 `next-step` 队列，**同一轮内继续**，不新开轮次 |
| **空闲** | `wakeDriver()` 会**新开驱动并进入新轮次**（`turn()` 里 `const turn = phase.turn + 1`） |

> 所以"`turn-stopping` 里 steer 不会新开轮次"**只在运行中成立**。在事件回调里给空闲 agent steer 是会真的开启新一轮的——这通常是你想要的（本插件的提醒就依赖它），但别把它当"无害的追加"。

### 3.3 交付信号 `deliverables/presented` 的完整机制（已核验，很值得学）

`present` 工具（`dsh-tool-present/lib/index.js`）的写法是"**先校验、后确认**"两段式：

```js
// ① execute：只校验 + 挂起，不 append 任何东西
async execute(args, exec) {
  if (exec.agent === void 0) throw new Error("present requires an agent Session");
  const boundary = ctx.sessionProjections.stateOf(exec.agent.session, "turnBoundary");
  if (boundary === void 0 || boundary.openTurnStartSeq === null) throw new Error("present requires an open turn");
  // …逐个文件 fs.stat 校验存在且是常规文件…
  pending.set(exec, { session: exec.agent.session, turn: boundary.lastTurn, files });
  return { turn: boundary.lastTurn, files };
}

// ② 自己的 tools/result 监听器：只在明确成功时 append
ctx.on("tools/result", (exec, result) => {
  const delivery = pending.get(exec);
  pending.delete(exec);
  if (delivery === void 0 || result.isError) return;      // ← 失败/中断在此止步
  session.append("deliverables/presented", { turn, callId: exec.callId, files });
});
```

三条可复用结论：

1. **`deliverables/presented` 只在"校验通过 + 结果明确成功"之后追加**（`dsh-tool-present/lib/index.js:110-120`），所以把它当交付信号是可靠的——它已经是"模型声明 + 宿主验证"的合成结果。
2. **files 元素的字段是 `{ path, description? }`**，事件载荷是 `{ turn, callId, files }`。注意 `callId` 取自 `exec.callId`。
3. **`present` 要求"有开着的轮次"**（`turnBoundary.openTurnStartSeq !== null`），否则直接抛错；而 `turn` 取自 `boundary.lastTurn`（**不是 `exec.turn`——那个字段不存在**）。所以交付事件必然发生在某一轮之内，`data.turn` 一定有意义。
4. 写法本身值得抄：**"想记录一次成功"不要写在 `execute` 里**（`execute` 只代表"尝试"），要写在自己的 `tools/result` 里并检查 `result.isError`。

### 3.4 一次完整轮次的事件时序（照这个顺序设计状态机）

```
轮内   tools/result (exec, result)                  -> 记录「本轮有工具活动」
轮内   session/event (session, {type:'deliverables/presented', data:{turn,...}})
                                                    -> 记录「本轮出现过交付物」
轮末   agent/turn-stopping ({agent, turn, signal})  -> 推进状态、决定是否 steer
轮界   session/event (session, {type:'turn/start'}) -> 复位本轮标志
```

三条从真实故障里换来的纪律：

1. **复位只能发生在轮界**（`turn/start`），不能在求值函数入口按"轮次号变了"就复位——那会把同一轮刚记录的交付物擦掉。
2. **`agent/turn-stopping` 同一轮会被派发多次**（`steer` 出来的额外 step 跑完会再派发一次）。所以"本轮交付"这类标志必须是**一次性消费**的：取出后立刻置假。否则第二次求值会重复触发。
3. **被 abort/error 打断的轮次不会派发 `turn-stopping`**，那轮的标志只能靠轮界复位兜底，否则会漏到下一轮。

### 3.5 什么时候能用事件、什么时候只能轮询

- 想**改模型接下来做什么** → 只能在 `agent/turn-stopping` 里 `steer`。
- 想**知道发生了什么** → 用 `session/event` / `tools/result`（只读，别在里面做重活）。
- 想**改变注入内容** → 见第 4 章，注意求值时机。

---

## 4. 向模型投递内容：三条通道

### 4.1 提示词贡献：`ctx.systemPrompt.context({ name, order, text })`

这是**注入记忆/规则类内容的主通道**。本插件的用法（已核验）：

```js
ctx.systemPrompt.context({
  name: 'memory-hook:daily',
  order: 50,
  text: (assemble) => {
    // ⚠️ 这个函数会被反复调用（每个模型 step 之前），必须快、必须稳、必须可返回空串
    const sessionId = sessionIdOfScope(assemble?.scope);   // DSH 以活跃 Agent 对象作为 scope
    if (sessionId === undefined) return '';
    return injectionCache.get(sessionId) ?? '';
  },
});
```

关键事实（已核验）：

- `text` 可以是**函数**，并且**每个模型 step 之前都会求值**：`await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))`（`dsh-agent-loop/lib/index.js:888`），求值点在 `dsh-system-prompt/lib/index.js:342`：`text: typeof section.text === "function" ? section.text(context) : section.text`。
- 宿主**只在渲染文本发生变化时**才追加快照消息进历史：`this.runtimeContext.project(joinContextSections(sections), sections)`（`dsh-agent-loop/lib/index.js:891`，`project` 定义在同文件 `:334`）——所以"内容没变"不会重复占用上下文。
- `scope` 是 DSH 传进来的组装作用域，**活跃 Agent 对象本身**（读 `scope.id` 即会话 id）。
- **`name` 必须全局唯一——重名注册会抛异常**（`PromptContext.name` 的 JSDoc：`a duplicate registration throws`）；`order` 必须是**有限数**，否则抛 `TypeError`（`dsh-system-prompt/lib/index.js:267-270`）。多个插件抢同一个 `name` 会直接炸，**名字要带插件前缀**（本插件用 `memory-hook:daily`）。
- **`order` 是不冲突的自由段**：不同 `order` 的贡献按**升序拼接**（`Contexts are joined in ascending order`）。本插件取 `50`。
- **不要在 `text()` 里做 IO**（读文件/网络）。本插件的做法：在 `agent/created` 阶段预读并缓存文本，`text()` 只查缓存。
- **`text()` 抛异常会连累整个上下文组装**——必须内部 try/catch 并 `return ''`。

> 由此推出一条重要的产品取舍：**注入了什么，会随 `text()` 的返回值变化而变化**。若你希望"记忆变更后不在会话内重新注入"，就必须让缓存**只在会话边界更新**——这正是本插件的做法（见 `docs/memory-tools-design.md` §8.3）。

### 4.2 主动投递消息：`agent.steer(message)` 与 `agent.inject(message)`

| 通道 | 语义 | 适用 |
|---|---|---|
| `agent.steer(message)` | 影响最近步骤；**空闲 driver 会因此开启一个轮次** | 强制提醒（本插件用这个） |
| `agent.inject(message)` | 排入下一个 pre-step，**不唤醒空闲 agent** | 备选注入通道（本插件保留未用） |

**消息必须与 DSH 的 `UserMessage` 同形，顶层必须有 `role`**（已核验，这是本项目最严重的一次线上故障）：

```js
function buildSteerMessage(text) {
  return {
    id: randomUUID(),                                    // 必填
    role: 'user',                                        // ⚠️ 必填！漏了整个请求被上游拒绝
    content: [{ type: 'text', text }],                   // 块数组，不是字符串
    source: { kind: 'plugin', plugin: 'memory-hook' },   // 必填
  };
}
```

- 官方走 `createUserMessage()`（已核验 `dsh-llm/lib/types/message.js:45`）：它**只补 `role: 'user'`**，然后交给 `createMessage()`（`:34`）赋 `id: brandString(randomUUID())` 并 `deepFreeze`。
- **`UserMessage.source` 没有被收窄**：类型上是并集 `MessageSource`，不是 `{ kind: 'user' }`。给模型的消息里 `source` 的具体形状**由生产者决定**——插件自己发的消息用 `{ kind: 'plugin', plugin: <插件名> }` 是正统做法（`SystemMessage` 就是这么定的），但别以为类型会帮你检查。
- **`id` 在类型上是 branded**（`brandString` 来自 `dsh-brand`），但**运行时就是字符串**，手工写 `randomUUID()` 完全等价、序列化不受影响。
- **漏 `role` 的后果**：LLM 适配器原样透传 `message.role`（`dsh-llm-deepseek/lib/index.js:2271-2273` 的 `messages.push({ role: message.role, content })`），`JSON.stringify` 把 `undefined` 丢掉，上游以 `messages[N]: missing field 'role'` **拒绝整个请求**——整轮运行失败。注意：类型上 `Message.role` 不可选，所以**这条路径只有绕过类型的调用方才会踩**——本插件正是那种"手工构造对象、不 import 宿主类型"的调用方。
- 形状自查：`Object.keys(msg).sort()` 应等于 `['content','id','role','source']`。
- `MessageSource` 是**可扩展的判别联合**（按 `kind` 分支：`plugin` / `model` / `tool` / …）。插件自己发的消息用 `{ kind: 'plugin', plugin: <插件名> }`。

### 4.3 工具返回值

工具结果的呈现由 `output.render(args, value)` 负责，见下一章。

---

## 5. 注册工具

服务名是 **`tools`**（复数，类型名 `ToolRuntime`），方法是 **`register(definition: ToolDefinition) => () => void`**（已核验 `dsh-tools/lib/types/index.d.ts:611`）。

### 5.1 `ToolDefinition` 的真实形状（已核验 `:107-173`）

```ts
interface ToolDefinition extends ToolSchema {   // ToolSchema = { name, description, parameters }
  readonly output: ToolOutputDefinition;        // ⚠️ 必填！
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  finalizeContent?(exec, result): ContentBlock[] | undefined;   // 见 5.4
  timeoutMs?: number;                           // 协作式超时预算，绝不发给模型
  isConcurrencySafe?(args: unknown): boolean;   // 只有 true 才 opt-in 并行
  presentCall?(args): ToolCallView | undefined;    // UI 待定态卡片
  presentResult?(args, result): ToolResultView | undefined;  // UI 完成态卡片
}

interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode;              // 必填，校验成功返回值
  render(args, value: JsonValue): ContentBlock[];   // 必填，纯函数投影成模型可见内容
  presentationMeta?(args, value): JsonValue;    // 可选，UI 用
}
```

**`output` 是必填的**，这是最容易在第一次写插件时漏掉的一项。`render` 必须是**纯函数**且可重放（UI 会重放它）。

### 5.2 两种写法：裸对象 vs `defineTool`

**写法 A：裸 JSON Schema**（本插件采用，零依赖流派）

```js
ctx.tools.register({
  name: 'memory_write',
  description: '……给模型看的说明：什么时候用、不要写什么……',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: kinds }, content: { type: 'string' } },
    required: ['kind', 'content'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: `已写入 ${value.path}` }],
  },
  isConcurrencySafe: () => false,
  timeoutMs: 30_000,
  async execute(rawArgs, exec) {
    if (!exec.agent) throw new Error('需要会话上下文');
    return { path: '…' };
  },
});
```

**写法 B：`defineTool`**（官方 `dsh-tool-todo` 采用，推荐——参数形状更短、类型可推导）

```js
import { defineTool } from '@deepseek-ai/dsh-tools';
ctx.tools.register(defineTool({
  name: 'todo_write',
  description: describe(allowParallel),
  parameters: { todos: { type: 'array', required: true, description: '…', items: { type: 'object', additionalProperties: false, properties: { /* … */ } } } },
  output: { schema: { /* … */ }, render: (_args, value) => [{ type: 'text', text: `…${value.counts.pending}…` }] },
  execute(args, exec) { /* … */ },
  presentCall: (args) => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }),
}));
```

`defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options): ToolDefinition`（已核验）。注意差异：**`defineTool` 的参数是"隐式对象根"的逐属性 spec，`required` 写在属性上**；而裸写法是完整 JSON Schema，`required` 是根级数组。两种都合法，别混用。

### 5.3 必须记住的行为

- `execute(args, exec)`：`exec = { callId, name, arguments, agent?, signal, … }`（`ToolExecutionInput`）。**`exec.agent` 是工具侧拿会话身份的唯一途径**（`exec` 上**没有 `turn`**）。
- `execute` 只返回**规范化的 JSON 值**（由 `output.schema` 校验）；模型看到的内容由 `render` 决定——"返回值"与"模型看到的话"是两件事。
- **异步工作必须观察/转发 `exec.signal`**，并在自己拥有的工作到达静止后才 resolve。宿主能保留取消传播，但**无法强杀同进程代码**。
- 参数校验失败要**抛 `Error`**（宿主转成错误结果），不要返回错误字符串。
- **工具名没有正则约束**（这条我原先写错了，见下面的更正）：`register` 与 `defineTool` 都**不校验 name 形态**。真实存在的相邻约束只有三条 —— ① `run_code` 是**保留名**，注册即抛错（`dsh-tools/lib/index.js:2883`）；② 装配期要求**非空**（`dsh-system-prompt/lib/invariant.js:25`：`assembled tool names must be non-empty`）；③ 模型侧字符集：MCP 命名空间用 `^[A-Za-z0-9_-]{1,32}$`（`dsh-mcp-client/lib/index.js:767`，对应 DeepSeek function-name 约定）。
  > `^[a-z][a-z0-9_-]*$` 这条正则**确实存在，但属于斜杠命令**：`dsh-commands/lib/index.js:78` 的 `COMMAND_NAME`。
  > 本插件 `src/config.js` 拿它来校验可配置的 `toolName`，属于**自我加严**（合理，但要知道那不是宿主的要求）。
- `isConcurrencySafe` 的判定是**严格 `=== true` 才并行**，其余情况（缺省 / 抛错 / 返回非 true / 参数非法）一律 exclusive（`dsh-tools/lib/index.js:3054-3062`）。
- `output` **必填且无默认渲染**，运行时会强制校验并抛 `TypeError: tool "<name>" must declare output { schema, render, presentationMeta? }`（`dsh-tools/lib/index.js:2878-2880`）。写法上要"先校验、后确认"见 §3.3。
- `timeoutMs` 与 `isConcurrencySafe` **绝不发给模型**：`schemas()` 只白名单 `name`/`description`/`parameters`。
- `description` 是给模型看的**运维手册**，不是给人看的文档——把"什么时候用""不要写什么"写进去，比事后在提示词里补更有效。

### 5.4 六个可用扩展点（大多数插件用不到，但知道有）

| 扩展点 | 时机 | 典型用途 |
|---|---|---|
| `tools/result` 事件 | 结果冻结后 | 只读观察（本插件用它标记"本轮有工具活动"） |
| `tools/post-execute` | waterfall，结果落盘前 | 改写结果 |
| `tools/ptc-dispatch-log` | waterfall | 只改 `run_code` 子调用的**日志副本** |
| `finalizeContent` | 同步最后一道变换 | 统一的输出后处理；**必须全函数、不得抛错** |
| `presentCall` / `presentResult` | UI 渲染 | 工具调用的待定/完成卡片 |
| `tools/change` | 工具集变化 | 重置依赖工具集的缓存 |

---

### 5.5 会话日志：`session.append()`

写"自定义领域事件"进会话日志，官方做法是 `exec.agent.session.append(type, data)`（已核验 `dsh-tool-todo/lib/index.js:173`：`exec.agent.session.append('todo/write', { todos })`）。

这对记忆类插件特别有用：**把"记忆被更新/归档"作为一条会话事件记进日志**，之后就能用 `session/event` 监听、也便于事后审计。注意 `session/event` 会以 `(session, event)` 派发你追加的事件，因此**自己追加的事件不要在自己的监听器里造成递归副作用**。

**注册时机与隔离**：工具是**模型可见**的，因此本插件在 `agent/created` 里判定主会话并登记白名单，`execute` 里**再查一次白名单**，subagent 调用直接抛错——注册面与执行面各设一道。

---

## 6. 会话身份与持久化

### 6.1 拿身份

| 场景 | 从哪里取 |
|---|---|
| 事件里 | `payload.agent.id` / `exec.agent.id`（会话 id）；`session.id`（`session/event` 的第一个参数） |
| 提示词贡献里 | `assemble.scope.id`（scope 就是活跃 Agent） |
| 工作区 | `agent.session.header.cwd` |

### 6.2 `SessionHeader` 上真正有用的字段（已核验）

| 字段 | 必需性 / 取值 | 用途与坑 |
|---|---|---|
| `cwd` | 可选；存在时**必须是绝对路径** | **不能**用于判定 subagent——子会话继承父的 cwd |
| `origin` | 可选；取值域**只有 `'subagent'`** | 子会话判定的**唯一权威正向特征** |
| `parentSession` | 可选 string | 子会话必有；**但宿主 fork 顶层会话时也写它**（`SessionStore.fork()`／`commands.fork()`），因此**不能单独当子代理判据**（见 §7 的 2026-09-26 P0） |
| `delegationDepth` | **物理 header 必填**、逻辑类型可选；非负安全整数 | 顶层为 `0`；**持久化时会把缺省补成 0** |
| `isSeeded` | **必填** boolean | 是否含 fork 继承的事件前缀；**主会话 fork 也为 true**，不可用于 subagent 判定 |

注意两处口径差异：**类型声明**上 `delegationDepth?: number`（`dsh-session/lib/types/types.d.ts:68-94`，注释写明"absent (zero) for a top-level session"）；**物理 header** 里它是必填项。

权威校验（`dsh-session-persistence-jsonl/lib/index.js:840` 的 `isHeaderLine`）：`delegationDepth` 与 `isSeeded` 都是**硬要求**（`typeof … && Number.isSafeInteger(…) && ≥ 0`、`typeof value.isSeeded === "boolean"`），且**未知键一律拒绝**（`Object.keys(value).every(key => HEADER_KEYS.has(key))`）。

### 6.3 持久化的三个致命细节（已核验）

**① `delegationDepth` 会被补零。** 写盘时是 `delegationDepth: header.delegationDepth ?? 0`（`:814`），读回原样送回（`:832`）；`isHeaderLine` 要求它是非负安全整数。因此：

> **任何重开会话的 header 里都带着 `delegationDepth: 0`。**
> 如果你把"该字段必须缺省"当作顶层判定条件，所有恢复会话都会被判成"lineage 不明"——不注入、不能写入、不提醒，而且**全程静默无日志**。这是本项目最严重的一次 P0，靠子代理 review 才捞出来。

**② `isSeeded` 也是必填字段。** 结论与①同型：**任何"某字段必须不存在"的判定条件都是危险的**——持久化层会把缺省值物化出来。反过来，只有在内存态（尚未写盘）时字段才可能真的缺省。

**③ `cwd` 不具鉴别力。** 子会话的 meta 构造时直接继承父的 `cwd`：`...(parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {})`（`dsh-subagent/lib/types/child-agent.js:115`，函数体 111-125 行），所以"能解析出项目根"完全不能证明"这是主会话"。

> 旁证：DSH 自己的 `dsh-workspace-changes` 判定"这个 cwd 归属哪个会话"用的也是 lineage：`origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd`。**连宿主都不信 cwd 能证明主会话身份。**

> 由此得到一条可复用的设计纪律：**判"是不是主会话"要用"正向特征 + 白名单"，不要用"某字段缺失"。** 缺省值会被物化，字段会被继承。

---

## 7. 子代理（subagent）隔离：怎么判、怎么防

判定公式（本项目最终采用的，已核验；**2026-09-26 修过一次**）：

```js
// 1) 是子会话吗？——只用正向特征（origin / delegationDepth）
isSubagent = header.origin === 'subagent'
          || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0);

// 2) 是 fork 出来的顶层会话吗？（宿主会话 fork，不是子代理）
//    SessionStore.fork()（dsh-session/lib/index.js）与 commands.fork()
//    （dsh-api-session-controller/lib/index.js）都写 meta = { cwd, parentSession, isSeeded: true }：
//    有 parentSession、无 origin、delegationDepth 缺省（落盘补 0）。
isForkedTopLevel = header.origin === undefined
                && (header.delegationDepth === undefined || header.delegationDepth === 0)
                && header.isSeeded === true
                && typeof header.parentSession === 'string' && header.parentSession.length > 0;

// 3) 是显式顶层吗？（白名单的唯一准入条件）
//    parentSession 单独存在 = fork 顶层会话（放行）或未知 lineage 子会话（隔离）
isExplicitTopLevel = header.origin === undefined
                  && (header.delegationDepth === undefined || header.delegationDepth === 0)
                  && (header.parentSession === undefined || isForkedTopLevel);
```

> **P0 记录（2026-09-26，真机）**：早先的公式把 `parentSession` 当成子代理判据。于是在 GUI 里 **fork 一个会话**后，新会话被误判成子代理 → `agent/ctx.tools.restrict({ deny: [四个写入类工具] })` 把工具从可见面摘掉 → 模型照着继承历史继续调 `memory_write`／`memory_log`，得到宿主的
> `Error: unknown tool "memory_write"`（`ToolNotFoundError`，`code: UNKNOWN_TOOL`；抛出点在 `dsh-tools` 的 `resolveExecution` → `ToolNotFoundError`）。
> 同一份日志里能直接看到对照：继承前缀的 `request/header` 仍通告全部 5 个 `memory_*`，fork 自有区间的第一条 `request/header`（`reason: resume`）只剩 `memory_search`。
> 反证：`SessionStore.fork()` 写的是 `meta = { cwd, parentSession, isSeeded: true }`，**没有 `origin`**；而真子代理由 `dsh-subagent` 的 `childSessionMeta()` 写 `origin: 'subagent'` + `delegationDepth ≥ 1`。**`parentSession` 是"分支"，不是"子代理"。**
> 顺带一条时序事实：会话 fork 走 `ctx.agents.create(...)` → `dsh-agent-loop` 的 `createAgent(...)` → `publish("startup")`，所以 fork 的 `agent/created` 载荷 `source` 是 `'startup'`（按新会话建快照，不需要额外的 source 分支）。

设计原则（值得抄到下一个项目）：

- **用白名单，不要用黑名单。** 子会话的创建路径会变（`subagent_fork` 会 seed 父的历史前缀，第三方 provider 可能走别的路径），黑名单在未知路径上会静默失效。白名单把失败方向固定在"少注入/拒绝写入"，可见可控。
- **判"是不是子代理"只能用它自己的正向特征**（`origin` / `delegationDepth`）；血缘字段里任何一个都可能被别的机制复用（`parentSession` 就被 fork 复用），拿它当判据必然误伤。
- **准入条件不能等于判据本身。** 只写"不是 subagent 就登记"是不成立的：那样登记条件就等于它本应兜底的判据，一个未填 lineage 的未知子会话会被主动登记为主会话，多道防线一起放行。
- **多层设防**（本项目六道）：`agent/created` 判定 → lineage 闸门 → 白名单登记 → 注入 provider 查白名单 → 提醒前查白名单 → 工具 `execute` 里再查一次（+ subagent 判定）。
- **交付态也要过白名单**：即使某个子会话里有工具调用了 `present`，也拿不到状态、不会提醒。

---

## 8. 配置、文件与类型（工程细节）

### 8.1 配置

- `apply(ctx, config)` 的 `config` 来自 patch 文件的 `config:` 段。
- **patch 是整行替换，不深合并**——只想改一个键也要把要保留的键一并写出（这条坑在本项目 README 里专门标注过）。
- 配置默认值集中放一个模块（本插件 `src/config.js`），**非法值回退默认而不是抛错**。

### 8.2 文件读写（记忆类插件的主战场）

经验做法，逐条都有理由：

| 做法 | 理由 |
|---|---|
| 写文件用**原子替换**：先写同目录临时文件再 `rename` | 进程中途退出不会留下半截文件 |
| 建文件用 `writeFile(..., { flag: 'wx' })` | 幂等，多会话并发也不会互相覆盖 |
| **同一路径串行队列**（进程内 `Map<path, Promise>`） | 避免同轮多次调用的 read-modify-write 竞争 |
| 读失败一律按"无内容"处理并记日志 | 记忆读失败绝不能拖垮会话创建 |
| 写前**比对文件指纹**，发现被人工改过就基于新内容操作 | 不做覆盖式写入（R1 设计里保留） |
| 解析链**每一层都有 try/catch** | 参照实现 `hr98w/dsh-memory` 因解析链无 try/catch，格式损坏会让**每个模型 step 的上下文组装都抛异常** |
| Markdown 解析**绝不丢内容** | 曾把正文里的 `---` 水平线误判成 frontmatter 开区间，其后内容遭不可逆丢弃。修法：**只认"跳过前导空行后的首个非空行"**，且必须有闭合 `---`，否则整篇按正文保留 |

### 8.3 类型检查（零依赖流派的自保手段）

```json
// tsconfig.json
{ "compilerOptions": { "target": "ES2023", "module": "NodeNext", "allowJs": true,
  "checkJs": true, "noEmit": true, "strict": true, "types": ["node"] },
  "include": ["src/**/*.js", "test/**/*.js", "types/**/*.d.ts"] }
```

- `tsc --checkJs` 能抓住大部分笔误，但**抓不住"事件参数形状错位"**（见 §9.1）——那类只能靠集成测试。
- 运行时不引任何 `@deepseek-ai/*`，因此产物即源码，无需构建步骤。

---

## 9. 坑清单（本项目的真实故障与非显性陷阱）

按"危害 × 隐蔽性"排序。**每一条都值得在新项目开工前读一遍。**

### 9.1 事件参数形状错位——静默失效，类型检查看不见

- **现象**：注册了监听器，逻辑正确，但从不触发。
- **原因**：把 `tools/result` / `session/event` 当成"单 payload 对象"了。它们分别是 `(exec, result)` 和 `(session, event)` 两个参数。
- **为什么会发生**：写代码时凭印象，`ctx.on('session/event', (payload) => payload.type)` 语法合法、类型不报错、运行时 `payload` 是 session 对象，`.type` 是 `undefined`，于是**静默什么都不做**。
- **教训**：**必须打开真实定义核对签名**；并且给装配层写"按真实双参形状驱动"的集成测试。

### 9.2 `role` 缺失导致整轮运行失败

- **现象**：`Failed to deserialize the JSON body into the target type: messages[N]: missing field 'role'`，整轮失败。
- **原因**：`steer`/`inject` 的消息缺顶层 `role: 'user'`。
- **为什么隐蔽**：`JSON.stringify` 会把 `undefined` 的键**直接丢掉**，本地看不出来，直到上游拒收。
- **教训**：投递消息用工厂函数统一构造，并写一条"逐键对齐 `UserMessage`"的回归测试。

### 9.3 交付/完成信号靠猜命令文本——必然误报

- **现象**：纯问答里凭空触发"任务已交付，请回写记忆"。
- **根因**：曾用正则猜"这条 shell 命令是否在写文件"，而 `ssh -G us 2>&1 | Select-String …` 因为含 `2>&1` 里的 `>` 被判定为"在写文件"。
- **教训**：**不要对工具参数做语义猜测，去找宿主事件**。DSH 的 `present` 工具只在**成功呈现过文件**之后追加 `deliverables/presented`，载荷 `{ turn, callId, files }`——这就是模型自己声明的交付。整块启发式已删除。
- **代价要主动告诉用户**：只在 shell 里落盘、从不调用 `present` 的任务不会触发提醒。提醒宁可漏报，不要误报。

### 9.4 缺省值被持久化补零，把恢复会话判死

见 §6.3①。**写"必须是 undefined"这类条件是危险的**：任何"缺省即补零/补默认"的持久化层都会让你的判定静默反过来。

### 9.5 同一轮被求值多次 → 重复动作

- **现象**：同一次交付提醒了两遍，或提醒落在下一轮。
- **原因**：`steer` 会让 `agent/turn-stopping` 在同一轮再派发一次；"本轮交付"标志没消费。
- **教训**：本轮标志**取出即消费**；跨轮限流用 `turn - lastRemindTurn < interval`，且**冷却命中时放弃这一发，不要记账补发**——补发既不要求任务完成也不绑定任务，会落在"正在干活的轮"或"另一个任务"上。**漏一发只是少一次提示，多发一发才是真伤害。**

### 9.6 注入求值失败会污染整个上下文组装

- `text()` 每个 step 都调用。里面抛异常，理论上会连累上下文组装。
- **纪律**：`text()` 内部自己 try/catch，出错 `return ''` 并记 warn。同理，所有事件监听器都要 try/catch——"记忆功能坏掉绝不能拖垮会话"。

### 9.7 `ctx.foo` 用了但没列进 `inject`

`inject` 是 Cordis 的**依赖声明**（数组或对象两种形态）：只有声明过的服务才会在依赖就绪时注入到 `ctx`。把它当成"可选提示"漏写，表现就是"服务不存在/加载被推迟"。更糟的是显式可选链写法（`ctx.tool?.register?.()`）**静默跳过**，表现为"注册了但工具不存在"——本插件历史上就这么踩过一次（`tools` vs `tool` 的复数写错）。

### 9.8 运行时 `Number()` 的宽松转换

`Number(null)`、`Number('')` 都是 `0`。只做 `Number.isFinite` 会让"缺轮次号"蒙混过关。判定轮次要 `Number.isInteger(turn) && turn > 0`。

### 9.9 时区与日期

`new Date('2026-09-19')` 按 **UTC 午夜**解析，会造成整日偏移。本项目的做法：把本地 `YYYY-MM-DD` 字面量先转成对应本地日历日的 UTC 时刻再做运算（`localMidnightNaive`），并支持"日界"配置（默认 7:30，凌晨算前一天）。

### 9.10 记忆写入通道被绕过

给模型注入"请用 `memory_write` 写入"的同时，要**明确禁止用 `edit` 手工追加**——否则格式会被破坏，解析侧要额外容错。本插件的说明文本里专门写了一行。

### 9.11 改了源码、真机行为却没变——运行中的 profile 仍持有旧模块

**2026-09-20 实测（本项目亲身踩到）**：给本插件加了一个校验守卫（`detail` 含空行必须当场拒绝，`src/tools/shared.js` 的 `normalizeDetail`），源码与全部测试都通过；但接着在真机里调用 `memory_write` 写一条含空行的 `detail` 时，**却被接受了**，只回了 `entry-blank-line` 告警——落盘文件的这一条因此被拆成"详情 + 孤儿行"，工具再也清不掉（§5.5 第 6 条要求孤儿行原样回写）。

- **根因**：profile 里的插件是 `link:` 到源码目录（`profiles/<名>/package.json` 里的 `"dsh-memory": "link:D:/dsh-memory-v2"`）。**模块在 profile 启动时加载一次**，之后改磁盘上的 `.js` 不会替换已加载的模块——运行中的进程继续跑**旧 build**，旧守卫自然不生效。
- **判据**：`patchReload: "live"` 只管 **patch 配置**的热更，**不管 JS 代码**；也不要指望"改了源码下次调用就生效"。
  - **改配置（patch）** → 热更，无需重启；
  - **改源码／增删 bundle 成员** → **必须重启 profile**（重开 `dsh web`），新会话才用新 build。
- **验证 build 是否生效的最省事办法**：看**新会话的注入文本**里有没有改动的痕迹（例如本次改了固定提示词与快照段，新会话里立刻能看到新文案 + 新的 `[项目日志]` 段）。
- **只改了工具逻辑（守卫、参数校验）时**：注入文本不会变，上面那招看不出区别——此时用**配对探针**（2026-09-20 实测可用）：把要测的坏 `detail` 与一个**必定非法的必填字段**（如 `title: ""`）放进**同一条 entry**。因为写入是"整批全成或全败"，**任何 build 下都不会落盘**；而返回的失败列表能唯一区分版本——新 build 会多出 `detail 不能包含空行` / `detail 不能用 -／* 项目符号分行`。实测两次探针后 `memory/` 下所有文件的 hash 与 mtime **逐项未变**。
  - ⚠️ **反例（别这么做）**：只拿坏 `detail` 去探守卫。守卫还没生效时它会**真的落盘**，而且按设计再也清不掉（见上）。
- **纪律**：在真机上做"验证一个新增守卫"这类测试前，先确认实例是新的；改完源码立刻重启，别让"源码已修"与"真机未生效"并存。

---

## 10. 宿主 API 全貌与备选通道

记忆类插件只用了 `systemPrompt` + `tools` + 事件总线。下一个项目如果需要更多能力，以下是 DSH 检出里**存在**的相关包（**包名已核验存在，"服务名/签名"待核验**，用之前请照第 3/5 章的方法先核对真实定义）：

| 你可能想要 | 相关包 | 备注 |
|---|---|---|
| 读写文件 | `dsh-fs` / `dsh-fs-local` / `dsh-fs-sandbox` / `dsh-fs-observation-policy` | 沙箱与"观察策略"是分开的层 |
| 键值/结构化存储 | `dsh-storage` / `dsh-storage-json` / `dsh-storage-domain` | 比手写文件更适合放 `.ids`/`.usage` 这类派生数据 |
| 会话查询（跨会话搜索记忆） | `dsh-session-query` / `dsh-session-query-sqlite` / `dsh-session-projection` | 宿主自己就用 `node:sqlite` |
| 定时任务 | `dsh-schedule`、`cordis-plugin-timer` | 记忆整理类任务会用到 |
| 命令（斜杠命令） | `dsh-commands` / `dsh-cmdline` | 本插件没用，但"手动整理记忆"可以考虑 |
| 设置界面 | `dsh-settings` / `dsh-settings-file` | 若要暴露记忆配置 |
| 面板/网页 | `dsh-host-webserver`、`dsh-client-ui-*` 系列 | bundle-client 形态 |
| 日志 | cordis `logger`（`info/warn/error/debug`，`printf` 风格） | 插件上下文自带 |
| 权限/审批 | `dsh-authorization` / `dsh-user-approval` / `dsh-permission-presets` | 工具需要人类确认时 |
| 子代理 | `dsh-subagent` / `dsh-tool-subagent` | 隔离判定见 `第 7 章` |
| 密钥 | `dsh-credentials` / `dsh-credentials-local` | **凭据一律不要写进记忆/日志** |
| 配置 schema | `@deepseek-ai/schemastery`（`z.object({...})`），导出为 `Config` | 官方包的做法，见 `第 1 章` |

**查看服务真实定义的快捷方式**（本手册自己就是这么核验的）：

```powershell
$d='C:\Users\25286\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
# 服务接口与方法签名
Select-String -Path "$d\dsh-<包>\lib\types\*.d.ts" -Pattern 'interface ToolRuntime|register\('
# 事件派发处与签名
Select-String -Path "$d\dsh-<包>\lib\*.js" -Pattern "\.emit\('" -Context 0,3
# 某个官方插件怎么注册工具（最好的范例来源）
Get-Content "$d\dsh-tool-todo\lib\index.js"
```

---

## 11. 测试策略：怎么在没有宿主的情况下测插件

本项目 110 个用例全绿，关键在**两层分离**：

1. **纯逻辑层**（`delivery.js`/`format.js`/`locate.js`）：纯函数，直接断言，覆盖边界。
2. **装配层**（`index.js`）：造一个**最小宿主桩**，按**真实参数形状**驱动事件。

宿主桩的骨架（照抄可用）：

```js
function makeHost() {
  const listeners = new Map();
  const tools = [];
  return {
    ctx: {
      logger: { info(){}, warn(){}, error(){}, debug(){} },
      systemPrompt: { context: (c) => { contributions.push(c); return () => {}; } },
      tools:      { register: (d) => { tools.push(d); return () => {}; } },
      on: (name, fn) => { listeners.set(name, fn); return () => {}; },
    },
    // 按真实签名触发：fire('tools/result', exec, result)
    fire: async (name, ...args) => await listeners.get(name)(...args),
    // 走真实的 scope 求值路径
    injectionFor: (id) => contributions[0].text({ scope: { id } }),
  };
}
```

必须有的回归用例（都对应真实故障）：

- `steer` 的消息**含顶层 `role`**、键集合等于 `['content','id','role','source']`。
- 工具调用（含真落盘的 shell）**不构成交付**；只有 `deliverables/presented` 才构成。
- **恢复态 header（`delegationDepth: 0`）**能拿到白名单并正常提醒。
- subagent 会话：不建文件、不注入、不提醒、工具被拒。
- 纯问答轮次零提醒；同一任务只提醒一次；`signal` 已 abort 时不 `steer`。
- 监听器内部抛错**不外抛**（会话不失败）。

---

## 12. 交付前自检清单

- [ ] `inject` 覆盖了所有 `ctx.*` 服务
- [ ] 每个事件监听的**参数个数与真实签名一致**（双参的别写成单参）
- [ ] 投递消息含 `id` / `role` / `content[]` / `source`
- [ ] 所有监听器与 `text()` 都有 try/catch，失败只记日志
- [ ] 所有注册（贡献/工具/监听/路由）都在 `ctx.effect()` 内并返回 disposer
- [ ] subagent 白名单在**注入、提醒、工具执行**三处都设防
- [ ] `package.json#name` == patch insert id/name == client ModuleLoader id
- [ ] 没声明 `@deepseek-ai/*` 运行时依赖
- [ ] `pnpm test` 全绿 + `tsc --checkJs` 退出 0
- [ ] **改完 bundle 成员已重启进程**，并确认日志里没有 `plugin tree failed to load`
- [ ] 最后跑一次**子代理只读 review**（本项目两次最有价值的 bug 都是这么捞出来的）

---

## 13. client 半边实操（Web 插件：加载器、插件对象、生效规则）

前面的章节全在讲**宿主半边**（`name`/`inject`/`apply` + 服务注册）。如果一个插件还要在 Web 界面上加东西
（本项目的「记忆」面板就是一个 `conversation.view` 标签页），就多出一个 **client 半边**。
这一章把 client 半边的四件事讲死：**怎么被加载、导出什么、为什么不能用 JSX、改完怎么生效**。
（出处均为本机 dsh `0.1.7-rc.2` 检出，路径见附录 B；本项目设计口径见 `docs/memory-tools-design-r1.4.md` §18。）

### 13.1 加载器格式：`window.__ModuleLoader__.load({ id, factory })`

client 半边的入口文件是一个**普通 classic script**（不是 ESM），首行就叫模块加载器：

```js
window.__ModuleLoader__.load({
  id: "dsh-memory",                       // 加载器 id：必须与 package.json#name 一致
  factory: (require) => {
    var module = { exports: {} };
    var React = require("react");         // 平台种子，直接可拿
    module.exports = { name: "…", inject: [ … ], apply: apply };
    return module.exports;
  },
});
```

已核验的原样骨架：`dsh-client-ui-sidebar-files/lib/client.js:1-5`（头）、`:1015-1018`（尾）；
`dsh-client-ui-trajectory/lib/client.js:1-5` 与 `:8772-8776` 同形；本插件实测 `client/memory-panel.js:2639-2648`。

四条硬约束：

1. **`id` 必须与 `package.json#name` 一致**——宿主按 id 把 boot 清单里的行与注册的 factory 对上；
   bundle 执行完却没有用对应 id 调用 `__ModuleLoader__.load` 会直接抛
   `bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`
   （`dsh-client-modules/lib/client.js:739`）。本项目的交付前自检里那条
   "`package.json#name` == patch insert id/name == client ModuleLoader id"（§12）约束的就是这个 **`id`**。
2. **`require` 不是 Node 的 `require`**：它是模块表查询，能拿到的只有"平台种子 + 自己声明过的模块"。
   请求一个表里没有的包会抛 `require("…") missed the module table — not a platform seed word, …`
   （`dsh-client-modules/lib/client.js:700-705`）。要用第三方/自建包，必须在清单的
   `dsh.client.external` 里声明（见 13.3）。
3. **factory 是 CJS 形态**：要自己搭 `module = { exports: {} }` 并 `return module.exports`；
   加载器明确不支持"循环依赖拿到半成品 exports"（`dsh-client-modules/lib/client.js:677`）。
4. **加载器 `id` ≠ 插件对象的 `name`**：`id` 是**包名**（`dsh-memory`），`module.exports.name` 是**插件名**
   （本插件取 `dsh-memory-panel`，`client/memory-panel.js:2632`）。`id` 用于 boot 清单比对，
   `name` 用于插件注册与日志；把 `name` 也写成包名不算错，但**别以为清单比对看的是 `name`**。

### 13.2 插件对象：`module.exports = { name, inject, apply }`

client 半边的插件对象与宿主半边**同形**，只是注入的是浏览器侧的服务：

```js
/** 需要的浏览器服务：槽位、远端载体、其中的 workspaceFiles 命名空间，以及会话（写路径）。 */
const inject = ["slots", "remote", "remote.workspaceFiles", "sessions"];
function apply(ctx) { /* 注册 conversation.view 槽位 */ }
module.exports = { name: "dsh-memory-panel", inject, apply };
```

| 服务 | 干什么 |
|---|---|
| `slots` | 注册 `conversation.view` 标签页 |
| `remote` / `remote.workspaceFiles` | 只读读盘（`list` / `read`） |
| `sessions` | **写路径**：`sessions.using(sessionId, { source: 'memoryPanel' }, (ref) => ref.binding.session.command('/memory archive #0012'))`——面板自己不写文件，靠这条把命令交给宿主 |

- **`inject` 是依赖声明，不是提示**（同 §9.7）：漏写就静默不注入。子路径服务要按点号原样写
  （`"remote.workspaceFiles"`，写成 `"workspaceFiles"` 拿不到）。
  范例：`dsh-client-ui-sidebar-files/lib/client.js:933-940`（它带 `'locale'`，本插件不带）。
- `source: 'memoryPanel'` 是本插件**自有**的来源字符串；`SessionReferenceSourceMap` 定义在
  `@deepseek-ai/dsh-api-session-controller/client`（`lib/types/client/index.d.ts:17-25`，注释要求按该包的 `/client` 入口扩展），
  插件按自己的名字加一项即可（范例：`dsh-client-ui-commands/lib/types/client/service.d.ts:23-28`），不需要改宿主。
  注意 `sessions.using` 只解决"把命令送到哪个会话"，**不解决权限**——命令 handler 自己还有一道会话闸门
  （本插件与工具路径共用同一个 `checkCall`，设计 §18.9）。
- **所有注册都走 `ctx.effect(...)`**，插件卸载时才会撤干净
  （`dsh-client-ui-trajectory/lib/client.js:8700-8705` 的注释 + `:8719-8735` 的写法；本插件 `client/memory-panel.js:2591-2628`）。
- **列表里绑动作必须给每轮固定参数**（本项目实测 P1）：`for (var i …)` 的循环变量是**函数作用域**，
  回调里读到的会是**循环结束后**的那一个——症状是"展开 #0001 点归档，发出去的是 `archive #0004`"。
  渲染每行时用立即执行闭包把该行 `entry` 钉住（或一律用行身份 `rowKey` 当键），
  见 `client/memory-panel.js:2192-2247`；图谱节点的 `onMouseEnter/Leave` 也用了同样的 `var target = …; return function(){…}()` 手法。
- **样式也要在同一个 effect 里注入并撤销**：手写产物没有 CSS 打包，样式得自己
  `document.createElement('style')` 塞进 head（本插件 `installStyle` `client/memory-panel.js:1080-1089`，
  样式表带 `data-dsh-memory="panel"` 标记、106 条规则全部 `.dshmem-` 前缀避免污染宿主页面）。
  本插件**刻意把样式注入与槽位注册合并在同一个 `ctx.effect`** 里（标签 `dsh-memory: 记忆视图（含面板样式）`）——
  因为 `test/panel-loader.test.js` 断言"`ctx.effect` 只被调用一次"；**看到只有一个 effect 别以为写错了**。
- 槽位注册就是往 `ctx.slots` 里加一条（**本插件刻意不接词典：`label` 是中文硬编码**）：

  ```js
  ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view", id: "memory", order: 20,
    label: () => '记忆',
  }, MemoryPanel)), 'dsh-memory: 记忆视图');
  ```

  已核验的两条既有视图：`chat`（`dsh-client-ui-chat/lib/client.js:12303-12307`，`order: 0`）、
  `trajectory`（`dsh-client-ui-trajectory/lib/client.js:8736-8741`，`order: 10`）——**order 小在前**。
  官方那两条带 `locale: NS` 与 `label: () => t("view.trajectory")`；本插件不注册词典、`inject` 里也没有
  `'locale'`（设计 §18.8 第 7 条）。

### 13.3 清单侧：`exports["./client"]` + `dsh.client`

client 半边能被发现，靠 `package.json` 的两处声明（缺一处都加载不了）：

```jsonc
{
  "exports": { "./client": "./client/memory-panel.js" },   // 必须存在
  "dsh": { "client": { "platform": "web" } }               // 声明"我有 client 半边"
}
```

| 项 | 规定 | 出处 |
|---|---|---|
| `exports["./client"]` | 字符串，或含字符串 `default` 的对象 | `dsh-client-modules/lib/index.js:170-180`（`clientExportOf`） |
| 缺它会怎样 | 声明了 `dsh.client` 却引不出 bundle → 加载直接失败 | 同文件 `:718-719` 抛 `exports no "./client" bundle` |
| `dsh.client.platform` | 必填字符串；Web 消费者选 `web` | `dsh-package-manifest/lib/types/types.d.ts:75-89`；校验 `dsh-client-modules/lib/index.js:59-68` |
| `dsh.client.inject` | 可选 `string[]`，**只是信息性的包名依赖清单，不是 Cordis 服务注入** | 同上（类型注释明说 "not Cordis service injection"） |
| `dsh.client.external` | 可选 `string[]`；想 `require` 额外模块（含 `<包名>/client` 这类子路径）必须在这里声明 | 同上 |
| `dsh.client.immediately` | 可选布尔；缺省走共享应用批次 | 同上 |

> 本项目现状（实读 `package.json`）：`exports["./client"] = "./client/memory-panel.js"`、`files` 含 `"client"`、
> `dsh.client = { "platform": "web", "inject": [ "@deepseek-ai/dsh-api-remotes",
> "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-session" ] }`。
> ⚠️ 最后那个 `inject` 是**信息性包名依赖清单**，**不是** §13.2 里的 Cordis 服务注入——两者同名不同物。

### 13.4 无打包：用 `React.createElement`，不要用 JSX

client 半边在本项目里是**手写产物**（源码即产物，没有构建步骤——`package.json` 的 `scripts` 只有 `test` 与 `typecheck`）。
没有打包器就没有 JSX 转换、没有 `.tsx`、没有 CSS 抽取，因此：

- 写组件用 `React.createElement(type, props, ...children)`（或 `const h = React.createElement` 起个别名），
  **不要**写 `<div/>`——那是 JSX，运行时会 `SyntaxError`；
- 需要 `react` 时只能 `require("react")`（平台种子之一，`dsh-client-ui-sidebar-files/lib/client.js:7-11` 就是这么拿的）；
- 样式只能塞字符串常量（官方包是把 CSS 打进 JS 里的，如 `dsh-client-ui-trajectory/lib/client.js:3818` 的 `const css$3 = "…"`）；
- 纯函数（解析、排序、拼接命令文本）要单独放出来，方便用 `node:vm` 直接测：
  本包是 `"type": "module"`（`package.json:6`），所以测试**不能 `import` 这个 classic script**，
  正确姿势是读文件源码 → `vm.runInContext(source, sandbox)` → 取 `sandbox.module.exports` 断言。
  本插件的做法是一个文件两个出口：浏览器分支在 `client/memory-panel.js:2639-2648` 走
  `window.__ModuleLoader__.load` 并 `require("react")`；Node 分支在 `client/memory-panel.js:2652-2654` 把 `PURE_EXPORTS`
  （`client/memory-panel.js:2549-2582`，UI 段新增的 `idxCost`/`pinnedCost`/`logCost`/`injectionStats`/`groupByKind`/`buildGraph`
  等也在这里）交给 `module.exports`。
  面板相关的测试规格（实测数）：`test/panel-loader.test.js` **6 例**（装配、样式注入与 effect 次数、命令字符串）、
  `test/panel-model.test.js` **29 例**（纯函数 + 与 `src/parse.js` 的交叉验证）、
  `test/command-memory.test.js` **22 例**（命令路径与 `memory_archive` 工具路径结果一致）。
- **`client.js.map` 是可选的**：宿主读不到 `.map` 时按 `ENOENT` 返回 `undefined`
  （`dsh-client-modules/lib/index.js:270-277`），不会因此拒绝这个 bundle——所以手写产物**不需要构建**也能被服务，
  代价只是浏览器里没有 source map（官方包用 tsdown 生成，末行带 `//# sourceMappingURL=…`）。
- **不要把宿主的配置上限写死在客户端**：典型是 `workspaceFiles.read` 的行窗口。页长由宿主的 `maxLines` 决定，
  客户端**多传一个 `limit`** 就会在"宿主把 `maxLines` 调得比它小"之后收到 `gateway/bad-request`，
  整块 UI 变成"读取失败"。本插件的做法是**只传 `offset`**，另设一个纯客户端的翻页保险丝
  （`MAX_READ_PAGES = 200`）并在 UI 上说明被截断（`client/memory-panel.js:91-103`/`:791`）；
  官方 `dsh-client-ui-sidebar-documentpreview` 同样刻意不发 limit（"The page length is the Host's configured cap,
  so no limit travels"）。同样的纪律适用于任何"宿主可配置的上限"。

### 13.5 改完怎么生效：必须重启 profile

与 §1 的生效表、§9.11 的实测同一条纪律，client 半边**更要**遵守：

| 改动 | 是否重启 | 原因 |
|---|---|---|
| 改 `client/*.js`（本插件被 `link:` 安装时也一样） | **必须重启**（重开 `dsh web`） | client bundle 在页面/进程启动时按 `dsh.client` 扫描并注入 boot 清单，运行中的实例仍持有旧产物 |
| 改 `package.json` 的 `exports` / `dsh.client` / `files` | **必须重启** | 清单在启动时读一次；`exports["./client"]` 缺失是**加载失败**而不是"面板不显示" |
| 增删 bundle 成员（`dsh plugin add/remove`） | **必须重启** | 同 §1 |
| 只改 patch 配置（`config:`） | 不用（`patchReload: live`） | 配置每次组装时读取 |

⚠️ **排查顺序**：client 半边组不出来时，宿主会打一条汇总日志
`client-modules: <N> client bundles failed to compose` 并逐条列出缺失的 bundle（`dsh-client-modules/lib/index.js:149-152`）；
`exports["./client"]` 没声明就属于这一类，它抛的是 `declares dsh.client but exports no "./client" bundle`（同文件 `:718-719`）。
所以先看这条日志，**别只看面板没反应**——面板"没反应"的另一种常见原因是
`conversation.view` 的注册没包在 `ctx.effect(...)` / `slots.inject(...)` 里（§13.2）。

---

## 附录 A：本手册的核验状态

**核验方式（本次）**：① 本项目全部源码、测试、README、设计文档逐读；② 主对话直接从宿主检出逐条比对类型文件与实现文件；③ **一个独立只读取证子代理复核 18 条断言**（未改文件、未联网、未写盘），结论与修正见本章末。

| 章节 | 核验状态 |
|---|---|
| §1 生效规则 / 入口形态 / `inject` / `effect` | 已核验（入口形态照 `dsh-tool-todo:196`、`dsh-tool-present:123`；`effect`/`on` 照 cordis `src/fiber.ts:402-417`、`src/events.ts:254-301`；`Inject` 类型照 `registry.d.ts:13`；注入待就绪语义照 `src/fiber.ts:611-639` + `src/reflect.ts:314-327`） |
| §2 依赖声明方式 | 已核验（三个官方工具包的 `package.json` 实读：宿主包 peer + dev 双份，`dsh` 字段仅 client 侧包有） |
| §3 事件表与签名 | **逐条已核验**（`tools/result` 双参 `dsh-tools/lib/types/index.d.ts:84`；`agent/created`/`agent/disposed`/`agent/turn-stopping` 照 `dsh-agent/lib/types/runtime-types.d.ts`；载荷融合机制照 `dsh-agent/lib/index.js:209-213`；`session/event` 照 `dsh-session/lib/index.js:1260-1269`） |
| §4.1 `systemPrompt.context` | 已核验（`dsh-agent-loop/lib/index.js:888`/`:891`；`dsh-system-prompt/lib/index.js:342`、`types/index.d.ts:72-79`） |
| §4.2 `steer` / `UserMessage` | 已核验（`message.d.ts:119-133`、`message.js:34-50`；`steer` 两种结局照 `dsh-agent-loop/lib/index.js:781-792`） |
| §5 工具注册 | 已核验（`ToolDefinition` 见 `dsh-tools/lib/types/index.d.ts:107-173`；`output` 必填且运行时强校验 `index.js:2878-2880`；`register` 见 `:611`；`defineTool` 见 `schema.d.ts`；范例 `dsh-tool-todo` / `dsh-tool-present` / `dsh-tool-ask-user`） |
| §5.5 `session.append` | 已核验（`dsh-tool-todo:173`；事件名可用 module augmentation 注册，如 `deliverables/presented`） |
| §6 持久化补零 / 必填字段 | 已核验（`dsh-session-persistence-jsonl/lib/index.js:814`/`:832`/`:839-840`；`dsh-subagent/lib/types/child-agent.js:111-125`） |
| §7 子代理隔离 | 已核验 |
| §10 备选通道 | **包名已核验；服务名与签名未核验**（表内已标注） |
| §11 测试策略 | 已核验（110 用例全绿） |
| §13 client 半边（**本次新增，2026-09-29 对着 dsh `0.1.7-rc.2` 核验**） | 已核验（加载器原样骨架 `dsh-client-ui-sidebar-files/lib/client.js:1-5`/`:1015-1018`、`dsh-client-ui-trajectory/lib/client.js:1-5`/`:8772-8776`；清单侧 `dsh-client-modules/lib/index.js:59-68`（`parseDshClient`）`:170-180`（`clientExportOf`）`:718-719`（缺 `exports["./client"]` 即抛）`:149-152`（compose 失败汇总）`:700-705`（模块表未命中）`:270-277`（`.map` 可缺）；类型 `dsh-package-manifest/lib/types/types.d.ts:75-89`；`conversation.view` 与 order `dsh-client-ui-chat/lib/client.js:12303-12307`、`dsh-client-ui-trajectory/lib/client.js:8736-8741`；`ctx.inject` 延迟注入范例 `dsh-api-gateway/lib/index.js:623,626`、`.dispose` 撤销器 `dsh-agent-loop/lib/index.js:1570-1579`、签名 `@deepseek-ai/cordis/lib/types/registry.d.ts:185`；**本插件实现** `client/memory-panel.js:2591-2648`：`inject = ['slots','remote','remote.workspaceFiles','sessions']`、`label` 中文硬编码、加载器 id `dsh-memory` 而插件 `name` 为 `dsh-memory-panel`；三页 UI（记忆/日志/图谱）+ 行内展开 + 样式注入（`installStyle` `:1080-1089`，106 条 `.dshmem-` 规则，与槽位注册合并在同一个 effect `:2591-2628`）；行身份 `rowKey = filePath + '#' + order`（`:682-684`/`:2208`/`:2196-2216`）＋**动作必须用当轮固定参数绑定**（`:2192-2247`）；`read` 只发 `offset`、翻页保险丝 `MAX_READ_PAGES = 200`（`:91-103`/`:791`）；写路径 `client/memory-panel.js:1492-1500` → `src/index.js:169-186` → `src/tools/archive.js:79/231-245/261-284`） |

### 独立复核结论（只读取证子代理，18 条断言）

方式：一个独立子代理**只读**复核了 18 条宿主断言（未修改任何文件、未联网、未写盘），逐条给出结论 + 文件:行号 + 代码原文。主对话随后对有偏差的条目**再次亲自复核**并改写正文。复核结果汇总（**含对初稿的 10 处修正**）：

| 断言 | 复核结论 | 证据 / 修正 |
|---|---|---|
| turn-stopping 派发点与 steer 语义 | ⚠️ **部分属实** | 派发点 **965**（初稿记 964 偏 1，`dispatch.serial`）。精确条件是"该轮已判结束**且 next-step 队列为空**"，不是"所有 step 跑完"。**新增发现**：agent **空闲**时 `steer` 会新开轮次（`wakeDriver`），"不新开轮次"只在运行中成立 |
| step 前 assemble / 文本变化才追加 | ✅ 属实 | `dsh-agent-loop/lib/index.js:888`、`:891`（`project` 定义 `:334-337`，返回 undefined 即不追加） |
| `text` 求值一行 | ✅ 属实 | `dsh-system-prompt/lib/index.js:342`（初稿写作 `!== undefined`，原文是 `typeof … === "function"`） |
| `systemPrompt.context` 签名与返回值 | ✅ 属实 | `dsh-system-prompt/lib/types/index.d.ts:72-79`、`:259`。**新增发现**：`name` 必须唯一（重名抛错）、`order` 非有限数抛 `TypeError`、按 order 升序拼接 |
| `createUserMessage` / `UserMessage` | ⚠️ **部分属实** | `message.js:34-50`：`createUserMessage` **只补 role**，`id` 由 `createMessage` 赋 `brandString(randomUUID())`。**`UserMessage.source` 未收窄**（是并集 `MessageSource`） |
| deepseek `messages.push` | ✅ 属实 | `dsh-llm-deepseek/lib/index.js:2269-2274`（`role` 在 2272）。**注**："role 为 undefined 被丢弃"是推论而非代码断言；类型上 `role` 不可选，只有绕过类型的调用方会踩 |
| `present` 的 append 时机 | ⚠️ **部分属实** | append **只在 `tools/result` 监听器里**（`dsh-tool-present/lib/index.js:110-120`），`execute` 只挂起；`turn` 来自 `boundary.lastTurn`；`files` 元素是 `{ path, description? }` |
| `tools/result` 签名与 `ToolExecution` 字段 | ✅ 属实 | 双参 + `@mode emit` + 按 `exec.agent` 作用域过滤（`dsh-tools/lib/index.js:3403-3410`）；**`ToolExecution` 无 `turn` 字段**，`agent` 可选、`arguments` 必填；判别键 `isError` |
| 工具注册服务名与 `output` 必填 | ✅ 属实 | 服务名 `tools`（`super(ctx, "tools")`）；`output` 必填且无默认渲染，运行时抛 `TypeError`（`index.js:2878-2880`）；`isConcurrencySafe` **严格 `=== true`** 才并行（`:3054-3062`） |
| 工具名 `^[a-z][a-z0-9_-]*$` | ❌ **不属实——已在正文更正** | DSH **不校验工具名形态**。真实约束：`run_code` 保留名（`index.js:2883`）+ 非空（`dsh-system-prompt/lib/invariant.js:25`）+ 模型侧字符集（MCP `^[A-Za-z0-9_-]{1,32}$`）。**该正则属于斜杠命令**（`dsh-commands/lib/index.js:78`） |
| `delegationDepth` 写/读 | ✅ 属实 | 写盘 `:814`、读回 `:832`、校验 `:840`（非负 **safe integer**，且 `delegationDepth` 在 `HEADER_REQUIRED_KEYS` 内） |
| 子会话继承父 `cwd` | ✅ 属实 | `dsh-subagent/lib/types/child-agent.js:111-125`（继承在 `:115`）；旁证 `dsh-workspace-changes` 用 lineage 而非 cwd 判定 |
| `SessionHeader` 字段 | ⚠️ **部分属实** | 路径应为 `dsh-session/lib/types/types.d.ts`；`origin` **只有 `'subagent'` 一个取值**；`isSeeded` 必填；`delegationDepth` **逻辑类型可选但物理必填** |
| `agent/created` 载荷与 await 时机 | ✅ 属实 | `runtime-types.d.ts:227-231`、`:105`；派发 `dsh-agent/lib/index.js:538-549`。**保留项**：`'clear'`/`'compact'` **尚无发出方** |
| `session/event` 双参与事件形状 | ✅ 属实 | `dsh-session/lib/index.js:1260-1269`；`{ type, seq, time, data }`；`turn/start` 的轮次号在 `data.turn` |
| `agent/disposed` 载荷 | ✅ 属实 | `runtime-types.d.ts:240-242`；派发 `dsh-agent/lib/index.js:513-518` |
| cordis `effect` / `on` | ⚠️ **需精确化** | `effect` 返回的是**新的**"拆解整个 effect"的 disposer，**不等于回调返回的那个**；回调产生的 disposer 逆序执行；已释放 fiber 抛 `INACTIVE_EFFECT`。`on` 返回 `() => boolean` |
| 严格注入语义 | ✅ 属实 | **依赖缺失 → 状态 PENDING、`apply` 不跑**；提供者出现后经 `notify` → `_refresh` → 在**微任务**里执行 `apply`；未就绪 fiber 内访问服务抛 `cannot get required service … in inactive context` |

**结论**：初稿 18 条里 **14 条属实 / 3 条部分属实 / 1 条不属实**。全部偏差已按复核结论改写正文（不属实那条已在 §5.3 就地标注更正），不存在"按错的手册写代码"的风险。

> 另注：`dsh-agent` 与 `dsh-agent-loop` 的 **`lib/index.js` 与 `lib/types/index.js` 是两份内容重复的副本**（仅引号风格/缩进不同），且 `dsh-agent\lib\types\index.d.ts` 确实存在。用 grep 定位行号时若发现"行号对不上"，先确认命中的是哪一份。

## 附录 B：权威出处索引

写代码时按这些位置核对，别凭印象：

| 要核对的 | 去哪里找 |
|---|---|
| 事件有哪些、签名是什么 | `dsh-agent*` / `dsh-tools` / `dsh-session*` 的 `lib/**/*.d.ts`，事件用 `.emit(` 搜 |
| **`tools/result` 权威定义** | `dsh-tools/lib/types/index.d.ts:84`（含 `@mode emit` 与作用域过滤说明） |
| 工具定义形状 | `dsh-tools/lib/types/index.d.ts:107` 的 `ToolDefinition`／`ToolOutputDefinition`；范例 `dsh-tool-todo/lib/index.js:95-193` |
| `defineTool` 辅助 | `dsh-tools/lib/types/schema.d.ts`（`DefineToolOptions`、`ParameterSchemaSpec`） |
| 消息形状 | `dsh-llm/lib/types/message.d.ts:120`（`Message`）`:131`（`UserMessage`）；工厂 `message.js:34/45` |
| 系统提示词贡献 | `dsh-system-prompt/lib/index.js` 的 `context(` 定义与 `assemble` |
| 轮次与 step 时机 | `dsh-agent-loop/lib/index.js`（`turn-stopping` 派发、`preStep`） |
| 会话头字段 | `dsh-session/lib/types.d.ts` 的 `SessionHeader` |
| 子会话构造 | `dsh-subagent/lib/types/child-agent.js` |
| 持久化补零 | `dsh-session-persistence-jsonl/lib/index.js` |
| Cordis 生命周期 | `cordis/lib/types/fiber.d.ts`（`effect`）、`events.d.ts`（`on`）、`registry.d.ts`（`inject`/`Plugin`）、`service.d.ts`（`Service`） |
| **client 半边（加载器 / 清单 / 槽位）** | `dsh-client-modules/lib/index.js`（`dsh.client` 校验、`exports["./client"]` 解析、boot 清单与模块表）＋ `dsh-client-modules/lib/client.js`（页面侧加载器）；`dsh-client-ui-*/lib/client.js`（`window.__ModuleLoader__.load` 与 `ctx.slots.register` 的原样范例） |
| 槽位清单与 `conversation.view` | `dsh-client-ui-chat` / `dsh-client-ui-trajectory` / `dsh-client-ui-sidebar-files` 的 `lib/client.js`（各自的 `inject` 数组 + `slots.register`） |
| 宿主命令服务 | `dsh-commands/lib/types/index.d.ts`（`CommandDefinition`、`register`、`execute`）、`lib/types/types.d.ts`（`CommandResult` 的 `kind`） |
| 工作区只读文件面 | `dsh-api-workspace-files/lib/index.js`（`inspect`/`confine`/`read`/`list`）、`lib/types/types.d.ts`（页形状 + `RemoteErrorDetailsMap` 错误码） |
| 插件合同 | `dsh-plugin-studio/references/contracts.md` |

**本机路径**：`C:\Users\25286\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包名>\`

## 附录 C：三个可直接照抄的官方插件

写新插件时**不要从零开始**，从这三个里挑最接近的抄骨架（三个都已核验）：

| 范例 | 结构特点 | 适合抄什么 |
|---|---|---|
| `dsh-tool-ask-user`（最简） | `name` / `inject` / `apply` 三个导出，**无 `Config`** | 只要一个工具的最小事例。**注意它连 `Config` 都不导出**，说明 `Config` 是可选增强 |
| `dsh-tool-present` | `Config = z.object({ maxFiles: z.number().default(8) })`；用 `WeakMap` 挂起跨事件状态；在自己的 `tools/result` 里完成副作用 | **"想记录一次成功"该怎么写**；跨 execute/result 传递状态 |
| `dsh-tool-todo` | 同时注册 `ctx.sessionProjections`（派发式状态投影）；`Config` 有**必填项**；带 `presentCall` 渲染提示 | **领域事件 + 投影**；UI 呈现；必填配置 |

三者共同点（这就是宿主侧工具包的标准形态）：

```js
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'tool-xxx';                 // 插件名，非工具名
const Config = z.object({ … });          // 可选
const inject = ['tools', …];
function apply(ctx, config) { ctx.tools.register(defineTool({ … })); }
export { Config, apply, inject, name };  // 具名导出，无 default
```

`package.json` 侧：宿主包写 `peerDependencies` + `devDependencies` 双份（`^0.1.6-alpha.2` / cordis `^4.0.2`），第三方包写 `dependencies`，**不写 `dsh` 字段**。

**另一个可借鉴的模式：给会话事件表做 module augmentation**。`present` 就是这么把自己的事件注册进类型的（`dsh-tool-present/lib/types/types.d.ts:3-18`）：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'deliverables/presented': { turn: number; callId: ToolCallId; files: PresentedFile[] };
  }
}
```

记忆插件若要 `session.append('memory/updated', …)`，照这个模式补一个事件声明，类型侧就能查到——**这正是 R1 设计里"把记忆变更记进会话日志"该走的路**。
