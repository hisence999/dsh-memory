# dsh-memory-v2 · 接口契约（阶段 0 冻结件）

> **本文件是并行开发的唯一接口依据。**行为依据是 [docs/memory-tools-design-r1.4.md](docs/memory-tools-design-r1.4.md)（下称"设计"），
> 宿主 API 事实依据是 [docs/dsh-plugin-dev-handbook.md](docs/dsh-plugin-dev-handbook.md)（下称"手册"）。
> 改动本文件必须由 Lead 统一落笔；成员需要新导出/改签名时先提出，不要各自发明。

## 0. 工程约定（所有成员必须遵守）

| # | 约定 | 理由 |
|---|---|---|
| 1 | **零运行时依赖**：源码不 import 任何 `@deepseek-ai/*`；`types/dsh.d.ts` 是 declare-only，只给 tsc 读 | 手册 §2：宿主包写进 `dependencies` 会装出第二份；源码即产物，无构建步骤 |
| 2 | 所有注册走 `ctx.on()` / `ctx.effect()`，用返回的 disposer 清理 | 手册 §1：注册必须走 effect，否则热重载泄漏 |
| 3 | 每个事件监听器与 `systemPrompt.context` 的 `text()` **内部必须 try/catch**，失败只记 warn | 手册 §9.6：注入求值抛错会污染整个上下文组装 |
| 4 | 工具定义**必须带 `output`**（`{ schema, render }`）；`isConcurrencySafe` 一律 `() => false` | 宿主运行时强校验，缺失即 `TypeError`；并发安全要显式 opt-in |
| 5 | **一切落盘只经 `store.applyBatch`**（内部含跨进程锁 + intent + 固定顺序） | 设计 §12.1：原子性只在一处实现，五个工具不许各自写盘 |
| 6 | **注入路径只读**：`text()` 只返回缓存字符串，永不读写磁盘 | 设计 §1.4／§6.1：每 step 都会求值 |
| 7 | `usage` 只进搜索排序，**不进注入排序** | 设计 §9.4 |
| 8 | 面向人的文本一律中文；工具返回必须含"做了什么／结果如何／下一步建议" | 设计 §7.6 |
| 9 | 每个模块自带 `test/<模块名>.test.js`，用 `node:test` + `node:assert/strict`；测试用 `fs.mkdtempSync` 临时目录，**绝不碰真实项目目录** | 现有工程的测试纪律 |
| 10 | 只改自己任务范围内的文件；**不 `rm -rf`**；接口要变先找 Lead | 团队写入范围不重叠 |

## 1. 模块与负责人（写入范围互不重叠）

| 模块 | 负责人 | 文件 |
|---|---|---|
| 配置、解析/渲染、装配 | **Lead** | `src/config.js`、`src/parse.js`、`src/identity.js`、`src/index.js`、`README.md`、`docs/*`、工程文件 |
| 状态与持久化层 | **io-state** | `src/memory-files.js`、`src/lock.js`、`src/intent.js`、`src/ids.js`、`src/state.js`、`src/index-md.js`、`src/store.js`、`test/{memory-files,lock,intent,ids,state,index-md,store}.test.js` |
| 交付提醒 | **remind** | `src/delivery.js`、`src/reminder-text.js`、`test/{delivery,reminder-text}.test.js` |
| 五个工具与判定层 | **tools-layer** | `src/tools/*.js`、`src/dedup.js`、`src/sensitive.js`、`src/errors.js`、`test/{tools-*,dedup,sensitive,errors}.test.js` |
| 快照与提示词 | **inject-prompts** | `src/snapshot.js`、`src/prompts.js`、`test/{snapshot,prompts}.test.js` |
| 只读复核 | **verifier** | 只读，不写任何文件（结论用消息回报） |

## 2. 共享数据形状（Lead 拥有，任何模块不得私自扩展字段语义）

```js
/** @typedef {object} Warning
 *  @property {string} code      见 §4 的码表
 *  @property {string} message   面向人的中文说明
 *  @property {string} [filePath]
 *  @property {string} [id]
 */

/** @typedef {'convention'|'fact'|'procedure'|'lesson'} Kind          约定/事实/流程/经验
 *  @typedef {'active'|'candidate'|'superseded'|'archived'} Status      expired 是派生态，不落盘
 *  @typedef {'high'|'medium'|'low'} Priority
 *  @typedef {'confirmed'|'observed'|'inferred'|'temporary'} Confidence */

/** @typedef {object} Entry   长期记忆条目（解析的权威表示）
 *  @property {string|null} id                    '#0007'；无编号时为 null（尚未补发）
 *  @property {Kind} kind
 *  @property {string} title                      无 '#编号'、无字段行
 *  @property {string} detail                     '' = 无「详细」字段
 *  @property {Status} status
 *  @property {boolean} pinned                    纯人工字段，工具永不写
 *  @property {Priority} priority
 *  @property {Confidence} confidence
 *  @property {string} created                    YYYY-MM-DD
 *  @property {string} updated                    YYYY-MM-DD
 *  @property {string} expiresAt                  YYYY-MM-DD 或 '永久'
 *  @property {string[]} tags
 *  @property {string[]} aliases
 *  @property {string[]} related                  ['#0001']
 *  @property {string[]} supersedes
 *  @property {string|null} supersededBy
 *  @property {string[]} relatedJournal           ['J-20260920-1432']
 *  @property {string} source
 *  @property {string|null} archivedAt            'YYYY-MM-DD HH:MM'
 *  @property {string|null} archivedReason
 *  @property {Status|null} archivedStatusBefore  恢复时回填到 status
 *  @property {Array<{name: string, value: string, anchor: string|null}>} unknownFields
 *             anchor = 紧邻的前一个已知字段名；null 表示位于字段区最前（锚点是标题行）
 *  @property {string[]} presentFields            源文件里**显式写出**过的已知字段名
 *            （回写判定：写过的保留；没写的只在值偏离默认时才补，避免无意义地"整理"文件）
 *  @property {string[]} orphanNotes              不属于本条目、必须原样回写的行
 *            （含被空行终止后仍缩进的备注，用于保证位置不漂移、内容不丢）
 *  @property {string} filePath                   绝对路径
 *  @property {string} fileDate                   YYYY-MM-DD（归属日期，取自文件名）
 *  @property {number} order                      文件内出现顺序（0 起）
 *  @property {string} raw                        原始文本片段，解析降级时原样保留
 */

/** @typedef {object} JournalEntry  项目日志条目
 *  @property {string|null} id                    'J-20260920-1432'（同分钟加 '-2'）
 *  @property {string} title
 *  @property {string} content                    供检索/展示的正文（取「内容/详细/结果」首个非空）
 *  @property {string} date                       归属日期 YYYY-MM-DD（= 文件日期）
 *  @property {Array<{name: string, value: string}>} fields  **有序数组**（保序回写；含任意字段名）
 *  @property {string} filePath
 *  @property {number} order
 *  @property {string} raw
 */

/** @typedef {object} ProjectModel
 *  @property {string} projectRoot
 *  @property {string} memoryDir
 *  @property {Entry[]} entries                  活动 + 归档（按 fileDate 升序、文件内 order）
 *  @property {Entry[]} active                   非归档文件中的条目
 *  @property {Entry[]} archived                 archive/ 下的条目
 *  @property {JournalEntry[]} journals
 *  @property {number} nextId                    水位线（已分配的最大编号）
 *  @property {Record<string, {count: number, lastUsedAt: string}>} usage
 *  @property {Warning[]} warnings
 */
```

