# dsh-no-guess 技术路线

> 配套 [ROADMAP.md](ROADMAP.md)：那份管「做什么、什么时候」，这份管「怎么实现、接口长什么样」。
> 粒度：模块与接口级——模块划分、数据契约、关键技术选型、验收方式；不展开到函数行号。
> 基线：0.4.5 · 2026-11-16

## 0. 范围

- **覆盖**：阶段一至阶段三的技术方案、测试策略、风险。
- **不覆盖**：产品决策与发版节奏（见 ROADMAP.md）。
- **前提**：所有改动保持「零模型调用、fail-open、隐私默认关」三条原则，破坏其中一条的方案不采纳。

## 1. 架构现状

### 1.1 模块边界

| 模块 | 载体 | 职责 | 对外接口 |
|---|---|---|---|
| Host 半 | `index.js`（ESM，`inject(['tools'])`） | 拦截判定、状态机、日志、HTTP | DSH 事件钩子 + `/dsh-no-guess/*` |
| Client 半 | `client.js`（`window.__ModuleLoader__.load`） | 输入框旁开关 + 设置页 | HTTP `/dsh-no-guess/config` |
| 测试 | `test/*.mjs` | 规则、状态机、配置、回放 | 直接 import 导出函数 |
| CI | `.github/workflows/test.yml` | 矩阵测试 | GitHub Actions |

Host 半内部再分五层：

```
data    —— 路径解析、config/sessions/log 读写、迁移、轮转、缓存
rules   —— 回执识别、猜意图短语、用户消息提取、字面规则、会话类型判断
state   —— 每会话状态机（武装 / 已问 / 拦次数 / 超时定时器）
guard   —— tools/pre-execute 拦截链路 + agent 生命周期挂载
http    —— 状态查询、配置读写、会话覆盖、日志读取（仅 loopback）
```

### 1.2 数据流（现有拦截链路）

```
真人 user 消息
  → pre-step：记录 lastText / lastTurn / lastUserAt，重置每轮状态
  → 工具调用 → pre-execute 守卫：
      字面规则武装 → 思考链武装 → 未武装放行
      武装后：超时宽限检查 → 已问检查（block-stop）→ 首次拦截（block-ask）
  → 用户回答 ask_user_question → 解除武装（answered）
  → 超时未答 → 注入 followup「按最小假设继续」
```

关键约束：只对真人会话生效；只扫本轮思考；机器轮次不武装；每轮拦截次数有上限。

### 1.3 数据契约

**config.json 字段**（缺省值 / 合法区间见 README）：`enabled`、`timeoutMinutes`、`maxBlocksPerTurn`、`vagueMaxLength`、`thinkingGate`、`ruleGate`、`modelGate`、`logUserText`。

**sessions.json**：`{ [sid]: { enabled?: boolean, updatedAt: number } }`，上限 500 条。

**日志事件**（JSONL，每行 `{t, event, ...data}`）：

| event | 语义 |
|---|---|
| `arm` / `guess-arm` / `rule-arm` / `model-arm` | 本轮武装及来源 |
| `block-ask` | 首次拦截（deny） |
| `block-stop` | 问完还动手，第二次拦截 |
| `asked` / `answered` | 提问与用户回答 |
| `timeout` / `timeout-release` | 超时投递与放行 |
| `model-judge` | 模型判断结果 |
| `config` / `session` | 配置变更 |

**HTTP 接口**（仅 loopback）：`GET /state`、`GET|POST /config`、`POST /session`、`GET /log`。

### 1.4 设计原则

1. **零模型调用**：判定全是规则；`modelGate` 是唯一可选的付费路径，默认关、失败放行。
2. **fail-open**：守卫任何异常都放行，坏的守卫也不能卡死宿主。
3. **隐私默认关**：日志默认不落用户文本与思考片段，`logUserText` 显式开启才记。
4. **只认真人**：子代理、定时任务、桥接会话一律不拦。
5. **只扫本轮**：思考链按 turn 过滤，向上轮污染免疫。

