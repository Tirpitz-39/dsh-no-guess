# dsh-no-guess 执行路线（当前版）

> 2026-11-16 定稿。这份是**当前要做的执行路线**，优先于 [ROADMAP.md](ROADMAP.md)（产品阶段）和 [TECH-ROADMAP.md](TECH-ROADMAP.md)（技术方案）中冲突的部分。
> 状态标记：✅ 完成 · 🟡 进行中 · ⬜ 待做 · ⏸ 等外部

## 一、P0–P6 总览

| 优先级 | 主题 | 状态 | 现在要做的 | 卡点 |
|---|---|---|---|---|
| **P0** | 工程债：敢默认常开 | ✅ 全部完成（未发版） | 重挂/缓存/原子写/轮转（0.4.5）+ 契约测试/启动自检/生命周期（工作区，待发 0.5.0） | 无，待发版 |
| **P1** | 按可逆性分级放行 | 🟡 设计 v0 已审过 | 改三处后落码（注册表 dump 生成表、tierOverrides、read-pass + policy） | 无，改完即开工 |
| **P2** | 三档模式 hint/deny/assumption | ⬜ 设计确认 | P1 之后，共用 deferContext 通道 | 依赖 P1 |
| **P3** | 扩信号 | ⬜ 未开始 | 猜谜豁免先做（最便宜）；参数日志次之；modelGate 砍或降级 | 无 |
| **P4** | 问的质量校验 | ⬜ 设计确认 | P1 之后；首次提醒、同轮第二次真拦；ask 移出 ALWAYS_ALLOW | 依赖 P1 的 guard 改造 |
| **P5** | 假设账本 | ⬜ 方向确认 | 最后做；turn-stopping 检测「假设：」行 + append-only JSONL | 需实测 stop 时刻消息可见性 |
| **P6** | 生态与退场 | ⬜ 长期 | 严格度分档、信号包、dsh-go 原生界面、回流官方 preset | 依赖 P1–P5 |

## 二、0.4.6 / 0.4.7（已发布）

| # | 任务 | 内容 | 验收 | 状态 |
|---|---|---|---|---|
| 1 | 日志迁移修复 | 迁移时 `ask-first.log` 复制为 `no-guess.log`（幂等 fixup，已迁移机器也补一次），旧文件保留 archive | 升级后 `/log` 与分析工具能看到历史日志 | ✅ |
| 2 | 版本号与 CHANGELOG | `package.json` → 0.4.6 / 0.4.7；CHANGELOG 对应段落 | 两处一致 | ✅ |
| 3 | 全测 | 6 组测试全绿 | smoke/edge/attack/config/replay/analyze-log 全 exit 0 | ✅ 56/20/15/33/25%/21 |
| 4 | 发版 | 提交 + npm publish + GitHub release | registry latest=0.4.7，ta 能升级收基线 | ✅ |

- **0.4.6**：日志契约扩展（signal/family/turn/latencyMs）、`tools/analyze-log.mjs`、历史日志接管修复、`files` 包含 `tools/`
- **0.4.7**：热路径修复——迁移检查移到配置缓存未命中之后，守卫路径不再每工具调用做 legacy 扫描
- 验证：0.4.6 与 0.4.7 均从 registry 干净安装并跑通分析工具；GitHub release v0.4.6 / v0.4.7 已建；远端 main 与本地一致

## 三、P1 v0 落码任务（0.4.6 之后）

| # | 任务 | 内容 | 验收 |
|---|---|---|---|
| 1 | 注册表 dump | 插件启动时把 `ctx.tools` 注册表写成 `tools-dump.json`（或日志一行，待拍板） | dump 覆盖全量工具名，无手写遗漏 |
| 2 | 静态分级表 | 从 dump 人工标注生成表：read / write / execute / external / allow | 表内工具三类齐全，未知工具走 execute |
| 3 | tier 判定 | guard 按表判定；未知工具行为=execute（拦），日志 `tier` 写 `unknown` | 单测：read 放行、write/execute/external 拦、未知拦 |
| 4 | `tierOverrides` | 全局 `{ "工具名": "tier" }` 覆盖 map | 覆盖生效测试；非法 tier 值被忽略 |
| 5 | `readPolicy` 开关 | 默认 `tiered`；`legacy` 一键回退现状 | legacy 下行为与 0.4.5 一致 |
| 6 | `read-pass` 反事实事件 | armed 状态下 read 类被放行时记 `read-pass`（tool/tier/signal/turn/policy） | 日志断言；analyze-log 能统计「少拦了多少」 |
| 7 | `policy` 字段 | arm / block 事件带 `policy: legacy\|tiered` | 日志断言；分析工具分段 |
| 8 | 启动自检 | 注册表有表外工具时记一次 `unknown-tool` warn | 日志断言 |
| 9 | README | fail 语义（崩溃 fail-open / 判定不确定 fail-closed）+ 已知误拦清单 | 文字与实现一致 |

