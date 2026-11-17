# Changelog

## 0.5.1

- **P1 按可逆性分级放行**（`readPolicy: "tiered"` 默认开启）：武装状态下只读工具（read / glob / grep / web_search / session_search / session_* / list_sessions / cordis_inspect_* 等）照常放行——它们正是消解歧义的手段；write（edit/write/remember/create_goal）与 execute（pwsh/selftest/subagent/workflow/job_kill）与 external（send_message/send_to_session/schedule_*/plugin_manager/remote_*）仍拦；表外工具 fail-closed 拦下，日志记 `tier: "unknown"` 而不是冒充 execute
- **tierOverrides**：全局 `{ 工具名: tier }` 覆盖表——多动作工具（`plugin_manager` 的 list、`clipboard` 的读）在名字级分级下会误拦，用它自救；非法 tier 值自动丢弃
- **read-pass 反事实事件**：武装时 read 被放行记 `read-pass`（tool/tier/signal/turn/policy），`block-ask` / `block-stop` 记 `tier` 与 `policy` 字段——切到 tiered 后能算出「旧策略会拦多少只读操作」
- **切换开关**：`readPolicy: "legacy"` 一把回到 0.5.0 行为；`GET /state` 的 config 里可见
- 启动自检：注册表探测，表外工具写一次 `unknown-tool` degraded
- **攻击演练 + 修复**（P1）：新增 `test/attack-p1.mjs`（20 样本，覆盖近义词绕过、自讨论豁免滥用、read 档副作用、未知工具、伪造机器轮次/reasoning、超长思考、maxBlocks 突破、伪造日志）。演练暴露并修复「自讨论豁免滥用」：裸插件名不再豁免，要求「插件名 + 插件/这个插件」结构，否则「帮我改 dsh-no-guess 配置」这类正常任务会被豁免放行。已知局限如实记录：近义词绕过（隐含意图/推测/估计）与混合消息豁免，留 P3
- 测试：tiers 30（新增）；smoke 57（subagent 改为 execute 档：武装时拦，未武装放行）；attack-p1 20（新增）

## 0.5.0

P0 工程债收口：让「静默失效」变成可见状态。

- **宿主契约测试**（M1）：`test/dsh-contract.mjs` + `fixtures/host-contract.json`，把插件依赖的 DSH 事件（`tools/pre-execute` / `agent/pre-step` / `agent/created` / `agent/disposed` / `tools/result`）与决策类型固化成快照（从真实宿主 Inspect Provider 导出）。宿主改名或改 payload 形状时测试直接红，而不是插件静默失效
- **启动自检**（M1）：启动时检查 `tools` 服务与三个 hook 是否被接受、`webServer` 注入结果；首次 `pre-step` / `pre-execute` 校验 payload 形状；reasoning 记 present/empty/absent 三态，连续 10 轮不可见记 `degraded`。`GET /state` 返回 `selfCheck` 字段，日志记 `degraded` 事件
- **生命周期修复**（M3）：agent 重建时释放上一实例的 hook disposer 与 root-context effect，不再每次重建累积一个死 effect；`states` 加 500 条上限（LRU 淘汰）；`agent/disposed` 时删除状态条目；`selfCheck.hooks.attached` 暴露当前挂载数
- 测试：contract 28、self-check 19、smoke 56、edge 20、attack 15、config 33、replay 1 fixture（25%）、analyze-log 21

## 0.4.7

- **热路径修复**：数据迁移检查（`migrateLegacyData`）原本在 `readConfig` 的缓存命中之前执行，每个工具调用都会多做几次 `existsSync`/`readdir`。现在只在配置缓存未命中时跑，1 秒内最多一次
- 行为无变化，仅减少守卫路径的系统调用

## 0.4.6

- **日志契约扩展**：`guess-arm` 记录 `family`（命中的词族），`block-ask` / `block-stop` 记录 `signal`（thinking/rule/model）与 `turn`，`asked` / `answered` 记录 `latencyMs` 与 `turn`。旧日志缺字段时分析工具按「未知」处理，不报假数字
- **词族分类**：`GUESS_RE` 拆成 `zh-intent` / `en-intent` / `en-think` 三个词族，新增 `matchGuessFamily()`；合并正则 `GUESS_RE` 保留，行为不变（replay 武装率仍是 25%）
- **日志分析工具** `tools/analyze-log.mjs`：统计武装 / 拦截 / 回答 / 超时，按词族与信号分组，平均回答耗时，<60s 快速回答候选；`answered` 只有在同会话同 turn 被拦过时才计入回答率，旧日志显示 n/a 而不是虚数
- **历史日志接管修复**：0.4.x 的数据迁移按原文件名复制，`ask-first.log` 搬进 `no-guess/` 后新代码从不读取。现在迁移时直接落成 `no-guess.log`；已经跑过旧迁移的机器补一次幂等 fixup（旧文件保留作 archive）
- 测试：smoke 56（+7 日志契约）、analyze-log 21（新增）、config 33（+4 迁移与 fixup）

## 0.4.5

按代码评审修四处：

- **会话重建后静默失效**：`attachAgent` 原来按 sid 去重，宿主重建同一会话的 agent 后，新实例不再挂 `agent/pre-step`（旧 hook 随旧 `agent.ctx` 销毁），gate 会静默停止。现在按实例去重，并监听 `agent/disposed` 清状态，重建后重新挂载
- **热路径读盘**：`readConfig` / `readSessionOverrides` 加 1 秒内存缓存（不是 mtime key——4ms 精度问题踩过），写入即时失效，手改文件最多 1 秒生效
- **sessions.json 原子写**：改为临时文件 + rename，与 config.json 一致
- **日志轮转按行对齐**：原来按字节切，可能把一条 JSONL 从中间切开；现在切到下一个换行之后
- 测试：smoke 49（+2 重建）、config 29（+2 sessions 原子写）