## 2. 技术缺口（驱动各阶段）

| # | 缺口 | 后果 | 阶段 |
|---|---|---|---|
| T1 | 日志缺「武装原因 / 词族 / 延迟」 | 误伤只能人眼看 | 一 |
| T2 | replay 只有 1 个 fixture、红线单值 | 词表改动无回归保护 | 一 |
| T3 | 无日志分析工具 | 数据不可量化 | 一 |
| T4 | 模型判断只看单条消息 | 已知误判 | 二 |
| T5 | 文案硬编码中文 | 英文用户不可用 | 三 |
| T6 | 原生端设置页未调研 | 手机端只能改配置文件 | 二 |
| T7 | 无 `engines.dsh` | 低版本安装可能静默坏 | 三 |
| T8 | 无发布检查清单 | 发版靠记忆 | 三 |

## 3. 阶段一技术方案

### 3.1 市场条目（T8 相关）

- 交付物：`data/plugins/Tirpitz-39__dsh-no-guess.yml` 一个文件；格式与 selftest 条目一致（`url` / `name` / `category` / `description.en|zh`）。
- 前置：核对分类合法值；遵守仓库满 24 小时的提交门槛。
- 验收：PR 的 CI 通过、条目在列表页可解析。

### 3.2 日志契约扩展（T1）

**只加字段，不改格式**，旧日志保持可读：

| 事件 | 新增字段 | 取值 | 隐私说明 |
|---|---|---|---|
| `guess-arm` | `family` | 词族 id（见 3.3） | 枚举，不含文本 |
| `block-ask` / `block-stop` | `signal`、`turn` | `thinking` / `rule` / `model` | 枚举 |
| `asked` / `answered` | `latencyMs`、`turn` | 毫秒 | 数字 |
| `timeout` | `turn` | 数字 | — |

- 兼容策略：分析工具按「字段缺失 = 未知」处理；
- 隐私策略：新增字段全部是枚举或数字，`logUserText` 的开关语义不变。

### 3.3 规则分类化（T1 的实现前提）

现状是一条合并大正则，命中后不知道命中哪一族，没法按族统计。方案：

- 把词表拆成**词族表**：每个词族一个 `id`（如 `zh-intent` / `en-intent` / `en-think`）+ 一条正则；
- 导出两个接口：
  - `matchGuessFamily(text) → { id, index } | null`：守卫与日志用它；
  - 合并正则 `GUESS_RE`：保留给 replay 与既有测试，保证行为一致；
- 匹配语义不变（去空白后、大小写不敏感、只扫本轮）；
- 验收：改前改后 replay 武装率一致；每个词族有正例与反例测试。

### 3.4 日志分析工具（T3）

新模块 `tools/analyze-log.mjs`，纯读日志、不碰运行时：

- 输入：`no-guess.log` 路径（默认数据目录）；
- 输出：人类可读摘要 + `--json`；
- 指标定义：
  - 武装数 = 各 arm 事件之和；拦截数 = `block-ask` + `block-stop`；
  - 回答率 = `answered / 拦截数`；超时率 = `timeout / 拦截数`；
  - 平均回答耗时 = `latencyMs` 均值；
  - 词族分布（T1 完成后）；
- 误伤候选只标记、不自动判定，交人工复核。

### 3.5 replay 技术（T2）

- **fixture 契约**：脱敏后的宿主会话快照（`turn/start` + `user/message` + `assistant/message` 的 reasoning 块），用户文本一律打码，sid 固定；
- **来源**：本机真实会话快照；手机端事件日志只用于统计，不当 replay 输入；
- **replay 命令行扩展**：`--json` 输出、支持多 fixture 汇总、红线从单值改为区间断言；
- 验收：≥2 个 fixture 通过 CI，区间断言生效。

## 4. 阶段二技术方案

### 4.1 误伤分析（依赖 T1）

