# dsh-memory

给 DSH（DeepSeek Harness）用的**项目记忆插件**：长期记忆 + 项目日志两套 Markdown 真相源，
会话边界只注入标题快照，任务交付完成后提醒沉淀结论。
按 [docs/memory-tools-design-r1.4.md](docs/memory-tools-design-r1.4.md) 重写，模块契约见 [INTERFACES.md](INTERFACES.md)。

## 它做什么

| 时机 | 行为 |
|---|---|
| 新会话 / 会话恢复 / 清空重开 | 扫描 `<项目根>/memory/`，校正编号、重建 `INDEX.md`，注入一份标题快照（长期记忆 + 项目日志标题） |
| 会话进行中 | 不重新注入；要看新值用 `memory_search` |
| 任务交付完成 | 提醒一次：可复用结论用 `memory_write`，过程与证据用 `memory_log` |
| 子代理 | 只读隔离：只见 `memory_search`，没有写入类工具、不注入、不提醒 |

工具共五个：`memory_write` / `memory_edit` / `memory_archive` / `memory_log`（仅主 agent）、
`memory_search`（主 agent 与子代理）。

## 记忆面板

会话区顶部除了「对话」「轨迹」，还有一个**「记忆」标签页**，把 `<项目根>/memory/` 下的 Markdown 真相源渲染出来。
面板按**当前会话的工作区根**定位，跟着会话走，不需要额外配置。三个视图：

| 视图 | 内容 |
|---|---|
| 记忆 | 按类型分组（约定 / 事实 / 流程 / 经验 + 归档），点条所在行内展开看字段与「详细」正文，可就地归档 / 恢复 |
| 日志 | 按日期倒序的时间线，展开一条逐行显示它的全部字段 |
| 图谱 | 节点 = 记忆（另可勾选日志节点成簇），连线 = 关联 / 取代 / 关联日志，节点可拖拽、点开在图下方看详情 |

顶栏一行统计 `N 条 · 注入 X / Y 字`（有条目归档时再跟 `· 归档 M`）与三段预算条，右上角「刷新」——
面板**不实时刷新**，会话内新写的记忆要刷新或重进视图才可见。面板自己**不写文件**：归档 / 恢复是把
`/memory archive #0012 原因`（或 `/memory restore #0012`）交给宿主的 `/memory` 命令执行，落盘走插件既有的写入事务，**不经模型**。

## 记忆开关

输入区工具行左侧有一个**「记忆」chip**（新建对话与普通会话都渲染），控制**本会话**要不要用记忆能力：

| 动作 | 行为 |
|---|---|
| 默认 | **开启**（宿主口径"缺席 = 开"，不跨重启保留：重启 DSH 后回到开启） |
| 点击 chip | 切换本会话开关，即下发 `/memory off` / `/memory on` |
| 悬停 / 键盘聚焦 | **只显示说明，不发任何命令**（早先版本会在悬停时探一次状态，会在对话流留下可见节点） |
| 关闭后 | 不注入记忆快照；五个 `memory_*` 工具从本会话可见面消失；**记忆文件一个字都没动**，其他工具不受影响 |

也可以直接在输入框手打 `/memory off`、`/memory on`、`/memory status`——chip 会跟着变。

chip 的状态靠两条零额外命令的通路保持诚实：默认值直接取宿主口径（缺席 = 开），
加上订阅 `command/executed`（**手打命令**那条路会发这个事件，chip 自己的点击不发）。

已知的不一致窗口有两个：**多标签页**（`command/executed` 是本地提交确认，A 页手打 `/memory on` 时 B 页 chip 不会跟着变）
与**刷新页面**（客户端缓存丢失）。两者都能靠"点一下"收敛——命令在宿主侧幂等受理，chip 随后落到正确状态。

## 目录结构

**数据**（写在每个项目的根目录下；项目根 = 会话的工作区根）

```text
<项目根>/memory/
├── M-YYYY-MM-DD.md          # 长期记忆：约定 / 事实 / 流程 / 经验
├── JOURNAL-YYYY-MM-DD.md    # 项目日志：过程、尝试、结果、证据
├── INDEX.md                 # 人类视图：全部非归档条目的标题 + 编号水位线注记
├── archive/                 # 已归档长期记忆
└── .state/                  # 可重建机器状态：ids / usage.json / lock / intent.json
```

**源码**

```text
src/                宿主半边：装配、配置、解析、写事务、快照、五个工具（index.js 是装配入口）
client/             记忆面板的 Web client 半边（手写 classic script）
test/               node --test 测试（纯逻辑 + 装配层）
docs/               设计文档、验收口径、开发手册、面板原型
types/              dsh.d.ts 类型声明
cordis.patch.yml    插件 patch：注册 id: memory 与配置默认值
INTERFACES.md       模块契约（唯一来源）
```

## 安装

```sh
git clone https://github.com/hisence999/dsh-memory.git    # 克隆到本地，记下目录路径 <本仓库>

# 不改 profile 的 overlay 试跑（推荐先这么做）
dsh web --patch <本仓库>/cordis.patch.yml

# 正式装进某个 profile
dsh plugin --profile <你的 profile> add <本仓库>
```

`<本仓库>` 指上一步克隆出来的本地目录路径；命令不依赖固定盘符，Windows 用 `\`、macOS / Linux 用 `/` 分隔即可。

生效规则：

| 改动 | 是否重启 profile | 原因 |
|---|---|---|
| 只改 patch 配置（`cordis.patch.yml` 的 `config:`） | 不用（`patchReload: live` 热更） | 配置在每次组装时读取 |
| 改插件源码（`src/*.js`、`client/*.js`，含 `link:` 安装的情形） | 必须重启 | 宿主半边在启动时加载一次，client 半边按 `dsh.client` 在启动时扫描进 boot 清单 |
| 增删 bundle 成员（`dsh plugin add/remove`） | 必须重启 | 成员集合只在启动时解析 |

"源码已改" ≠ "真机已生效"：验证新增守卫前，先确认实例是新 build（最安全的判据是看新会话注入文本里有没有你的改动），
不要用"写一条坏数据试守卫"去探。详见 [dsh-plugin-dev-handbook.md](docs/dsh-plugin-dev-handbook.md) §9.11。

开发与验证：

```sh
pnpm test        # node --test，纯逻辑 + 装配层双层测试
pnpm typecheck   # tsc --checkJs --strict（零运行时依赖，源码即产物）
```

## 致谢

感谢 [linux.do](https://linux.do/) 社区。
