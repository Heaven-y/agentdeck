# CLI 用量与执行轨迹

基础核对日期：2026-11-10；AGY 上下文与回合恢复复核于 2026-11-17。本文只定义当前指标口径与接入限制；逐阶段实验完整保存在 `b053fe1:docs/engineering/cli-observability.md`，初始评估在 `6856c1d`。

## 对齐的 DSH 体验

最初参考的 DSH 0.2.2-rc.1 Trajectory 是按轮次和步骤组织的事件表、时间概览及记录检查器，覆盖消息、工具、子调用、压缩、输入输出、用量和耗时。它不是单纯的会话分支树。

DSH 的生成速度同时依赖提供方输出 token 数与首个 token 至完成的计时；另有首 token 延迟、模型时间、工具时间和全日志汇总。其数据来自自己维护的会话日志。工作台应复用各 CLI 的原生记录，不能为了照齐统计补造一份完整 transcript。

本项目采用“执行过程”作为轨迹主线：一轮消息下按顺序展示工具调用、文件操作、命令、状态和耗时；可取得的输入、输出、错误、审批和子调用作为步骤详情。会话归档、分支和父子关系仍属于会话管理信息，放在轨迹之外的辅助区域，不把分支树冒充执行时间线。

依据为安装包中的 `@deepseek-ai/dsh-client-ui-trajectory/README.zh.md`、`@deepseek-ai/dsh-session-stats/README.zh.md`，以及 chat 客户端的计时投影。参考范围限于交互和指标定义。

当前输入框外下方显示上下文和最新一轮耗时、平均 tok/s；点击统计可展开 token 分项。开始新轮或本轮未报告时不借用旧速度，完整历史统计保留在轨迹视图。Antigravity 使用官方彩色标识。

## 能力对照

| 内容 | Claude Code | Codex | Antigravity |
|---|---|---|---|
| 当前上下文 | summary 原生估计、窗口及百分比 | 最近 tokenUsage.last 与窗口计算占比 | 用量取完整原生记录，缺实时报告时结束后补读；窗口按当前生效模型总容量，运行中保留启动快照 |
| 输入、输出、缓存 token | 已接 result 主循环本轮统计 | 已接 total 累计快照的可靠本轮差分 | 已接 step_update 和历史模型回复的步骤用量，不混用累计 result |
| tok/s | 已接本轮输出 / 宿主记录的整轮耗时 | 已接可靠增量 / 原生整轮耗时 | 公开步骤按同范围耗时计算；历史单次生成可靠对应时提供生成均速 |
| 工具耗时 | 实时调用至结果的单调时钟，标记工作台计时；原生 progress 保留 | 原生 durationMs 或同条目的完整起止时间 | 实时 duration_seconds；历史步骤起止时间 |
| 实时执行轨迹 | 主线程工具、审批、公开思考、压缩与工具进度 | 命令、文件、MCP、搜索、计划、动态工具、协作活动及图片读取 | 工具、文字、步骤统计和压缩；未知原生活动保留类型与状态 |
| 原生历史轨迹 | SDK 主线程消息与工具；子代理独立按需分页查看 | 官方 thread/turn/item 与已核实的独立子线程，保留已有原生时间 | 已接内部轨迹 RPC 与已核实的独立子轨迹；隔离原生读回通过 |
| 旧会话精确速度 | 历史不含完整流计时/result，不能保证恢复 | 当前 thread/read 不含每轮 tokenUsage，不能保证恢复 | 取决轨迹是否实际保存相匹配的用量与计时；未证明普遍可恢复 |

## 计量规则

