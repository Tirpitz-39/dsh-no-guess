# dsh-no-guess · 不猜

> 不明白就先问。用户那句话说不清楚时，模型不许猜着做。

[English](README.en.md) | **中文**

[![test](https://github.com/Tirpitz-39/dsh-no-guess/actions/workflows/test.yml/badge.svg)](https://github.com/Tirpitz-39/dsh-no-guess/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-no-guess?style=flat-square)](https://www.npmjs.com/package/dsh-no-guess)
[![npm downloads](https://img.shields.io/npm/dm/dsh-no-guess?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-no-guess)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B67B4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg?style=flat-square)](package.json)
![platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-2ea44f?style=flat-square)
[![ask-first](https://img.shields.io/badge/ask--first-no--guess-orange?style=flat-square)](#)

## 它做什么

主触发是**思考链**：每次模型准备调工具时，扫它最近几条思考（reasoning）——一旦出现「我猜用户 / 不确定用户 / 不知道用户要」这类**指向用户意图的猜测**，就视为它自己在承认「在猜」，拦下要求先问。

被拦后：

1. 先用 `ask_user_question` 问清两层：**要干什么**（目标/交付物/范围）和**要怎么干**（方式/约束/验收标准），每条给 2-4 个具体选项；
2. 本轮问过之后**还接着调工具**，再拦一次——问完就停，不许「问一句然后自己猜着填完」；
3. 每轮最多拦 `maxBlocksPerTurn`（默认 2）次，拦满放行，宁少拦不卡死。

**字面规则是可选兜底**（`ruleGate`，默认关）：短消息 + 指代/疑问 + 无动作词也拦。开了误伤会多（「你确定吗」「重启了」这种都会被拦）。

读思考的细节：DSH 的 assistant 消息里 `reasoning` 块带完整思考文本（实测最长 4459 字），但**工具调用前的过渡消息 reasoning 会被清空**，所以要扫最近 5 条合并再匹配。

## 不拦的情况

- 回执：「继续」「好」「收到」「ok」「1」「2」……
- **疑问/确认句**：「你确定吗」「可以吗」「有问题吗」这类对对话本身的质疑/确认——那不是任务，不拦
- 子代理会话、定时任务、QQ/桥接等没人能回答的会话
- **机器轮次不武装**：`[SCHEDULE REMINDER]`、插件 followup 这类注入消息不算真人说话——本轮没有真人 `lastText` 时，思考检测也不触发（2026-11-16 实测修复：定时任务会话曾被误卡）
- `subagent` / `subagent_fork` / `workflow` 派活工具本身（子代理内部本来就不拦）
- 总开关关闭（设置页或输入框旁按钮）
- `ask_user_question` / `todo_write` / `claim_*` / `wrapup_check` 本身

## 配置项

设置页（设置 → 不猜）或 HTTP 接口 `POST /dsh-no-guess/config` 都可改；手改 `config.json` 也行，坏值会被夹回合法区间。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `thinkingGate` | `true` | 主触发：思考链里的「猜」信号 |
| `ruleGate` | `false` | 字面规则兜底，误伤较多 |
| `modelGate` | `false` | 模型判断（未完善，花钱） |
| `timeoutMinutes` | `10` | 被拦后多久没回复就按最小假设继续，1–120 |
| `maxBlocksPerTurn` | `2` | 每轮最多拦几次，1–10 |
| `vagueMaxLength` | `40` | 多短算「说不清」，10–200 |
| `logUserText` | `false` | 日志是否记录用户消息与思考片段；默认只记 sid / turn / 工具名 |
| `readPolicy` | `"tiered"` | 分级策略：`tiered` 按可逆性放行只读工具；`legacy` 回到 0.5.0 的「非白名单全拦」 |
| `tierOverrides` | `{}` | 全局工具→tier 覆盖表，如 `{ "plugin_manager": "read" }`；非法值丢弃 |

## 按可逆性分级放行（P1，默认开启）

武装状态下不是所有工具都拦——只拦不可逆动作。默认 `readPolicy: "tiered"`：

| 等级 | 工具（示例） | 武装时 |
|---|---|---|
| **read** | `read` / `glob` / `grep` / `read_image` / `web_search` / `web_fetch` / `session_search` / `session_trace` / `list_sessions` / `cordis_inspect_*` | **放行** |
| **write** | `edit` / `write` / `remember` / `create_goal` / `update_goal` | 拦 |
| **execute** | `pwsh` / `selftest` / `subagent` / `subagent_fork` / `workflow` / `job_kill` | 拦 |
| **external** | `send_message` / `send_to_session` / `schedule_create` / `schedule_edit` / `plugin_manager` / `remote_*` | 拦 |
| **allow** | `ask_user_question` / `todo_write` / `wrapup_check` / `claim_*` / `present` | 放行 |
| **unknown** | 表外工具（新插件、MCP 工具） | 拦，日志记 `tier: "unknown"` |

三条设计原则：

- **只读放行是有意的**：读文件、查会话、开摄像头看屏幕，正是消解歧义的手段。拦它们等于逼模型猜。
- **fail 语义分两种**：守卫崩溃 / 异常 → **fail-open**（不弄坏宿主）；判定不确定（表外工具）→ **fail-closed**（不赌）。两句分开成立。
- **读类证据留痕**：武装时 read 被放行会记 `read-pass`（tool/tier/signal/turn/policy），切到 tiered 后能用 `tools/analyze-log.mjs` 算出「旧策略会拦多少只读操作」。

**已知误拦**（多动作工具，名字级分级分不出动作）：`plugin_manager` 的 list、`claim_check` 的 `persist:false`、`clipboard` 的读——用 `tierOverrides` 自救，或 `readPolicy: "legacy"` 一键回退。

## 超时

被拦后用户 `timeoutMinutes`（默认 10）分钟没回，插件往会话里投递一条消息：按最小假设继续，并在回答开头写明假设。之后本轮不再拦。

## 模型判断（modelGate，未完善，默认关）

> **状态：未完善（beta）**。2026-11-16 实测：链路是通的（调模型 → 判 needClarify → 拦），但判断器只喂**单条消息**、看不到对话上下文，容易把「测一下吧」这种明确指令判成缺信息（实测复现）。思考链主触发已经够准，这个当备用；启用请接受它会偏严。

规则判不出「说不清」时，可以再让模型看一眼：开了之后，每条没被规则拦下的消息会额外调一次模型，判断需求是否「信息不足或自相矛盾」——比如「在酒吧点蛋炒饭」「不放油不开火做蛋炒饭」。

- 默认**关**，关着就完全不花 token
- 每次判断花少量 token（约几百）
- 模型不可用 / 超时 30 秒 / 输出解析失败 → 一律放行（fail-open）
- 已知未完善：只看单条消息，没有对话上下文；后续可以考虑把最近 2-3 轮一起喂进去

## 思考里的「猜」信号

模型的思考/正文里出现这些**承认自己在猜**的短语时，直接拦下要求先问——不管用户那句话字面上清不清楚：

- 中文：「我猜用户 / 不确定用户 / 不知道用户要 / 用户可能是想 / 用户要的应该是」
- 英文：「I guess the user / not sure what the user / I think the user / the user probably wants / I guess that / not sure what you mean」

匹配大小写不敏感、匹配前去掉空白（思考里换行拆词也能抓到）。英文对话靠这些信号触发；正常推理（没写猜测词）不拦。

**只扫本轮**：思考链只取当前 `turn` 的 assistant 消息（并止于最近的 `user/message`）——上一轮已经回答过的「我猜用户」不会武装下一轮。

**意图词后缀**：`不确定用户` / `不清楚用户` 后面必须跟 想 / 要 / 需要 / 偏好 / 指 / 是，单说「不确定用户配置」不算在猜。

**自讨论豁免**：用户消息里出现插件名（`dsh-no-guess` / `ask-first` / 不猜插件 / 插件本身）的轮次不武装——讨论插件本身时思考里全是这些信号词，会自己拦自己。只认用户消息，思考里的引用不算。

> 实测（2026-11-16，晚）：这台机器上 `deepseek-flash` 的 assistant 消息 **reasoning 块有完整内容**（421/421 条），所以思考链能直接扫到。早前「flash 思考块为空」的观察已不适用。

## 数据

都在 `DSH_HOME` 下的 `no-guess/`：宿主设置了 `DSH_HOME` 就用它，否则用 `~/.dsh/no-guess/`（与 DSH 官方的目录解析一致，Windows / macOS / Linux 通用）。改名前的 `ask-first/` 会在首次读取时自动迁移过来（旧目录保留不删），已有配置不丢。

| 文件 | 内容 |
|---|---|
| `config.json` | 上面的配置项；写入是原子的（临时文件 + rename） |
| `sessions.json` | 每会话的临时覆盖（预留） |
| `no-guess.log` | 每次拦截/提问/超时的 JSONL 记录，超过 2 MiB 自动轮转保留尾部一半（可用 `DSH_NO_GUESS_LOG_MAX_BYTES` 调整上限）；默认不写对话内容，`logUserText: true` 才记片段 |

## 安装

要求：DSH（带 `tools` 和 `webServer` 服务）、Node.js ≥ 18。

```bash
git clone https://github.com/Tirpitz-39/dsh-no-guess
dsh plugin add file:./dsh-no-guess
```

本地开发时也可以直接指向自己的目录（`dsh plugin add file:<插件目录>`）。

装完**重启 DSH**。设置 → 不猜，或输入框旁的「不猜」按钮。

## 测试

```bash
npm test                 # 五组一起跑
node test/smoke.mjs      # 49 项：规则判定 / 拦截 / 放行 / 回执 / 子代理 / 机器轮次 / 跨轮 / 思考链 / 意图词 / 自讨论 / 隐私 / 重建
node test/edge-cases.mjs # 20 条边界样本矩阵
node test/attack.mjs     # 15 条对抗样本（伪造前缀、拆词、硬抗次数、借道子代理…）
node test/config.mjs     # 29 项：配置默认值/夹紧、原子写、日志轮转、跨平台数据目录、连续写读、迁移、sessions 原子写
node test/replay.mjs     # 真实会话回放：统计思考链武装率（fixture 25%，红线 50%）
```

测试不需要 DSH 运行时：假 `ctx` / 假 `agent`，`DSH_HOME` 指向临时目录。CI 在 ubuntu 和 windows 上跑 Node 18/20/22。

对抗测试目前 **漏洞 0 / 15**：伪造 `[SCHEDULE REMINDER]` 前缀、思考换行拆词两个漏洞已修；伪造 `source` 属宿主生成、用户不可构造，标为低风险；「思考不暴露猜测就抓不到」是方案固有局限。

`test/fixtures/session-real-1.jsonl` 是脱敏后的真实会话（只保留信号片段，用户消息全部 `[redacted]`），回放脚本用它当回归基线：武装率超过 50% 就红。

## 已知局限

- 思考里不暴露猜测就抓不到（方案固有）
- `modelGate` 只看单条消息，会偏严
- 借道 `subagent` / `workflow` 时子代理内部不拦（设计如此：子代理内部本来就不该问人）

## License

MIT