## 3. 冻结签名（按负责人分组）

### 3.1 `src/config.js`（Lead）

```js
export const DEFAULTS;                          // 见 cordis.patch.yml 的键与默认值
export function resolveConfig(raw);             // 非法值回退默认并记 warn，绝不抛错（手册 §8.1）
```

### 3.2 `src/parse.js`（Lead）—— 全项目共享的数据模型（**已交付，2026-09-20**）

```js
export const KINDS;                             // ['convention','fact','procedure','lesson']
export const KIND_LABEL;                        // {convention:'约定', fact:'事实', procedure:'流程', lesson:'经验'}
export const LABEL_KIND;                        // 展示名 -> 内部值
export const KIND_ORDER;                        // 注入/索引用：约定=1 事实=2 流程=3 经验=4
export const STATUS_RANK;                       // archived=0 superseded=1 expired=2 candidate=3 active=4
export const STATUSES, CONFIDENCES, PRIORITIES, FIELD_NAMES, JOURNAL_FIELD_NAMES;
export const KEY_FIELD, FIELD_KEY;              // 内部键 <-> 中文字段名（§5.2 表顺序）
export const KIND_DEFAULT_PRIORITY;

export function parseMemoryFile(content, filePath);
  // -> { entries: Entry[], warnings: Warning[], damaged: boolean, preamble: string[] }
  //    damaged=true 表示解析链降级（已按"无内容"处理，原文仍在文件里）
  //    preamble = 第一个条目之前、非 H1 的行（人类备注，渲染时原样写回）
export function parseJournalFile(content, filePath);  // -> { entries: JournalEntry[], warnings: Warning[] }
export function renderMemoryFile(fileDate, entries, options?);  // options = { preamble?: string[] }
export function renderJournalFile(fileDate, entries);
export function renderEntry(entry);                   // -> string[]（含未知字段按锚点回写、orphanNotes 原样回写）
export function fieldValueOf(journalEntry, name);     // -> string|null

export function normalize(text);                // §8.1：NFKC + 小写 + 路径分隔符统一 + 空白折叠
export function splitList(value);               // 逗号/顿号分隔 -> string[]
export function isExpired(entry, today);
export function effectiveStatus(entry, today);   // archived > superseded > expired > candidate > active
export function participatesInInjection(entry, today);  // effectiveStatus === 'active'
export function defaultPriority(kind);
export function measureEntry(entry);             // -> { titleChars, detailChars, itemChars }（§5.6 判定用，Unicode 计数）
export function fileDateOf(filePath);            // 'M-2026-09-20.md' -> '2026-09-20'；否则 null
export function todayLocal(now?);                // 'YYYY-MM-DD'（本机本地，不用 UTC）
export function timeLocal(now?);                 // 'HH:MM'
export function addDays(dateStr, delta);         // 本地日历日加减（UTC 毫秒运算，避免夏令时偏移）
export function makeJournalId(date, time, taken);// J-YYYYMMDD-HHMM，同分钟自动 -2/-3（§5.4）
```

**parse.js 已冻结的行为细节**（其他模块按此假设，不要各写一套）：

| 行为 | 约定 |
|---|---|
| 字段行容错 | 列表标记可选：`  - 状态：active`、`\t- 详细：…`、` 状态：active` 都能解析 |
| 未知字段 | 存 `unknownFields`，`anchor` = 紧邻的前一个**已知**字段名（无则 null）；回写时插回同一锚点之后 |
| 顶格行 | 三条互斥判定（§5.5 第 7 条）：已知字段名 → 按字段 + `field-no-indent` 告警；列表项 → 新条目；其余 → 备注保留 + `free-field` 告警 |
| 空行 | 终止条目；**末尾空行不算**（忽略）；条目内含空行的行按备注挂回该条（保位置），记 `entry-blank-line` |
| 空分节 | 渲染时不输出空分节（§6.2 允许按需新建分节） |
| 编号 | 标题里写了就保留（左补零到 4 位）；没写则 `id = null`，由 store/ids 补发 |
| 长度 | parse **不判长度**（不读配置）；调用方用 `measureEntry` + `config` 判定 |
| 抛错 | 任何异常都被收敛成 `damaged: true` + `parse-damaged` 告警，原文不丢 |

### 3.3 `src/memory-files.js`（io-state）