- 输出 token、输入 token、缓存 token 与上下文占用是不同指标，不能把它们混成一个数。累计使用量不能除以模型窗口冒充上下文占比。
- “回合平均输出速度”按本轮输出 token 与整轮耗时计算，包含工具、审批和等待；与 DSH 的生成阶段速度分开。只有输出计数范围和计时范围一致时显示。
- 实时接收时间受缓冲、网络和 CLI 转发影响。没有可靠 token 计数时隐藏速度，不用字符数或 delta 包数代替 token。若使用 tokenizer，应明确标记估算。
- 同一原生响应的累计 usage 只更新最新值；会话累计量取差前核对基线、恢复和重置。无法取得基线时不追认本轮增量。
- 公开推理与输出总量可能存在包含关系，不能简单相加。费用只在原生报告且范围明确时显示，不为自定义服务套用固定价格表。
- 工具、模型和子代理可并行，时间线应保留重叠，不能将各项耗时相加当作墙钟总时长。历史没有时间戳时保留步骤顺序，不生成虚构时间条。
- 三种 CLI 的子代理历史独立展示自身已保存的用量；打开、分页、刷新或嵌套导航均不将子统计再次累加到父会话。原生父统计本身可能已包含子任务，不由工作台重复相加或擅自扣减。
- 本机计时属于当前运行的遥测；旧会话能恢复多少以原生历史为准。若以后保存补充计时，也只能保存关联 ID 与指标，不复制对话和工具正文。
- 工具原生 ID 与界面 ID 分开，回填仅匹配当前轮次；跨轮复用 ID 不覆盖旧记录。重复结束不复制统计或抹除失败状态；缺数据隐藏，不显示占位警告。

## Claude 的接入点与限制

核对版本：CLI 2.1.317、SDK 0.3.286；不是自动追踪的当前安装版本。`result.usage` 表示本回合主循环用量；`modelUsage` 与 `total_cost_usd` 是会话累计，可能包含子代理、压缩和辅助请求。思考 token 若报告通常属于输出量的子集。

`stream_event.message_delta.usage.output_tokens` 按单个 API 响应累计；`assistant.message.usage` 可保留早期占位值，且同一消息会分块重复出现，不能逐条相加。`duration_api_ms` 含 API 等待，不能直接当纯解码时长。首条完整助手消息、message_start 与首个可见文字的计时含义也不同。

当前上下文使用 `getContextUsage({detail: 'summary'})`，结果是原生估计；`rawMaxTokens` 按原生压缩策略解释。full 模式可能调用 token-count API，不作为每帧自动采样。当前在发送至原生 result 到达间使用单调时钟计时，随后读取上下文，控制查询不计入回合。

当前 [事件映射](../../apps/server/src/agents/claude/run/mapper.ts) 已接 usage、工具进度及公开 thinking，全文快照与流式增量分别去重；签名和 redacted 块不展示。子代理 result 不结束父回合，中断后淘汰旧运行时再按原生 ID 恢复，防止迟到结果串轮。子代理消息、工具和已有步骤用量通过 SDK 独立分页读取。本机 SDK 历史投影未保留部分顶层 system 压缩字段，合成压缩测试仍不能替代真实历史验证。

## Codex 的接入点与限制

协议基线为 CLI 0.166.0，已核对生成的 schema；升级后按实际接口复核。`thread/tokenUsage/updated` 提供 total、last 和可空 modelContextWindow；分项有 inputTokens、cachedInputTokens、cacheWriteInputTokens、outputTokens、reasoningOutputTokens、totalTokens。last 不能默认解释为整个用户回合的用量。

Turn 提供 durationMs 和起止时间；ThreadItem 有可选 startedAtMs/completedAtMs，命令/MCP 等也可提供耗时。文本 delta 不含 token 计数或逐 token 时间戳；tokenUsage 通知也没有 itemId，因此不能直接得到每条助手消息的精确生成速度。

当前 [Codex mapper](../../apps/server/src/agents/codex/run/mapper.ts) 已扩展 plan、webSearch、dynamicToolCall、collabAgentToolCall、subAgentActivity、imageView 及 MCP 进度。工具存在 status 时须有明确终态；中断及未确认完成的历史不标成功。原生公开 summary/content 可以展示，不表示完整隐藏推理。

新线程从零建立用量基线，恢复线程先观察可靠累计快照。缺报告、重置、压缩、失败、中断和迟到通知均使不可靠增量失效；不能从 last 或旧回合中途快照补造整轮统计。

当前 Thread/Turn 历史结构没有 tokenUsage，不能靠 thread/read 重建旧轮次速度。account/usage/read 依赖账单路由可用，不是通用离线历史来源；Internal-only 的原始响应通知不能当稳定公开接口使用。历史分页接入也需与现有全量读取区分。

## Antigravity 的接入点与限制

