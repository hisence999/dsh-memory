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
# 不改 profile 的 overlay 试跑（推荐先这么做）
dsh web --patch D:\dsh-memory-v2\cordis.patch.yml

# 正式装进某个 profile
dsh plugin --profile <你的 profile> add D:\dsh-memory-v2
```

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