```js
export async function readText(filePath);                       // -> { content, error? }（读失败按空内容处理）
export function fingerprint(content);                           // 内容指纹（sha256 hex 前 16 位即可）
export async function writeAtomic(filePath, content, opts);     // 同目录临时文件 + rename
                                                                //   opts = { expectedFingerprint?, signal? }
                                                                //   -> { ok, code?: 'write_conflict'|'io_error', error? }
export async function ensureFile(filePath, content);            // writeFile flag:'wx'，已存在即 no-op
                                                                //   -> { created: boolean, error? }
export async function withPathQueue(key, fn);                   // 同一 key 的异步任务串行（进程内）
export async function listDir(dir);                             // -> string[] 文件名（不存在返回 []）
export async function mkdirp(dir);                              // -> { ok, error? }
export async function backupFile(filePath, backupPath);         // 复制一份原内容（intent 回滚用）
export async function removeFile(filePath);                     // 删除单个文件（仅 intent 的临时/备份文件）
```

### 3.4 `src/lock.js`（io-state）

```js
export async function acquireLock(lockPath, opts);  // opts = { timeoutMs, staleMs, signal? }
  // -> { ok: true, release: () => Promise<void> } | { ok: false, reason: 'locked'|'io_error', error? }
  // 实现：wx 创建锁文件；超时前轮询等待；发现 staleMs 以上的陈旧锁则接管并记 warn
```

### 3.5 `src/intent.js`（io-state）

```js
export const INTENT_FILE;                       // '.state/intent.json'
export async function beginIntent(memoryDir, payload);   // -> { ok, intentPath?, error? }
  // payload = { version: 1, op: 'batch'|'archive'|'restore'|'reindex',
  //             files: Array<{ path, tmpPath, backupPath }>, createdAt }
  //   path      = 目标文件；tmpPath = 已写好的新内容临时文件；backupPath = 原内容副本（回滚用）
  //   beginIntent 会为每个文件项补写两个可选字段（调用方不必传）：
  //     beforeFingerprint = 落盘前目标内容的指纹（原本不存在则 null）
  //     afterFingerprint  = 临时文件（即新版本）内容的指纹
export async function commitIntent(intentPath);           // 删除 intent 文件 = 提交（设计 §12.1）
export async function converge(memoryDir, { warn, info }); // 收敛点：前滚或回滚 + 删除 intent
  // -> { recovered: false | 'rolled-forward' | 'rolled-back', degraded?: boolean, warnings: Warning[] }
  // 三条裁决（task-8 修复后定死，别再改）：
  //   ① 每个文件先判 fileState：等于 afterFingerprint → 新版本；等于 beforeFingerprint（或原本不存在且仍不存在）
  //      → 旧版本；**两者都不等 → 无法核对**（典型：收敛点之前有人工编辑）。
  //   ② 出现"无法核对" → **绝不覆盖**：保留 intent、记 `write-conflict`、返回 { recovered:false, degraded:true }。
  //   ③ 全部文件都是新版本 → 判为"上次已完成落盘、只差提交" → **确认提交，不回滚**；
  //      只有"确需前滚但临时文件已丢"才整体回滚。**前滚优先于回滚**（撤销已完成内容才是更大的伤害）。
```

### 3.6 `src/ids.js`（io-state）

```js
export function parseId(text);                  // '#0007' -> 7；非法返回 null
export function formatId(n);                    // 7 -> '#0007'
export function watermark({ idsFileContent, indexNote, activeIds, archivedIds });  // 设计 §6.1
export function allocate(startWatermark, count); // -> { ids: string[], next: number }
export function repairDuplicates(entries);       // -> { entries, warnings }（活动文件日期升序 → 归档 → 文件内顺序）
```

### 3.7 `src/state.js`（io-state）

```js
export async function loadState(memoryDir);      // -> { ids: number|null, usage: Record<string,{count,lastUsedAt}>, warnings }
export async function saveState(memoryDir, patch); // 原子写 .state/ids 与 .state/usage.json -> { ok, error? }
export function bumpUsage(usage, ids, nowDateIso); // 纯函数，返回新 usage（不落盘）
```

### 3.8 `src/index-md.js`（io-state）

```js
export function indexNoteLine(nextId);           // 'next-id: 0011'
export function readIndexNote(content);          // -> number|null
export function renderIndex(model, { today });   // 设计 §2.3：全部非归档条目、重建顺序、★/（置顶）/⚠ 超限未注入
```

### 3.9 `src/store.js`（io-state）—— 唯一的写入入口

```js
export async function loadProject({ workspace, config });        // -> ProjectModel（读 + 隔离损坏 + 派生 warnings）
export async function applyBatch(model, ops, { config, today }); // 锁 → 校验 → intent → 落盘 → 提交 → converge
  // ops（一次调用可含多条，按"先归档/恢复，后写/编辑/日志"顺序执行）
  //   { type: 'write',   entries: NewEntry[] }   NewEntry = { kind, title, detail?, priority?, confidence?,
  //                                                             status?, tags?, aliases?, source?, expiresAt?,
  //                                                             relatedJournal?, relatedMemory?, supersedes? }
  //   { type: 'edit',    edits: EditInput[] }    EditInput = { id, title?, detail?|null, kind?, status?,
  //                                                             priority?, confidence?, tags?|[], aliases?|[],
  //                                                             expiresAt?|null }
  //   { type: 'archive', ids: string[], reason? }
  //   { type: 'restore', ids: string[] }
  //   { type: 'log',     entries: JournalInput[] }
  // -> { ok: true, result: { assignedIds, archived, restored, journalIds, paths, similar? }, warnings }
  //  | { ok: false, code, message, nextStep, entryIndex?, warnings }   （§7.6 错误码)
export async function rebuildIndex(model, { config, today });     // 显式重建 INDEX.md（不写记忆内容）
export async function syncAtBoundary(model, { config, today });   // 会话边界写回：补编号/修重复/落 ids/重建 INDEX.md
  // -> { ok, wrote, warnings, error? }；**项目里没有任何记忆内容时直接 {ok:true, wrote:false}，不建 memory/**
export async function recordUsage(model, ids, { now });           // usage 落盘（只有"返回正文"的搜索才调用）
```