ACP 与 headless 使用不同运行路径。1.5.3 隔离验证中，ACP prompt 响应提供该请求的 usage；单次 prompt 对应本轮，引导时则按最新受理请求核对计量归属。公开通知用于文本、工具与计划，stderr 只映射脱敏诊断。当前支持范围见[能力矩阵](native-capability-matrix.md)。

Antigravity 接入证据基线为 CLI 1.5.1。公开 headless result.usage 有 input_tokens、output_tokens、thinking_tokens、cache_read_tokens、total_tokens，另有 duration_seconds。step_update 在已知时可带 usage 和 duration_seconds，step_index 和状态可用于步骤归属。

官方定义的 result 是累计口径；工作台每轮新进程续接时也不把其用量和耗时推定为本轮。现仅采用范围明确的步骤报告，避免将旧会话计数计入新回复。

历史回复的 token 分项取该步骤的 `metadata.modelUsage`。有有效模型用量的已完成回复，若 `createdAt` 至 `finishedGeneratingAt` 有效，则恢复步骤耗时；这与工具的 `startedAt` / `completedAt` 分开，本机核对的回复中，后两者都等于生成结束时刻，不能用于恢复生成耗时。回复时间缺失、非法、倒序或相等时不补零，也不拿流式生成时长替代步骤总耗时。无有效模型用量时不生成该步骤统计；有用量但时间不可用时，耗时和相应均速仍保持未知。

历史用量读取 generatorMetadata 最后一条 chatModel.chatStartMetadata.contextWindowMetadata，采用原生生成前估计；元数据不完整或缺字段时隐藏。本轮未收到实时上下文时，结束后以五秒预算只读补取上下文，不替换正文；身份、轮次或视图代次已变则丢弃迟到结果。内部实时 StreamAgentStateUpdates 和 TUI statusLine 尚未接入。

上下文面板只显示所选模型当前生效的一个窗口：自定义模型采用原生 `maxTokens`，内置型号从本机 `GetAvailableModels` 读取总容量；自定义条目未填窗口则与原生尚未生成时一致，保持未知。旧轨迹的 `maxContextTokens` 是当次生成输入预算，可能扣除输出预留，不再用它代替当前总窗口。新建和历史续聊共用模型选择器，运行中采用本轮快照；API Key 模式下已明确的内置型号也在 headless/ACP 启动时补齐快照，最多等待目录一秒，超时或不可读保持未知，不能借当前默认配置冒充本轮。压缩完成记录保留在轨迹，不常驻当前上下文详情。

