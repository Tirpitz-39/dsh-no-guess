# Changelog

## 0.3.1

- 修复：`not sure what you mean` 之前只有在同时出现 `I guess that` 时才生效——补上漏掉的 `notsurewhatyoumean` / `unsurewhatyoumean` / `dontknowwhatyoumean`，A12 改为单独测试该短语（探针 9/9 通过）

## 0.3.0

- **英文「猜」信号**：思考链匹配从中文扩展为中英双语——`I guess the user`、`not sure what the user`、`I think the user`、`the user probably wants`、`I guess that`、`not sure what you mean` 等；大小写不敏感、匹配前去掉空白（思考里换行拆词也能抓）
- 对抗测试从 10 条扩到 15 条（新增 A11–A15：英文猜意图 / 通用 guess 句式 / 英文正常推理不误伤 / 大写+换行拆词 / 中英混合），漏洞 0
- 中英文 README 同步更新「猜」信号说明

## 0.2.0

发布前整理，让插件在别人的机器上也能正常工作：

- **数据目录跨平台**：`DSH_HOME` 未设置时兜底改为 `~/.dsh`（原来是写死的本机路径 `E:\DSH`），与 DSH 官方的解析顺序一致
- **配置健壮性**：默认值补全 `thinkingGate` / `ruleGate`；手改坏掉的配置文件按字段回退，数值越界自动夹到合法区间
- **原子写**：配置写入改为临时文件 + rename，进程崩溃不再留下半截 JSON
- **日志有上限**：拦截日志超过 2 MiB 后轮转、只保留尾部一半；可用 `DSH_ASK_FIRST_LOG_MAX_BYTES` 调整
- **版本号**：运行时版本从 `package.json` 读取，不再硬编码
- **前端**：输入框按钮与设置页共享一次配置轮询（原来是两路各自 3 秒）；数字输入改为失焦/回车才保存，不再每敲一个字符写一次配置
- **工程化**：`repository` / `homepage` / `bugs` / `engines` / `publishConfig`，`npm test` 串起四组测试，GitHub Actions CI（ubuntu + windows × node 18/20/22），补 MIT LICENSE

## 0.1.0

- 初版：思考链主触发（模型思考里出现「我猜用户 / 不确定用户」时拦截第一次工具调用）+ 可选字面规则兜底、超时放行、设置页