**store 的职责边界（其他模块不要重复实现）**：目录创建、跨进程锁、intent/收敛、编号补发与水位线落盘、
`INDEX.md` 写入、`usage` 落盘、把 §7.6 的校验失败整理成错误对象。**校验规则本身**（重复/相似/冲突/敏感/超长）
由 `dedup.js`/`sensitive.js` 提供，store 只调用。

### 3.10 `src/delivery.js` + `src/reminder-text.js`（remind）

```js
export function createDeliveryState();
export function onTurnStart(state);
export function onToolResult(state);
export function onDeliverablePresented(state, turn, warn);
export function evaluateTurnStopping({ state, turn, completionIdleTurns, reminderCooldownTurns, remindOnDelivery });
  // -> { remind: boolean, completedNow: boolean, cooldownHit?: boolean }
  // 与旧实现的三处差异（设计 §17.3）：
  //  1) turn 必须 Number.isInteger(turn) && turn > 0，否则直接返回 {remind:false,completedNow:false}
  //  2) 冷却命中：置 taskReminded=true，**不更新 lastRemindTurn**，返回 cooldownHit:true（供调用方记 warn）
  //  3) 不补发

export function buildReminderText({ msgPrefix, fileName, filePath });  // 首行以 msgPrefix 开头
export function buildReminderMessage({ msgPrefix, fileName, filePath, pluginName });  // -> UserMessage（id/role/content/source 齐全）
```

### 3.11 `src/sensitive.js` / `src/errors.js` / `src/dedup.js`（tools-layer）

```js
// sensitive.js
export function scanSensitive(text);            // -> { hit, category?: 'credential'|'connection'|'identity' }
export function scanEntryTexts(parts);          // parts = { title, detail, tags, aliases } -> 命中清单（不回显原文）

// errors.js
export const CODES;                             // invalid_param|not_found|duplicate|conflict|sensitive|too_long|write_conflict|locked|degraded
export function makeError(code, info);          // info = { message, nextStep, entryIndex?, field? }
export function errorToText(error);             // "做了什么 / 结果如何 / 下一步建议"

// dedup.js
export function findDuplicate(title, entries, { today });                       // -> { id } | null
export function findSimilar(title, entries, { today });                         // -> Array<{ id, reason: 'substring'|'edit-distance' }>
export function extractFingerprints(title);                                     // 端口/版本/路径/独立数字
export function findConflicts(candidate, entries, { today, excludeIds });       // 四要素（设计 §8.3）
```

### 3.12 `src/tools/*.js`（tools-layer）

```js
// 五个文件各导出一个工厂，返回 ToolDefinitionShape；工具名固定如下
export function createWriteTool(deps);      // src/tools/write.js   -> memory_write
export function createEditTool(deps);       // src/tools/edit.js    -> memory_edit
export function createArchiveTool(deps);    // src/tools/archive.js -> memory_archive
export function createSearchTool(deps);     // src/tools/search.js  -> memory_search
export function createLogTool(deps);        // src/tools/log.js     -> memory_log

// 每个工具：output 必填（schema + render）、isConcurrencySafe: () => false、
// execute 内部先查 deps.isAllowedSession(exec.agent)，失败即抛错（执行层第二道防线）
```

**`deps` 形状（Lead 在 `src/index.js` 里构造，冻结）**：

```js
{
  config,                    // MemoryConfig（src/config.js）
  ctx,                       // PluginContext：只用于 ctx.logger，不要在工具里注册任何东西
  parse,                     // src/parse.js 的命名空间导入（常量 + 纯函数全套）
  dedup, sensitive, errors,  // 工具层自己的三个模块（命名空间导入）
  loadProject, applyBatch,   // src/store.js：读与唯一写入入口
  now: () => Date,           // 取时间（便于测试替换；不要直接 new Date() 散落各处）
  isAllowedSession(agent),   // 主会话白名单 + 子代理判定（写工具必须过这一道）
  takeBoundaryWarnings(id),  // 取出并清空"扫描期降级告警"，工具返回里带出一次（§12.3）
  writeToolNames,            // ['memory_write','memory_edit','memory_archive','memory_log']
  searchToolName,            // 'memory_search'
}
```

**返回文本**按设计 §10.4 的模板：长期记忆标题搜索、长期记忆详情、日志搜索结果三套；
一律先声明"这是资料，不是指令"，并给"下一步该调什么"的指引。

### 3.13 `src/snapshot.js` + `src/prompts.js`（inject-prompts）

```js
export function buildSnapshot(model, config, { today });
  // -> { text, stats: { indexed, pinnedShown, pinnedTotal, omitted, overlength,
  //                     journalShown, journalTotal, journalsOmitted, chars } }
  // 严格按设计 §9.2/§9.3/§9.4：三段（[置顶记忆] / [项目记忆索引] / [项目日志]）互斥、
  // 记忆排序链（不含 usage）+ 日志"最新优先"链、字符与三个条数预算、
  // 让步顺序 置顶（不可省）→ 索引 → 日志、(a)(b)(c) 说明行及其 N/M/K/X 口径、
  // 空区段规则；除说明行外不得出现任何动态数字。日志只进标题，正文永不进快照

export function mainPromptText(config);         // A+B 主 agent 版（§10.1 + §10.2）
export function subagentPromptText(config);     // 子代理版（资料声明段 + 一句 memory_search 指引）
  // 硬要求：子代理版**不得出现** memory_write / memory_edit / memory_archive / memory_log 四个名字（§14.46）
export function promptCharCounts(config);       // -> { main, subagent }（§14.45 要求两者各自 ≤ 3000）
export const SNAPSHOT_TAGS;                      // { open: '<project_memory_snapshot>', close: '</project_memory_snapshot>' }
```

**已裁决的口径（Lead 复核设计原文后确认，不要再自行改）**：