总窗口不等于自动 checkpoint 的触发点。[原生 `/context` 说明](https://antigravity.google/docs/cli/commands/context/)确认 AGY 会自动汇总旧轮次，摘要所占的 checkpoint buffer 单独列出，没有公布固定触发值。内嵌 profile 中的 `token_threshold` 与 `max_token_limit` 是不同字段，静态数字不能直接当作当前自定义模型的生效值。后续验收通过同轮生成与执行元数据核对 checkpoint 配置上限；1M 窗口、输入预算和 checkpoint 上限仍不代表精确的压缩触发时刻，界面不推算该时刻。

同日只读复核的一份既有轨迹中，所有已保存生成记录的输入预算均为 256,000；三次 checkpoint 前最近一次生成的估计用量分别为 281,174、206,699、183,692，下一次生成降至约 19,000–22,000。这些是相邻生成开始时的估算，不是 checkpoint 触发瞬间的计数。最后一处发生在当前配置文件修改之后，模型显示名也与当前 1M 条目相同，但轨迹没有证明当时进程已重载该条目或没有启动覆盖。因此这些记录不能验证当前 1M 的实际生成预算，也不能认定是固定的低压缩阈值所致；下一步须对齐同一次生成实际加载的模型参数、输入预算与 checkpoint 配置。

后续按同一轨迹的 `executionId` 唯一关联持久化 `generatorMetadata` 与 `executorMetadatas`，已确认所核对的旧执行保存了 `checkpointConfig.maxTokenLimit=256000`、`tokenThreshold=50000`、`maxOverheadRatio=0.15`、`maxOutputTokens=32768`，压缩开启且策略为 SAME_MODEL。两侧没有提取到模型窗口覆盖数字；这些证据确认旧执行的 checkpoint 配置上限，并不证明当前新启动配置仍相同，也不将 50K 字段当成总上下文触发点。

经用户授权的一次 `gemini-4-hydrogen` 隔离连接验收，使用保存的地址和密钥，临时指定裸型号并继承当前 1M 窗口。验收代理向目标服务转发一次，HTTP 200、原生 SUCCESS、回复 OK；服务用量为输入 11,573、可见输出 5、思考 47，共 11,625。成功执行的轨迹补读失败，未取得该轮窗口或压缩参数。另一次零转发、占位密钥的本地阻断执行记录输入预算及 checkpoint 上限均为 256K，但它不是同次成功请求，生成模型显示名亦未确认匹配，不能据此追认真实服务的 1M 生效或未生效；真实精确压缩触发点仍未测试。

之后先做零外发对照：裸 Argon 标签样本记录了内置 Medium、未见模型覆盖及 256K 预算/检查点，但成功回复与生成的引用校验未完成，只保留为线索；唯一标签的 1M、200K 样本通过同轮校验，分别得到 934,464、134,464 的预算和检查点上限。后续按当前已存 High 条目完成严格对照：原标签与内置显示名重名时，原生选择 M417，未载入覆盖，输入预算和 checkpoint 上限均为 256K；生产唯一标签路径则载入 1M，二者均为 934,464。原生 Argon 枚举映射的父 profile 含 256K，与旧执行和该本地对照相符。由此定位到选择身份碰撞：目录中的窗口覆盖不能证明规划器采用了自定义模型。

裸型号的本地取证预检通过后，唯一一次真实 Argon 请求经保存的地址和密钥返回 HTTP 200、原生 SUCCESS 与 OK；输入 11,706、输出 5、思考 0，共 11,711 tokens。临时唯一标签避免碰撞，模型 ID 精确为用户指定的裸型号，窗口继承当前 1M 设置。成功回复、生成元数据和唯一执行元数据已按原生引用及非空 executionId 对齐；同轮 planner 为 BYOM，模型覆盖是 1,000,000，模型输出上限为 65,536，实际输入预算和 checkpoint 上限均为 934,464。checkpoint 自身输出上限 16,384 属另一字段；本次没有填满窗口或主动触发压缩，不将配置上限追认为精确触发点，也不据短请求保证服务商满窗口承载。

生产修复另通过零外发模拟核对变体参数：单独更换临时标签曾把 High 的 `thinkingLevel=HIGH` 变成 `thinkingBudget=-1`，因此启动时须按原生目录精确型号读取默认级别并保留档位。最终 High、Medium、Low 分别发送 HIGH、MEDIUM、LOW，输入预算和 checkpoint 上限都保持 934,464；High 显式选择 low 时发送 LOW，窗口不变。同一隔离会话以不同临时标签续接两轮通过。这些是本地原生接线与请求参数验证，不能扩大为三个强度变体的真实服务验收。

此前在 CLI 1.5.9 隔离环境中仅执行 `/context`：同一已有历史副本随本次配置从 `17.7k/1M` 变为 `17.7k/200K`，日志中的模型元数据采用相应 `max_tokens`；没有发送模型请求。该版本自定义标签撞内置标签时，面板与模型目录信息可能不一致。该阶段只证明模型元数据与面板行为，未核对规划器和 checkpoint，不能代替后续真实生成验收。其他版本与未知模型不套用固定家族窗口。

同日另用键与标签交叉重名的隔离条目复核：原生已保存的模型值命中标签对应的 200K 条目，显式切到另一标签时后端确认 1M 条目。默认路径日志仅报告标签传播，其窗口由原生面板观察；没有把缺失的模型 ID 日志追认为已经取得。工作台因此区分已存标签和显式条目键，去重仅按标签分组。

AGY 历史现可读取同次生成的 `timeToFirstToken` 和 `streamingDuration`。只有完成的单一回复、生成索引/执行身份一致、单次尝试且原生用量匹配时显示“首段”“生成”和生成平均 tok/s；多步骤共享生成或重试时隐藏。首段可含推理输出，输出 token 包含原生计入的推理，均速不代表逐 token 解码速度。真实 CLI 接本机定时响应已核对两轮约 150 ms 首段等待、200 ms 后续流式耗时及思考 token 口径。

正式历史读取已复用目录、身份和空闲校验，白名单映射文字、命令、文件、MCP、通用工具、公开错误、压缩及未知活动。读取预算由[架构](architecture.md#44-历史与前端状态)定义，缺页明确失败。历史工具的模型用量可能来自生成调用的模型请求，不与工具执行时间配对计算速度。该入口仍是内部协议。

原生结果成功与进程退出分开：结果后等待超时只触发清理，收到真实 close 才释放会话；未成功发出清理信号后的异常退出、协议错误和主动停止继续标失败。

headless 将服务故障暂存，并按同一会话、目录和本轮输入边界复核原生轨迹。只有自然成功退出、同轮明确的纯 429 后有完整最终答复，或续接 `ERROR` 缺少错误正文且满足严格终态复核，才能确认恢复；混合故障、未知输入边界及矛盾的当前轮错误不能仅凭已有正文改判成功。仅累计结果包含归属不明的错误时，结束状态标记为未确认，不生成本轮错误条，待发仍暂停。确有本轮故障时保留相应失败提示；进程清理、外部非零退出和用户中断分别判断，规则见[原生对话](native-dialogue.md#4-接口与实现选择)。

未确认回合不显示未经核实的整轮统计。只有本轮最终公开回复步骤已确认完成且有对齐的原生用量时，页脚才可显示该步骤统计；平均速度还需要同一步骤的有效耗时，并按步骤口径解释。其他步骤仍可在轨迹中查看，不能拿累计 `result.usage` 或 `duration_seconds` 冒充该轮。缺少本轮回复证据时，不从累计 `result.response` 补正文。未确认状态仅存在于当前视图和有界恢复事件中；原生历史重读不承诺恢复工作台生成的状态。

只读会话副本与本机响应对照显示：原生直播记录中的本轮回复已完成、本机模拟响应成功且进程退出 0 时，累计结果仍可包含与多条历史错误同文的 524。该产物没有保存完整 stderr 分类与本轮完整轨迹字段，不能排除所有其他来源，也不能将新反馈中的每条提示归于同一原因。此前的修订把诊断文案改为归属未确认，但后续回合再次返回累计错误时仍发出新的错误事件；本轮另用脱敏记录的步骤形状和合成事件离线重放历史错误、本轮故障及异常退出，不视作新的原生 CLI 或外部模型验收。

本机固定响应服务还验证了自定义模型的请求路径：当前 CLI 把包含地址的 modelName 当成模型 ID，造成错误路由。表单将模型 ID、显示名称和原生选择项分别处理，URL 单独走启动环境，末尾重复版本段规范化；旧配置的读取与迁移规则见[模型连接说明](native-configuration.md#模型与服务连接)。

## 界面与验证

已提供“对话 / 轨迹”切换、按轮虚拟步骤表和点击打开的右栏详情，复用同一会话条目。回合或步骤完成后显示对应 token、耗时及平均速度，输入区显示上下文占比。审批与停止在轨迹中仍可操作，视图切换保留草稿。

当前验证覆盖统计去重、跨轮 ID、失败/取消、原生生成计时与界面；外部模型服务结果和账号模式状态见[路线图](../roadmap.md#已有验收证据)。

## 证据入口

- Claude：[SDK 用量](https://platform.claude.com/docs/en/agent-sdk/cost-tracking)、[类型参考](https://platform.claude.com/docs/en/agent-sdk/typescript)、[流事件](https://platform.claude.com/docs/en/build-with-claude/streaming)，以及本机 SDK 类型与实现。
- Codex：本机 `app-server generate-json-schema` 的 0.166.0 schema；字段依据来自生成协议；早期网页取证失败的记录仍保留在历史文档。
- Antigravity：[headless](https://antigravity.google/docs/cli/headless/)、[statusLine](https://antigravity.google/docs/cli/statusline)、本机 protobuf 描述和隔离 GetCascadeTrajectory 读取。
- 当前数据入口：[Claude 上下文](../../apps/server/src/agents/claude/run/query.ts)、[Antigravity 映射](../../apps/server/src/agents/antigravity/run/mapper.ts)、[前端上下文状态](../../apps/web/src/features/chat/models/ContextStatus.tsx)、[事件归并](../../apps/web/src/features/chat/state/chat-reducer.ts)。
