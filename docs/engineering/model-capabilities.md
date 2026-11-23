# 模型身份、上下文与推理强度

基础核对日期：2026-11-10；AGY 自定义窗口变体于 2026-11-17 按 1.5.9 原生目录与本地模拟核对，官方目录的变体参数于 2026-11-19 用 1.5.11 只读核对。菜单以当前 CLI 返回的型号和档位为准。

## 工作台显示规则

- 模型选择值、显示名称和底层真实型号是三个字段。输入区使用 CLI 图标和具体型号，目录标签用于搜索；发送前由适配器解析为原生选择值，AGY 条目键转为对应标签或模型 ID。
- AGY 当前值来源可确认、目录对应关系明确时，补齐型号展示，不要求名称和型号各占一条缓存记录；无法确认的目录默认及同名配置不推断具体选择。已有显式选择值保留，原生名称与其他模型标识冲突时，点选使用对应配置键，避免改变实际模型；展示补全不改写原生配置及窗口参数。
- AGY 有效自定义窗口在启动时使用临时唯一标签，服务型号与强度变体 ID 保留；按原生目录精确匹配的推理级别补齐默认档位，不按任意自定义 ID 的后缀猜测，显式强度优先。本轮原生会话报告精确匹配时还原原选择，临时标签不写回模型目录。若实际报告不同，保留原生报告，缺少可信窗口时清除预期窗口。
- 模型按钮显示下一轮的显式选择或当前 CLI 配置默认值。原生响应报告另列在菜单中；会话历史与最近报告都不替用户选择下一轮型号。
- Claude 的 `sonnet[1m]`、`opus[1m]`、`opusplan[1m]` 等后缀属于原生选择值。匹配能力时可去掉后缀，发送时必须保留后缀；显示上下文型号时也保留 `[1m]`，按钮独立显示 1M 标记。后缀表示原生选择，实际窗口仍以 CLI 报告为准；没有后缀不等于只有 200K，部分新型号原生就是 1M，禁用扩展上下文等原生设置也会影响窗口。
- 只有当前型号报告可用档位时才显示独立强度入口。显式选择优先；未选择或重置不发送覆盖。旧会话未报告档位时不显示新会话的配置默认值。Claude 档位还须符合 SDK 入参，Codex 保留目录报告的扩展值，`auto` 与不传覆盖分别处理。

Claude 模型菜单提供“默认窗口 / 1M”。只有点击 1M 才生成对应 `[1m]` 选择，打开菜单不更改模型；已有原生后缀继续继承。切回默认窗口移除显式后缀；别名自身绑定后缀时改用去掉后缀的明确型号，不改原生别名配置。切换保留当前推理强度，不将“默认窗口”固定解释为 200K。

## 已核对的精确规则

AGY 官方账号直接选择带档位的原生型号。例如 `gemini-4-neon-low`、`gemini-4-neon-high`。选择此类型号时，文字路径不叠加 `--effort`；图片路径把变体拆为原生基础型号和档位，并等 ACP 确认两项后才发送。自定义窗口的临时标签为保留原生默认仍可用经核对的启动档位，不能拿自定义 ID 的后缀推断。

2026-11-19 对 AGY 1.5.11 做过隔离只读对照：原生 `/effort` 返回所选变体的档位；额外传入冲突的 `--effort` 会在生成前拒绝。本轮移除了工作台按同族型号推导的第二个入口，不改变原生终端的 `/effort`。

## 各 CLI 的窗口设置

| CLI | 窗口与压缩控制 | 当前入口 |
|---|---|---|
| Claude | `[1m]` 是模型选择后缀，模型本身也可能原生支持 1M；压缩控制按 Claude 原生字段处理 | 对话模型菜单选择默认窗口/1M；其他原生压缩参数在原始配置编辑 |
| Codex | `model_context_window` 声明窗口，`model_auto_compact_token_limit` 设置自动压缩 token 阈值 | 模型设置中分别填写，留空使用原生默认；计数范围和轮末百分比仍在原始配置编辑 |
| Antigravity | 自定义模型的 `maxTokens`，内置型号沿用原生元数据 | Gemini 自定义模型设置；没有经核实的通用压缩阈值表单 |

窗口设置表达 CLI 的上下文预算，模型服务自身的容量限制仍生效。总容量、输入预算和压缩配置上限分别核对，是否扣除输出预留以原生证据为准；一次短生成确认配置已载入，不证明满窗口承载或精确压缩触发时刻。页脚的用量与当前有效窗口按[统计口径](cli-observability.md)显示。

## 缓存与刷新

模型目录按 CLI 和规范化工作区目录落盘，当前 v3 用目录摘要关联模型快照，相同快照去重并保留默认值与底层型号。仅复用当前格式；旧的可重建缓存不迁移。AGY 另校验连接身份，不复用未区分账号和 API Key 的缓存。容量和失效规则见[架构](architecture.md#43-回合控制与原生参数)。输入区挂载只读可信缓存；首次打开模型菜单且缓存标记为未发现时才触发一次原生发现。菜单中的“刷新模型列表”可主动重新读取，配置保存会清除相应 CLI 的缓存代次。缓存只保存模型元数据、底层型号、默认值与版本标记，不保存技能正文、路径、诊断或密钥。

## 资料来源

- [OpenAI GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config.md)
- [Claude API effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [Kimi reasoning effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort)
- [GLM core parameters](https://docs.z.ai/guides/overview/concept-param)
- [Qwen Responses compatibility](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)
- [Antigravity effort](https://antigravity.google/docs/cli/commands/effort) 与 [headless](https://antigravity.google/docs/cli/headless/)；本机 `agy --help` 确认 `--effort` 参数枚举。

以上资料用于补全候选菜单；本机 CLI 的能力报告优先。