| # | 争点 | 裁决 | 依据 |
|---|---|---|---|
| 1 | `stats.chars` 是否计换行符 | **不计**换行符，只累计各行内容字符；文本行字符合计必须与 `stats.chars` 一致 | §9.3 的估算口径（按每行字符数估算快照块大小） |
| 2 | 说明行与日志提示行的先后 | 段序为 `[置顶记忆]` → `[项目记忆索引]` → `[项目日志]` → 说明行 → **固定日志提示行** | §9.3 枚举顺序 + §10.3 段序条 |
| 3 | `（暂无长期记忆）` 何时出现 | 只在**没有任何可注入长期记忆**时出现；条目只是被字符预算截断掉时不写占位行（由 (a) 句解释） | §9.4 空区段规则 + 避免"暂无"与"省略了 N 条"自相矛盾 |
| 4 | 超长条目在注入里怎么算 | **完全退出注入**（置顶的也不渲染 `★`），只计入 (b) 句，不算进 (a) 的 N/M | §5.6"不进入会话边界快照的索引段与注入"、§5.2 结论 4（置顶只对参与注入的条目生效） |
| 5 | 子代理版保留哪些块 | 保留 §10.2 的"类型四档／标题规则／置顶与归档规则"三块（**比我最初的任务书更贴原设计**） | §10 第 844 行明文：这三块"描述的是记忆本身，与工具可见性无关" |
| 6 | 排序链兜底键 | 末尾追加 `fileDate`、`order` 兜底键（仅在编号等全键相等时生效）；**唯一实现是 `index-md.compareInjectionOrder(a,b,usePinned)`，`snapshot.js` 必须复用它（已改为委托）** | §9.4 + §2.3（两处顺序必须逐字一致，否则 §14.49 与 §14.35 打架） |
| 7 | 日志段进注入吗、进什么 | 进，但**只进标题**：`[J-20260920-1752] 标题`（无类型标签、无 `★`）；`内容／结果／决策／证据／后续` 一个字符都不进 | §9.2、§14.73、§14.78 |
| 8 | 日志段的排序与让步顺序 | 排序**最新优先**（日期降序 → 同日 `order` 降序 → 编号降序 → 标题升序兜底，保证任何入参顺序都可复现）；**让步顺序 置顶（不可省）→ 索引 → 日志**，预算不够先削日志段尾部 | §9.4 第 3、4 步、§14.74、§14.77 |
| 9 | 日志省略怎么报 | 说明行 (c) 句 `另有 X 条日志标题未注入。`，`X` = 可注入总数 − 实际渲染数；**不并进 (a) 的 `N`**；`maxJournalItems = 0` 时既不渲染段也不写 (c) 句 | §9.4 第 5 步、§14.75、§14.76、§14.78 |
| 10 | 日志标题有无长度上限 | **没有**（有意：不再造第二套长度体系）；每条整条包含或整条省略；`id`／`title` 为空的坏记录既不进注入、也不算"未注入"（由 parse 的 warn 暴露） | §9.4、§14.73 |

**附加导出登记（实现已就绪、契约此前漏写，现补记）**：

| 模块 | 附加导出 | 用途 |
|---|---|---|
| `config.js` | `PLUGIN_NAME`、`PROMPT_NAME`、`PROMPT_ORDER`、`SNAPSHOT_TAGS`、`isSafeDirName` | 装配层与 prompts 的单一口径来源（`SNAPSHOT_TAGS` 以 config.js 为准，prompts.js 只转出） |
| `identity.js` | `isSubagent`、`isExplicitTopLevel`、`createAllowlist`、`describeIdentity` | 子代理判定与主会话白名单（§7.0/§17.5；正向特征，不看字段缺失） |
| `index.js` | `name`、`inject`、`WRITE_TOOL_NAMES`、`SEARCH_TOOL_NAME`、`workspaceOf`、`memoryFileName`、`memoryFilePath` | 装配层导出（测试与工具共用文件名口径） |
| `index-md.js` | `isOverlength(entry, config)`、`compareInjectionOrder(a,b,usePinned)` | §5.6 超限判定与 §9.4 排序链的单一口径 |
| `state.js` | `STATE_DIR`、`IDS_FILE`、`USAGE_FILE` | 路径常量 |
| `ids.js` | `repairDuplicates` 除 `entries/warnings` 外还返回 `reassigned`（重发映射） | 供 store 生成 `duplicate-id-repaired` 告警明细 |
| `lock.js` | `acquireLock` 返回值含 `reason:'locked'|'io_error'`，且中止信号归 `io_error` | 中文语义见其 JSDoc |
| `store.js` | `recordUsage`、`syncAtBoundary`、`rebuildIndex`、`isOverlength` 复用 | §3.9 已登记 |
| `intent.js` | `op` 取值实际含 `'reindex'`（契约注释写的是三值） | 语义等价，以下一行描述为准 |

### 3.14 `src/index.js`（Lead）

```js
export const name = 'memory';
export const inject = ['systemPrompt', 'tools'];
export function apply(ctx, config) { /* 见设计 §9.1 边界映射 + §7.0 restrict + §17 提醒 */ }
```

## 4. Warning 码表（io-state / tools-layer / Lead 共用）

