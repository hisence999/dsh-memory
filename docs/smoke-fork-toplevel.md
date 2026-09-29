# fork 顶层会话误判为子代理 —— 真机冒烟证据（2026-09-26）

> 目的：证明"会话 fork 后写入类工具被摘掉、模型拿到 `Error: unknown tool`"这一 P0 已在**真实 DSH 进程**里修好，
> 并且证明**这份探针确实能抓到旧 bug**（A/B 对照），不是"跑一遍看着没报错"。
>
> 环境：两个隔离 profile `fork-smoke` / `fork-smoke-old`（由 shipped `headless` 模板用
> `dsh fork-smoke --from-default-profile headless --dump-config` 初始化）；插件以 `link:` 装进 profile。
> 冒烟工作区 `D:\dsh-memory-v2\.tmp-smoke\ws`（`ws-old` 给旧 build）。**未触碰** desktop/web/headless 三个既有 profile。
>
> 探针插件（只读，不改被测代码）：[`fork-smoke-probe/`](fork-smoke-probe/)——等第一个顶层 agent 创建完，
> 用宿主公开 API 照 `dsh-api-session-controller` 的 `commands.fork()` 造一次真实形状的 fork
> （`ctx.agents.create({ sessionId, seed, inheritedEventCount, meta: { cwd, parentSession, isSeeded: true } })`），
> 再用宿主自己的可见性解析器 `ctx.tools.get(name, agent)` 逐个查五个 `memory_*`。

## 1. 为什么 `ctx.tools.get()` 就是那条 BUG 的判据

模型调用工具时，`dsh-tools` 的分发路径用同一个 `resolveExecution` / `get(name, agent)` 解析；
解析不到就抛 `ToolNotFoundError`，其消息由 `dsh-tools` 构造成 `unknown tool "<name>"`（`code: UNKNOWN_TOOL`），
循环层再渲染成模型看到的 `Error: unknown tool "<name>"`。
所以"fork 会话里 `get('memory_write', forkAgent) === undefined`"**就是**"模型会看到 unknown tool"。

## 2. A/B 对照（同一份探针、同一条路径、只换插件 build）

| | 父会话（顶层）五个工具 | fork 会话 `memory_write`/`edit`/`archive`/`log` | fork 会话 `memory_search` | 判定 |
|---|---|---|---|---|
| **修复前**（`backups/2026-09-26-fork-toplevel/` 的 `identity.js` + `index.js`） | 全部 true | **全部 false** | true | `FAIL：fork 顶层会话的写入类工具被摘掉了（就是那条 BUG）` |
| **修复后**（当前源码） | 全部 true | **全部 true** | true | `PASS：fork 顶层会话仍能看到四个写入类工具（不会再出现 unknown tool）` |

真机 dump 出来的 fork header（两侧一致，确认造的就是宿主的那种 fork）：

```json
{ "headerKeys": ["createdAt", "cwd", "id", "isSeeded", "parentSession", "version"],
  "parentSession": "session-fb72e032-…", "origin": null, "delegationDepth": null, "isSeeded": true }
```

→ 有 `parentSession`、**没有 `origin`**（真子代理才有 `origin: 'subagent'`）；`delegationDepth` 内存态缺省、落盘才补 0。
这正是旧 `isSubagent()`（把 `parentSession` 当子代理判据）会误判的形状。

会话 id（可追溯）：修复后 `session-bce5823c-…` → fork `session-fork-smoke-1790429297246`；
修复前 `session-fb72e032-…` → fork `session-fork-smoke-1790429317528`。

## 3. 与用户真机日志的对照（同一根因的现场）

用户导出的 fork 会话日志（`session-285ad135-…`，cwd `D:\PowerShell`，header 同形：`parentSession` 有、无 `origin`、`isSeeded: true`）：

- 继承前缀里的 `request/header`（seq 12／76／91）仍通告全部 5 个 `memory_*`，其中 `memory_log`(106/141)、`memory_write`(166) 都成功；
- fork 自有区间第一条 `request/header`（seq 180，`reason: resume`）**只剩 `memory_search`**；
- 模型随即调用 → seq 204 `Error: unknown tool "memory_write"`、seq 206 `Error: unknown tool "memory_log"`（`ToolNotFoundError` / `UNKNOWN_TOOL`）。

这与上表"修复前"那一行逐条吻合：**可见面被 `restrict` 摘掉四个写入工具，`memory_search` 留下**。

## 4. 复现命令（探针与 patch 已随仓库保留）

```powershell
# 1) 隔离 profile（不碰既有 profile）
dsh fork-smoke --from-default-profile headless --dump-config
dsh plugin --profile fork-smoke add D:\dsh-memory-v2
dsh plugin --profile fork-smoke add D:\dsh-memory-v2\docs\fork-smoke-probe
# 2) 跑一轮（探针把报告写到 FORK_SMOKE_OUT）
$env:FORK_SMOKE_OUT='D:\dsh-memory-v2\.tmp-smoke\new'; $env:FORK_SMOKE_LABEL='new-build'
dsh fork-smoke "只回复 OK 两个字，不要调用任何工具。"
Get-Content D:\dsh-memory-v2\.tmp-smoke\new\fork-smoke-report.json
```

> A/B 时把第 1 步的插件换成一个"旧 `identity.js` + 旧 `index.js`"的副本目录（本次用 `.tmp-smoke/old-plugin/`），
> 其余完全相同；两侧必须都留下 `fork-smoke-report.json` 才能对照。
>
> ⚠️ 两个踩坑（本次真踩）：① `ctx.agents.create()` 返回的是 **AgentHandle**（`{agent, dispose}`），
> 必须再 `ctx.agents.get(id)` 拿真正的 agent，否则 `ctx.tools.get(name, undefined)` 会退化成"无作用域视角"、恒为 true → **假 PASS**；
> ② headless 是一次性会话，探针要尽早跑（150ms），否则会撞上"上下文已停用"的收尾竞态。

## 5. 清理记录

- 隔离 profile `fork-smoke` / `fork-smoke-old` 与临时目录 `.tmp-smoke/` 已按"移动到回收站"清理；
  清理前按 [memory #0006] 的规矩先 `cmd /c rmdir` 摘掉 `node_modules` 里指向插件源码的符号链接，
  确认 `D:\dsh-memory-v2\src\index.js` 仍在，再整体回收。
- 探针插件与它的 patch 保留在 [`fork-smoke-probe/`](fork-smoke-probe/)（下次重跑只需重建 profile）。
- 清理后复核：`npm test` 全绿、`npm run typecheck` exit 0、源码与既有 profile 未受影响。