- 输入：手机端日志（开 `logUserText`）+ 3.4 的统计；
- 分类口径：真命中 / 误伤 / 迟到 / 超时，人工复核样本；
- 产出：每种词族的误伤占比表，作为 4.2 的调参依据。

### 4.2 词表调参方法

- 按词族调，不整体一刀切；
- 流程：分析误伤分布 → 收窄/放宽指定词族 → replay 跑回归 → 确认区间（目标 10–20%）；
- 保护：区间有下限，防止「为少误伤把插件调废」；每族正反例测试随调随补。

### 4.3 模型判断接上下文（T4）

- 接口变更：判定输入从「单条用户消息」改为「最近 2–3 轮对话摘要 + 当前消息」；
- 约束：总输入长度设上限、超时与失败放行不变、默认仍关；
- 验收：mock 模型层断言收到上下文；开启后 replay 对比武装率变化。

### 4.4 原生设置页（T6）

先调研、后选型，三种退路按成本排序：

| 方案 | 做法 | 前提 |
|---|---|---|
| A. 客户端注入 | 复用 client.js 的 slot 机制 | 移动端 client plugin 支持 |
| B. HTTP 设置页 | 路由返回最小 HTML 页面（loopback 内可用） | 无 |
| C. 纯配置 | 只保留 JSON API，README 写清改法 | 无 |

- 决策依据：手机用户占比 + 调研结果；不做也要把原因写进 README。

## 5. 阶段三技术方案

### 5.1 双语文案（T5）

- 文案集中到 locale 表（中/英各一份），覆盖：被拦提示、二次拦截提示、超时消息、设置页与开关文案；
- 语言解析顺序：插件环境变量 → 系统 locale → 默认中文；
- 验收：两份 locale 键集合一致（缺键即红），中英各跑一次端到端断言。

### 5.2 engines.dsh（T7）

- `package.json` 声明最低 DSH 版本；
- 验证方式：打包产物字段正确、低版本安装给出明确报错。

### 5.3 发布检查清单（T8）

- 新增 `docs/RELEASE.md`：版本号、CHANGELOG、测试、打包内容核对、GitHub release、市场条目；
- 发布前逐项打勾。

## 6. 测试与 CI 策略

| 套件 | 职责 | 阶段一后 | 阶段二后 | 阶段三后 |
|---|---|---|---|---|
| smoke | 规则 / 状态机 / 钩子 | + 日志字段断言 | + 词族正反例 | + 双语断言 |
| edge | 边界样本矩阵 | — | + 调参样本 | — |
| attack | 对抗样本 | — | + 新绕过 | — |
| config | 配置 / 数据文件 | — | — | — |
| replay | 真实会话回放 | ≥2 fixture | 区间断言 | — |
| analyze-log | 日志统计 | 新增 | — | — |

- CI 矩阵加 Node 24（照 selftest 的做法）；
- 性能：守卫路径加计时断言，防止后续改动拖慢工具调用。

## 7. 风险与边界

| 风险 | 缓解 |
|---|---|
| 日志并发写 | 单宿主进程假设，按行 append；README 写明 |
| 非 flash 模型没有 reasoning 块 | fail-open，replay 会暴露覆盖率，README 已写局限 |
| 手机端日志量小 | 拉长观察期；样本不足时不下结论 |
| 词表收窄过度 | replay 区间下限保护 |
| 原生端能力未知 | 4.4 的 A/B/C 三退路 |

## 8. 阶段 Done 定义

- **阶段一**：市场 PR 绿；日志有词族/来源/延迟字段；分析工具能出数；replay ≥2 fixture 且 CI 通过。
- **阶段二**：误伤分析完成；词表按族调整且 replay 落在目标区间；模型判断接入上下文；原生设置页给结论。
- **阶段三**：双语文案齐全且测试验证；`engines.dsh` 生效；发布清单落文件；市场条目可搜。
- **阶段四**：ROADMAP.md 六条准入逐项验收通过。