| code | 含义 | 出现位置 |
|---|---|---|
| `parse-damaged` | 单条/单文件解析降级，原文保留 | parse |
| `entry-blank-line` | 条目内含空行（内容不丢，只告警） | parse |
| `field-no-indent` | 顶格字段行（缺少缩进） | parse |
| `free-field` | 顶格且既非字段也非列表项 → 原文保留为备注 | parse |
| `entry-before-section` | 条目出现在任何 H2 之前 | parse |
| `unknown-section` | H2 分节名不在四类里，其下条目按「事实」处理 | parse |
| `empty-title` | 标题为空 | parse |
| `bad-value` | 字段值非法（状态/优先级/置信度/归档前状态），已回退默认 | parse |
| `duplicate-field` | 同一已知字段出现多次，后一次胜出 | parse |
| `empty-file` | 文件有内容但解析不出任何条目 | parse |
| `journal-heading-invalid` / `journal-id-invalid` / `journal-no-content` | 日志分节标题／编号／内容不合规 | parse |
| `duplicate-journal-id` | 日志编号在同一文件内重复，写入方必须重发（§5.4） | parse/store |
| `missing-id-assigned` | 无编号条目被补发编号并写回 | store/ids |
| `duplicate-id-repaired` | 重复编号被自动修复 | ids |
| `watermark-rebuilt` | 水位线重建（含双丢失降级复用） | ids |
| `overlength-title` / `overlength-detail` / `overlength-item` | 超出 §5.6 上限 | parse/store |
| `manual-edit-detected` | 扫描发现被通用工具改过的痕迹 | store |
| `write-conflict` | 写前指纹不一致（调用方重读重试，最多两次） | memory-files/store |
| `locked` | 拿不到跨进程锁（超时） | lock/store |
| `intent-recovered` | 上次写入残留 intent，已前滚/回滚 | intent |
| `stale-lock-taken` | 接管了陈旧锁 | lock |
| `usage-reset` | usage 损坏，已清空 | state |
| `index-rebuilt` | `INDEX.md` 损坏或落后，已重建 | store |
| `pinned-out-of-injection` | 条目带 `置顶：true` 但不参与注入（candidate/superseded/派生 expired/已归档）——只作提示，**不是错误** | store/tools |
| `stale-tmp-swept` | 收敛/边界时清掉了无 intent 引用的陈旧 `.tmp`（批次5 收） | intent/store |

## 5. 交付节奏（Lead 编排）

- **批次 1（进行中）**：工程骨架 + 契约冻结 + `config.js`/`parse.js`（Lead）∥ `delivery.js`/`reminder-text.js`（remind）。
- **批次 2**：`memory-files.js`/`lock.js`/`intent.js`/`ids.js`/`state.js`/`index-md.js`/`store.js`（io-state）。
- **批次 3**：`snapshot.js`/`prompts.js`（inject-prompts）∥ `dedup.js`/`sensitive.js`/`errors.js`/`tools/*`（tools-layer）。
- **批次 4**：`index.js` 装配 + 冒烟（Lead）+ 只读复核（verifier）。
- 每批结束：`pnpm test` + `pnpm typecheck` 全绿，Lead 汇报一次；下一批才开工。

## 6. 记忆面板与 `/memory` 命令（本次新增对外面，Lead 授权落笔）

> 行为依据：[docs/memory-tools-design-r1.4.md](docs/memory-tools-design-r1.4.md) §18。宿主依据：本机 dsh `0.1.7-rc.2`
> 的检出源码（路径见手册附录 B）。本章只登记**对外面**，不重复 §18 的设计叙述。

### 6.1 清单侧声明（`package.json`，由工程文件负责人落笔）

| 声明 | 要求 | 缺了会怎样／依据 |
|---|---|---|
| `exports["./client"]` | 字符串，或含字符串 `default` 的对象；指向 client 半边产物 | 声明了 `dsh.client` 却没有它会**直接加载失败**：`dsh-client-modules/lib/index.js:718-719` 抛 `declares dsh.client but exports no "./client" bundle`；解析逻辑在 `:170-180`（`clientExportOf`） |
| `dsh.client` | `{ platform: 'web' }`；可选 `inject: string[]`、`external: string[]`、`immediately: boolean` | 形状定义 `dsh-package-manifest/lib/types/types.d.ts:75-89`（`DshClientManifest`）；运行时校验 `dsh-client-modules/lib/index.js:59-68`（`parseDshClient`，`platform` 必须是字符串） |
| `dsh.bundle.patch` | 保持 `./cordis.patch.yml` | `dsh-package-manifest/lib/types/types.d.ts:65-69` |

**当前状态（实读 `package.json`）**：三项**都已就位**——`exports["./client"] = "./client/memory-panel.js"`、
`files` 含 `"client"`、`dsh.client` 已声明；另外还多导出了一个 `"./package.json"`。

```jsonc
{
  "exports": {
    ".": "./src/index.js",
    "./client": "./client/memory-panel.js",
    "./package.json": "./package.json"
  },
  "files": ["src", "client", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      // ⚠️ 这里的 inject 是**信息性包名依赖清单**（`DshClientManifest.inject`），不是 Cordis 服务注入；
      // 服务注入看 §6.2 的 inject 数组。
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-session"
      ]
    }
  }
}
```

### 6.2 client 插件对象与服务注入

client 半边是一个 **classic script**：在浏览器里向 `window.__ModuleLoader__.load` 注册工厂，插件对象由工厂返回
`{ name, inject, apply }`。**`name` 是插件名、不是包名**——实现取 `dsh-memory-panel`，
而加载器 `id` 才是包名 `dsh-memory`（`client/memory-panel.js:2631-2648`）。

```js
module.exports = {
  name: 'dsh-memory-panel',
  inject: ['slots', 'remote', 'remote.workspaceFiles', 'sessions'],
  apply(ctx) { /* 注册 conversation.view 槽位 */ },
};
```

| 服务 | 用途 |
|---|---|
| `slots` | 注册 `conversation.view` 标签页（§6.3） |
| `remote` / `remote.workspaceFiles` | 宿主只读文件面（§6.4） |
| `sessions` | **写路径**：`sessions.using(sessionId, { source: 'memoryPanel' }, (ref) => ref.binding.session.command(line))`——面板靠它把一行 `/memory …` 交给宿主命令层（§6.5） |

- **没有 `locale`**：面板文案是中文硬编码，不注册词典、也不 `bind` 词典（设计 §18.8 第 7 条）。
- `remote.workspaceFiles` 是**子路径服务**，必须按点号原样写进 `inject`（写成 `'workspaceFiles'` 不会注入）。
  官方同款注入清单范例：`dsh-client-ui-sidebar-files/lib/client.js:933-940`
  （`'slots','locale','remote','remote.workspaceFiles',…`——它用 locale，本插件不用）。