## 0.4.4

- **数据目录改名**：`$DSH_HOME/ask-first/` → `$DSH_HOME/no-guess/`，日志同步改为 `no-guess.log`；首次读取时自动从旧目录复制配置（旧目录保留不删），已有配置不丢。旧环境变量 `DSH_ASK_FIRST_LOG_MAX_BYTES` 仍兼容，新名 `DSH_NO_GUESS_LOG_MAX_BYTES`
- **本地仓库目录改名**：`E:\DSH\dev\plugins\dsh-ask-first` → `dsh-no-guess`，profile 的 `file:` 路径同步
- 测试：config 27 项（+2：旧目录迁移、迁移后数据目录存在）

## 0.4.3

- **词表收窄**：`不确定用户` / `不清楚用户` 必须后接意图词（想 / 要 / 需要 / 偏好 / 指 / 是 / 的意图）——「不确定用户配置」这类想去读文件、不是猜意图的思考不再武装
- **自讨论豁免**：用户消息里出现插件名（`dsh-no-guess` / `ask-first` / 不猜插件 / 插件本身）的轮次跳过思考链——讨论插件本身时 README 和代码里全是信号词，必自触发。豁免只认用户消息，思考里的引用无效，模型不能自己提名字绕开
- 测试：smoke 47 项（+3：意图词后缀放行/武装、自讨论豁免）

## 0.4.2

- **跨轮污染修复**：思考链只扫**本轮**的 assistant 消息（按 `turn` 过滤，遇到 `user/message` 也停）——上一轮已经回答过的「我猜用户」不会再武装下一轮
- **日志隐私**：新增 `logUserText` 配置，默认 **false**——`ask-first.log` 只记 sid / turn / 工具名，不再写用户消息和思考片段；想排查误拦可开
- **性能（已回退）**：曾给 `readConfig` / `readSessionOverrides` 加 mtime 缓存，但 Windows 文件系统 mtime 精度约 4ms——同一 tick 内连续改写会被缓存误命中，config 测试因此偶发失败。已回退为每次读盘（单次约 1KB，代价可忽略），并补「快速连续写读」回归测试
- **真实会话回放**：新增 `test/replay.mjs` + 脱敏 fixture（真实会话，只保留信号片段、用户消息全 `[redacted]`）——统计思考链武装率，红线 50%；当前 fixture 80 个人类轮次武装 20 次（25%），并接进 `npm test` 与 CI
- 测试：smoke 44 项（+6）、config 25 项（+6）
- 文档：README 更新——「只扫本轮」、`logUserText`、reasoning 实测修正（本机 flash 思考块现在有内容）

## 0.4.1

- 中文名定为「不猜」：设置页标题、输入框按钮、设置项文案、README 标题同步；英文副标题改为 Don't Guess
- 隐私清理：测试样本里的本机路径换成通用路径，CHANGELOG 里不再出现具体盘符

## 0.4.0

- **改名 `dsh-no-guess`**（原 `dsh-ask-first`）：npm 上 `dsh-ask-first` 已被 baiye0303 占用，GitHub 上还有 4 个同名实现，改名避免撞名
- 插件 id、HTTP 路由 `/dsh-no-guess`、来源标记、日志前缀、设置页 slot id 全部跟着改
- **数据目录沿用 `$DSH_HOME/ask-first/` 不变**——已有配置不丢（这是历史名字，只影响实现细节）
- 本地目录与 GitHub 仓库同步改名为 `dsh-no-guess`

## 0.3.1

- 修复：`not sure what you mean` 之前只有在同时出现 `I guess that` 时才生效——补上漏掉的 `notsurewhatyoumean` / `unsurewhatyoumean` / `dontknowwhatyoumean`，A12 改为单独测试该短语（探针 9/9 通过）

## 0.3.0

- **英文「猜」信号**：思考链匹配从中文扩展为中英双语——`I guess the user`、`not sure what the user`、`I think the user`、`the user probably wants`、`I guess that`、`not sure what you mean` 等；大小写不敏感、匹配前去掉空白（思考里换行拆词也能抓）
- 对抗测试从 10 条扩到 15 条（新增 A11–A15：英文猜意图 / 通用 guess 句式 / 英文正常推理不误伤 / 大写+换行拆词 / 中英混合），漏洞 0
- 中英文 README 同步更新「猜」信号说明

## 0.2.0

发布前整理，让插件在别人的机器上也能正常工作：

- **数据目录跨平台**：`DSH_HOME` 未设置时兜底改为 `~/.dsh`（原来是写死的本机固定路径），与 DSH 官方的解析顺序一致
- **配置健壮性**：默认值补全 `thinkingGate` / `ruleGate`；手改坏掉的配置文件按字段回退，数值越界自动夹到合法区间
- **原子写**：配置写入改为临时文件 + rename，进程崩溃不再留下半截 JSON
- **日志有上限**：拦截日志超过 2 MiB 后轮转、只保留尾部一半；可用 `DSH_ASK_FIRST_LOG_MAX_BYTES` 调整
- **版本号**：运行时版本从 `package.json` 读取，不再硬编码
- **前端**：输入框按钮与设置页共享一次配置轮询（原来是两路各自 3 秒）；数字输入改为失焦/回车才保存，不再每敲一个字符写一次配置
- **工程化**：`repository` / `homepage` / `bugs` / `engines` / `publishConfig`，`npm test` 串起四组测试，GitHub Actions CI（ubuntu + windows × node 18/20/22），补 MIT LICENSE

## 0.1.0

- 初版：思考链主触发（模型思考里出现「我猜用户 / 不确定用户」时拦截第一次工具调用）+ 可选字面规则兜底、超时放行、设置页