**P1 v0 边界**：只查名表；shell（`pwsh`/`bash`/`adb`/`terminal_send`）全拦；不碰参数和命令解析。v1 = shell 解析 log-only（只记日志不改行为，跑一周）；v2 = 解析生效，解析失败 fail-closed。

**名字校正（对注册表实测）**：`mcp__phone__clipboard`（get/set 靠参数，保守归 write）、`mcp__phone__notify`、`claim_check`/`claim_bind`/`claim_report`。多动作工具（`plugin_manager` list、`claim_check` persist:false、`clipboard` 读）在名字级下必然误拦，进 README「已知误拦」+ `tierOverrides` 自救。

## 四、P2–P5 落点摘要

| 项 | 落点 | 关键约束 |
|---|---|---|
| P2 hint | `allow + exec.deferContext(一两句话)` | 不新起一轮；上下文保持短 |
| P2 assumption | 立即 deferContext | 与现有 timeout 合并：timeout = 保底 |
| P3 猜谜豁免 | 用户消息含「猜猜/盲猜/你猜」→ 本轮思考链不武装 | 最便宜，先做 |
| P3 参数日志 | `exec.arguments` 记「凭空实体」候选 | 先 log-only，不拦 |
| P3 modelGate | 砍或降级为「边缘信号 + 上下文 + 缓存 + 预算」 | 默认关；优先级最低 |
| P3 会话级降敏 | 用户回「直接做/不用问/别问」→ 本会话降敏 | **不做全局学习** |
| P4 ask 校验 | ask 移出 ALWAYS_ALLOW；未武装时仍放行；首次 allow+deferContext 提醒、同轮第二次真拦 | 校验：≥1 问、每题 2–4 个非空不重复 options |
| P5 假设账本 | `agent/turn-stopping` 查最后一条 assistant 有无「假设：」行；append-only JSONL | 拿不到消息则以下一轮 pre-step 兜底 |

## 五、指标口径

| 指标 | 定义 | 数据源 |
|---|---|---|
| 武装率 | 武装数 / 真人轮次 | replay（目标 10–20%，只作参考，**不当 KPI**） |
| 误伤率 | `dismissive` / (`substantive` + `dismissive`) | `block-outcome` 事件（同 sid + 10 分钟窗） |
| read 反事实 | `read-pass` 计数（分 tier / 工具） | 日志 |
| 拦截分布 | by `tier` / by `family` / by `signal` / by `policy` | `tools/analyze-log.mjs` |
| 迟到 | 用户已答完仍拦 | 日志时序 |

## 六、明确不做

| 不做 | 原因 |
|---|---|
| 追求 100% 拦截 | 会变弹窗流氓 |
| 拦只读工具（v0 起） | 只读恰恰是消解歧义的手段 |
| 靠堆正则治多语言 | 维护成本爆炸，改用结构化短语包 |
| 加第二、第三个 LLM 判断器 | 不可审计 + 花钱 + 偏严 |
| 拦 `ask_user_question` 本身 | 提问是目的不是违规；只校验质量、不硬拦 |
| 把「提问等级」等 UI 层的事揽进插件 | 那是宿主/preset 的事 |
| 武装率当 KPI | 场景不同天然不同，会逼出「为指标少拦」 |

## 七、待拍板

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| 1 | 发版节奏 | 0.4.6 先发 / 并入 0.5.0 | 0.4.6 先发（ta 要收基线） |
| 2 | `tierOverrides` 作用域 | 全局 map / 全局+会话级 | 只全局（会话级已有 enabled，避免三层语义） |
| 3 | dump 落点 | 文件 `tools-dump.json` / 日志一行 | 文件（好读、可 diff） |

## 八、已知事实

- 当前版本 0.4.7（npm latest）；工作区 HEAD `8d90ec7`
- 测试 56（smoke）+ 21（analyze-log）+ 33（config）+ 20（edge）+ 15（attack），replay 25%
- 历史日志迁移问题：0.4.6 已修复（含已迁移机器的幂等 fixup，旧文件保留 archive）
- 本机与 ta 那台注册表不同：本机有 `list_sessions`/`claim_status`/`job_*`/`remote_*`/`video_*`，无 `mcp__phone__*`/`terminal_*`/`team_task_*`/`adb` → 表必须 dump 生成