- `source: 'memoryPanel'` 是本插件**自有**的来源字符串；来源映射 `SessionReferenceSourceMap` 定义在
  `@deepseek-ai/dsh-api-session-controller/client`（`lib/types/client/index.d.ts:17-25`，注释写着"extend this map
  through the package's canonical /client entry"），插件按自己的名字新增一项即可
  （范例：`dsh-client-ui-commands/lib/types/client/service.d.ts:23-28`），不需要改宿主。

### 6.3 槽位注册（`conversation.view`）

```js
ctx.effect(() => ctx.slots.inject("conversation.view", () => ctx.slots.register({
  name: "conversation.view",
  id: "memory",
  order: 20,
  label: () => '记忆',
}, MemoryPanel)), 'dsh-memory: 记忆视图');
```

| 项 | 值 | 依据 |
|---|---|---|
| 槽名 | `conversation.view`（list 槽、session 作用域） | `dsh-client-ui-trajectory/lib/client.js:8736-8745`（含 `children` 的 `scope: "session"`） |
| `id` | `memory` | 本设计 |
| `order` | `20`（既有：`chat = 0`、`trajectory = 10`） | `dsh-client-ui-chat/lib/client.js:12303-12307`；`dsh-client-ui-trajectory/lib/client.js:8736-8741` |
| `label` | `() => '记忆'`（**中文硬编码，不接 `ctx.locale`**） | 实现 `client/memory-panel.js:2609-2611`；对照 `dsh-client-ui-trajectory/lib/client.js:8741` 的 `t("view.trajectory")` |

注册必须包在 `ctx.effect(...)` 里（实测实现即 `ctx.effect(() => ctx.slots.inject(...), 'dsh-memory: 记忆视图（含面板样式）')`，
`client/memory-panel.js:2591-2628`），以便插件卸载 / 热重载时撤掉标签页；**样式注入与槽位注册合并在同一个 effect 里**
（为了不改变 `ctx.effect` 的调用次数——那是 `test/panel-loader.test.js` 的契约，见设计 §18.2.5）
（依据：`dsh-client-ui-trajectory/lib/client.js:8700-8705` 的注释）。

### 6.4 面板的只读数据面（`remote.workspaceFiles`）

| 调用 | 返回（成功时 `value` 的形状） | 关键约束 |
|---|---|---|
| `ctx.remote.workspaceFiles.list(sessionId, "memory", signal)` | `{ path, entries: [{name, type, size?}], truncated }` | `type ∈ file\|directory\|other`，符号链接报目标类型；`list` 只接受**目录**，否则 `workspace-file/not-directory` |
| `ctx.remote.workspaceFiles.read(sessionId, "memory/<文件名>", { offset }, signal)` | `{ absolutePath, version, bytes?, offset, text, lines, eof }` | 行号 **1-based**，`offset` 缺省 1；**客户端不发 `limit`**——页长由宿主 `maxLines` 决定，而 `limit > maxLines` 直接抛 `gateway/bad-request`（把页长写死 = 面板整体变成"读取失败"） |

- 路径是**工作区相对路径**，宿主按 `workspaceRoot` 解析：`inspect()` 用 `lstat(path, { cwd: workspaceRoot })`、
  `confine()` 用 `resolve(path, { cwd: workspaceRoot })` + `contains`（`dsh-api-workspace-files/lib/index.js:562-582`）；
  `workspaceRoot = header.cwd ?? sandboxPolicy.workspaceRoot`（同文件 `:404-414`）。
- 类型与错误码：`dsh-api-workspace-files/lib/types/types.d.ts:31-111`（页/清单形状）、`:139-172`（`RemoteErrorDetailsMap`）。
- **客户端拿到的是结果信封**：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`；
  实现按 `result.ok` 判定，并把 `error.code` 包成带 `code` 的 `Error` 上抛
  （`client/memory-panel.js:764-807`）。面板只把 `workspace-file/not-found` 当空态，其余一律错误态（设计 §18.5）。
- **翻页保险丝** `MAX_READ_PAGES = 200` 页、**每类文件上限** `MAX_FILES = 200`（`client/memory-panel.js:91-103`）；
  所有截断（`list.truncated` 两处、三类文件数上限、超页数）都在面板通知区显示，**不静默**（设计 §18.5）。

### 6.5 宿主命令 `/memory`

| 项 | 规定 |
|---|---|
| 语法 | `/memory archive <#NNNN> [原因...]`、`/memory restore <#NNNN>` |
| 发起方 | **面板按钮**（`buildActionLine` → `sessions.using(..., session.command(line))`，`client/memory-panel.js:735-745`/`:1492-1500`）；模型也可以直接在对话里发同样的命令 |
| 注册 | `ctx.effect(() => injectFn.call(ctx, ['commands'], (childCtx) => { …; childCtx.effect(() => childCtx.commands.register(createMemoryCommand(deps)), …) }).dispose, 'dsh-memory: /memory 命令')`；`injectFn = ctx.inject` **必须 `.call(ctx, …)`**（`inject` 是 Context 的方法，解引用会丢 `this`） |
| 硬依赖 | **无**：`export const inject` 仍是 `['systemPrompt','tools']`；宿主无 `commands` 时回调不执行（旧宿主线自动降级） |
| 参数解析 | `parseMemoryCommand(rawInput)`：不合规 `kind:'usage'`，编号缺失 `kind:'invalid'` |
| 会话闸门 | handler 先过 **`checkCall`**（与工具路径同口径：子代理 / 未登记会话一律拒绝，设计 §7.0） |
| 实现 | `handler` → `runArchiveAction`（与 `memory_archive` 工具**共用同一实现**，禁止复制第二份）→ `store.applyBatch`（`src/tools/archive.js:273-280`） |
| 返回值 | `{ kind: 'success', text }` / `{ kind: 'error', text }`（handler 内部 try/catch，绝不外抛） |
| 面板提示口径 | 命令返回值只表示**被受理**（准入），handler 的成败作为**对话流节点**呈现、**不回传面板**；按钮提示固定为"已提交归档 #0012；结果见对话流"（`client/memory-panel.js:1804-1812`）——面板不声称落盘成败 |

依据：实现 `src/index.js:169-186`、`src/tools/archive.js:79`（`runArchiveAction`）`:231-245`（`parseMemoryCommand`）
`:251`/`:261-284`（`createMemoryCommand`）；官方 `.dispose` 撤销器写法 `dsh-agent-loop/lib/index.js:1570-1579`；
`inject` 签名 `@deepseek-ai/cordis/lib/types/registry.d.ts:185`（`plugin(` 见 `:198`）、延迟注入另一范例
`dsh-api-gateway/lib/index.js:623,626`；命令服务定义 `dsh-commands/lib/types/index.d.ts:38-55`（`CommandDefinition`：`name` 不带斜杠、`description` 必填、
`handler(invocation) => CommandResult | Promise<CommandResult>`）、`:94`（`register(definition)` 返回撤销函数）、
`lib/types/types.d.ts:34-39`（`CommandResult` 两个 `kind`）。

### 6.6 面板不变量（实现时不许破）

1. **面板自身不写文件**：不调用 `store`、不 `fs` 写、不建目录；改数据的**唯一**出口是发一条 `/memory` 宿主命令（§6.5），
   只读部分只走 §6.4 的两个远端方法；
2. **不解析 `INDEX.md` 语义**：不读 `next-id`、不判一致性、不触发重建（那是 `store.js` 的事，§3.9）；
   实现连 `INDEX.md` 的**内容都不读**；
3. **失败只渲染，不做逐文件容错**：只有 `workspace-file/not-found` 是空态，其余错误整块进错误态；
   解析告警去重后汇总成通知区提示；**所有截断也在通知区显示**（`list.truncated`、每类文件数 200、翻页 200 页），不静默（设计 §18.5）；
4. **行身份唯一且同源**：记忆行 key、手风琴展开态、行高亮三处必须同用
   `rowKey = filePath + '#' + order`（`client/memory-panel.js:682-684` / `:2208` / `:2196-2216`），
   且 `filePath` 是**工作区相对路径**（`:855-859`）——不得改回按 `id` 匹配（`id` 可为 `null`、同 id 可跨文件重复，
   会出"点第二行、详情显示第一行、归档的是第一行"）；日志事件（`:2294`）与图谱节点（`:1377`）同理；
   **且动作必须用当轮固定参数绑定**：展开区的 `onAct`/`onAsk` 要么走 `rowKey`，要么由渲染时的立即执行闭包钉住 `entry`
   （`:2192-2247`）——**禁止**直接捕获 `for (var i …)` 的循环变量（实测会"展开 #0001 却归档 #0004"，属同一错目标缺陷）；
   归档分组是 `archive/` 文件与活动文件里 `archived` 条目的并集（`groupByKind` `:1296-1300`）；
5. **不声称落盘成败**：按钮提示只说"已提交…；结果见对话流"（准入语义，§6.5）；
6. **不用面板改正文**：`detail` 含空行 / 项目符号的拒绝规则住在工具层（设计 §5.5 第 5 条），
   面板给只读正文，改正文回对话里用 `memory_edit`（面板唯一的输入框是「归档原因」；
   「在对话中修改」按钮**只把建议指令显示在提示条**，不自动发消息，见 §6.7）；
7. **写逻辑只有一份**：命令层必须复用 `runArchiveAction`，不得再写一套文件操作；
8. **不新增配置键**：面板唯一的隐性前提是目录名必须叫 `memory`（设计 §18.8 第 1 条）。

### 6.7 client 半边的纯函数与样式产物（本次新增，登记用）

面板 UI 是手写 classic script，**没有打包器也没有真渲染单测**，所以"可测的部分"必须显式登记在
`PURE_EXPORTS`（`client/memory-panel.js:2549-2582`）里；实现与文档的名字以这里为准：

| 导出 | 作用 |
|---|---|
| `CSS` / `ICON` / `installStyle` | 样式表文本 / 类型图标表 / 把 `<style>`（带 `data-dsh-memory="panel"`）插进 head 并返回卸载函数（`:926-1073` / `:1097` / `:1080-1089`） |
| `formatNumber` | 千位分隔（`9 000` 口径，不依赖 `Intl`）（`:1175-1179`） |
| `idxCost` / `pinnedCost` / `logCost` | 单条索引行 / 置顶行 / 日志标题行的注入字数估算（`:1186-1190` / `:1197-1201` / `:1208-1212`） |
| `injectionStats` | 三段预算（置顶/索引/日志）+ 合计 + 分母；**置顶不重复计入索引段**（`:1227-1261`） |
| `groupByKind` | 记忆页分组：约定/事实/流程/经验 + 归档殿后（`:1284-1302`） |
| `buildGraph` / `copyPositions` | 图谱确定性布局 / 用上一次坐标覆盖拖动结果（`:1347-1444` / `:1452`） |
| `SNAPSHOT_BUDGET` / `GRAPH_WIDTH` / `GRAPH_HEIGHT` | 预算分母（**硬编码 9000**，设计 §18.8 第 8 条）/ 画布尺寸（`:1172` / `:1307-1308`） |
| `GRAPH_LABEL`（**未导出**，模块内部） | 图谱簇标题文案表 `约定/事实/流程/经验/归档/日志`（`:1329`；UI 用在簇标签 `:2344`） |
| `rowKey` / `buildActionLine` / `parseMemoryFile` / `parseJournalFile` / `groupByStatus` / `sortForDisplay` / … | 原有纯函数（§6.4/§6.5/设计 §18.6 已登记） |

> ⚠️ **两处命名以实现为准**：单条成本函数实际叫 `idxCost` / `pinnedCost` / `logCost`
> （不是 `entryCost` / `journalCost`）；图谱的 `graphKindOf`（`:1324-1328`）、半径函数 `graphRadius`（`:1331-1333`）
> 与上文 `GRAPH_LABEL` 都是**模块内部**成员，**没有**进 `PURE_EXPORTS`——要测就得先让它们出口。
