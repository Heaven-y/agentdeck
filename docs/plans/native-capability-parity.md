# 三 CLI 原生能力补齐实施计划

执行方式：逐项实施、独立审阅、增量验证；每项完成后更新本计划和对应长期文档。用户已授权自主实施与阶段提交；需要产品决策的事项保留到最终清单，不阻塞其他任务。用户已取消两个会话的并发限制；按当前工具上限并行，文件责任明确，最终统一审阅。

目标：在 AgentDeck 中使用 Claude Code、Codex、Antigravity 的原生对话、图片与文件上下文、提问、追加消息、子代理，以及 Skills、MCP、插件管理；按原生语义分别适配，不把目录展示当作完整管理。

架构：保留现有 React/Electron/Fastify 与单一会话状态；共享层定义可验证的用户操作，原生适配器决定实际支持。Claude 继续使用本机 CLI 与 Agent SDK，Codex 继续使用 app-server，AGY 优先验证新增 ACP 接入，保留现有 headless 的明确兼容边界。原生记录仍是会话事实来源。

技术：Node.js 22+、TypeScript、Fastify、React、TanStack Query、zustand、现有 SDK 与原生 CLI；优先复用已有依赖，不建设通用插件兼容框架。

设计依据：本文“能力核查与设计决定”是本轮规格；既有需求、架构、安全与原生配置规则继续适用。基线为 `9eb3f7d`，核查日期 2026-11-10。

## 全局约束

- 分支为 `feat/native-capability-parity`，使用隔离工作树。关联修复进入该分支；按独立可验收阶段提交，阶段内修正先整理再提交。全部验收后使用 `--no-ff` 合入本地 main，保留大功能分支。
- 在完整计划、自审和独立计划审阅完成前不写产品实现。实现遇到新证据时先修订对应任务及理由，不静默缩减范围。
- 不自动升级用户 CLI、不使用真实模型或 MCP 服务作为默认测试、不改真实原生配置。原生协议用隔离目录、合成服务与受控子进程验证。
- 已有 URL＋Key 模式优先；原生账号登录暂缓。没有授权的外部发布、版本递增与安装包制作不执行。
- 不伪装官方客户端，不绕过模型、权限或账号限制；不从“字段存在”推断运行支持，不把内部接口当稳定协议。
- 正文仍只由原生保存。待发送内容与提问答复只在有界内存中恢复；用户主动上传的附件单独管理，不另建会话正文库。
- 各 CLI 的原生作用域、继承、批准与插件来源保留；只修改明确选中的资源，保存复核 revision，并与运行、安装、项目变更互斥。
- 网络查询、连接检查、安装与授权均由产品中的用户动作触发。列表 GET 不隐式安装、不执行市场更新、不连接任意 MCP。
- 所有进程无 shell 拼接、Windows 隐藏窗口、取消清理、时间与输出预算有界。不得记录凭据、真实会话正文或原始敏感诊断。
- 测试只覆盖核心行为、真实回归与关联路径；临时目录代替开发机绝对路径。类型、规范、格式、文档及构建按实际影响检查。

## 能力核查与设计决定

核查版本：Claude CLI 2.1.317 / SDK 0.3.286、Codex 0.166.0、AGY 1.5.3。更高版本不自动视为兼容；能力读取失败只停用受影响操作。

| 能力 | Claude | Codex | AGY | 本轮处理 |
|---|---|---|---|---|
| 原生对话与历史 | 已接 SDK | 已接 app-server | 已接 headless 与管理服务 | 保留，新增交互需回归续聊/恢复/身份 |
| 图片输入 | SDK 内容块支持 | UserInput 支持 image/localImage | headless 仅文本；ACP initialize 实测 image=true | 原生图片发送、粘贴/拖入/选择、预览与历史映射 |
| 文件上下文 | 原生文本/文档内容块 | 原生 mention、文件路径与模型工具 | ACP embeddedContext=true | 文本与文件上下文显式区分，不能假称所有文件都可模型直读 |
| 模型提问 | AskUserQuestion 与 SDK 用户对话 | item/tool/requestUserInput | ACP 文档支持 elicitation | 独立问题卡片、单/多选/自由输入、拒绝/取消、恢复 |
| MCP 表单/URL 请求 | onElicitation | mcpServer/elicitation/request | ACP 具体协商待隔离确认 | 标准表单与原生授权链接；未知结构明确拒绝 |
| 运行中追加 | SDK 输入流及原生 priority，调度边界需实测 | turn/steer + expectedTurnId | ACP 文档明确 steering | 默认可见队列；只有证据完整的适配器提供“引导本轮” |
| 子代理 | 已有历史；SDK 另有任务通知/停止 | source.subAgent、协作工具与子线程 | ACP/原生轨迹子代理身份 | 父子归属核验、独立历史与运行状态；停止按原生能力 |
| Skills | 原生目录、skillOverrides 多态 | skills/list、skills/config/write | GetAllSkills、发现清单，部分目录不可禁用 | 来源/作用域/状态/创建编辑/支持的启停，不能统一开关语义 |
| MCP | 原生命令持久配置；SDK 状态/重连 | 命令配置、状态分页、重载 | mcp add/remove/list/enable/disable | CRUD、脱敏、显式检查、状态与支持的重连 |
| 原生插件 | plugin list/install/enable/disable/update/uninstall | CLI add/list/remove/marketplace | plugin list/install/uninstall/enable/disable/validate | 原生命令适配；Codex 禁用官方标明不宜生产的 plugin RPC |
| 原生规则、Hooks、代理定义 | 配置与专用目录 | 原生配置、规则、代理配置 | rules/hooks/agents 原生入口 | 原文编辑加来源说明，补遗漏入口，不另造作用域 |
| 权限/压缩/模型 | 已接主要模式与 compact/context | 已接权限与 compact | headless 软拒，ACP 可承接批准 | ACP 原生批准；高级细项保留原文，不能默认放宽 |
| 审查、回退等专用操作 | 原生文件检查点与 rewind | review/start、thread/revert；rollback 已删除 | 按实际命令/ACP目录 | 单独核查与实现可验证入口；不可逆语义列为决策项 |
| 语音/实时音视频/远程账号功能 | 实时音频不纳入；远程账号按D02暂缓 | schema 部分存在不代表本地可用 | ACP audio=false | 实时音频不建设，远程账号授权暂缓 |
| CLI 安装更新 | 上轮已实现 | 上轮已实现 | 上轮已实现 | 管理操作复用维护锁，受影响路径回归 |

AGY ACP 初始握手已经在隔离目录真实验证：`protocolVersion=1`、`loadSession=true`、`image=true`、`embeddedContext=true`，提供 Gemini API key 认证入口。该证据尚不等于 URL＋Key 的模型回合、审批、提问和历史均通过；必须完成 P02 的受控闭环。

AGY ACP 提问已实测使用 `elicitation/create`；Codex 0.166.0 的阻塞 `request_user_input` 仅在计划模式可用，普通模式 `request_user_input_async` 发出 `agentMessage(delivery=async, questions)`，不走待答 RPC。P03 完成阻塞问题与表单；普通模式异步问题卡片和答复投递由 P05 接续消息生命周期，P10 补计划模式入口。三者分别验收，不能用阻塞 RPC 测试代替异步回答。

### 方案取舍

1. 只补页面和配置编辑：不能承接问题、引导、状态及原生安装流程，不能满足本轮目标。
2. 为三个 CLI 重新实现执行器和插件系统：会丢失原生行为并扩大维护范围，不采用。
3. 共享用户操作模型，各适配器实现原生协议：采用。AGY 增加 ACP；能力与运行来源关联，不把新协议能力直接贴到旧 headless 路径。

### 交互约定

- 运行中输入区仍能编辑。默认按钮“排队发送”，有原生支持时另提供“引导本轮”；二者含义清楚，不自动把失败的引导重发为新回合。
- 队列按具体会话保存，支持查看、编辑、删除与清空。成功完成后依次发送；失败、停止、失联或等待用户答复时暂停，需用户显式继续。每会话最多 10 条、全宿主最多 100 条；同一条消息只受理一次。
- 问题卡片使用原生问题、选项和是否阻塞；用户答复后显示已回答，秘密字段只显示状态。取消、中断、原生撤销与超时关闭等待，迟到答复无效。
- 附件先预览再发送；模型或协议明确不支持时保留草稿并说明。初始图片类型 PNG/JPEG/WebP/GIF，最多 4 张、每张 5 MiB；校验真实文件格式与解码边界。文件引用不自动执行其内容。
- 原生管理集中到现有“原生配置与扩展”，按 Skills、MCP、插件、规则/Hooks 分类；每类按 CLI/项目列出实际作用域，保留原文高级入口。工作台插件页面保持独立。
- 插件安装前展示来源和原生要求确认的命令；卸载默认保留插件数据（原生支持时）。未知来源、托管资源与不可写范围只读。
- 子代理从父会话进入，展示名称/角色/状态/历史；不混入普通项目会话、不把子代理结果结束事件当父回合完成。

## 重点审阅场景

1. 切换项目/CLI、刷新与后台运行时，附件、问题、队列和迟到返回不能串会话（P03–P06）。
2. 原生配置被外部修改、同名资源跨作用域、托管策略和插件带入资源，操作不得覆盖错误对象（P07–P09）。
3. 网络断开、执行已受理但响应丢失，不能重复发送、安装或重发批准（P02–P05、P09）。
4. 图片伪类型、路径/符号链接、超量数据、秘密表单值、第三方链接及输出，不得泄漏或变成代码执行（P03、P04、P08、P09）。
5. 新旧 CLI/模型差异、原生任务并发及子代理跨目录，必须以实际能力和已证明归属为准，不能错误启用或假报成功（P01、P02、P06、P10）。

## 阶段与状态

| 编号 | 可验收结果 | 依赖 | 状态 | 提交/验证 |
|---|---|---|---|---|
| P00 | 完整能力审计、计划、自审和独立审阅 | 无 | 已完成 | 独立审阅4项重要问题已修订关闭；文档检查通过 |
| P01 | 原生交互能力契约与可用性 | P00 | 已完成 | 16文件/130项、类型/规范/格式/文档通过，独立审阅通过 |
| P02 | AGY ACP 对话、续接与兼容路径 | P01 | 已完成 | 正式runner两轮/同ID/原生读回通过；关联162项与边界22项、范围覆盖达标；独立审阅通过 |
| P03 | 三 CLI 提问与 MCP 交互表单 | P01、P02 | 已完成 | 关联270项；审阅6项修复后117项、范围覆盖/类型/规范通过；独立复核9项、真实隔离CLI与界面通过 |
| P04 | 图片、附件与历史展示 | P01、P02 | 已完成 | R1–R6独立复核关闭；原生输入/历史图片与界面通过，审阅修复83项服务端及135项前端、范围覆盖通过 |
| P05 | 队列与各 CLI 原生引导 | P03、P04 | 已完成 | 三 CLI 正式 runner 排队/引导/原生读回、Codex 异步答复通过；R1–R4 修复及独立复核 Approved |
| P06 | 子代理历史与运行状态 | P02、P03 | 已完成 | 三 CLI 子代理历史、关系、媒体、运行状态和可核实停止已验证；P06a 修复复核与 P06b R1–R4 独立复核均 Approved |
| P07 | Skills、规则/Hooks/代理定义管理 | P01 | 已完成 | 初审4项修复及仅Key事务复核通过；定向54项，独立复核18项；真实隔离验证通过 |
| P08 | MCP 持久配置与运行管理 | P03、P07 | 已完成 | R1/R2独立复核关闭；27项及范围覆盖/类型/规范通过，真实MCP与合成OAuth、界面验证通过 |
| P09 | 三 CLI 原生插件管理 | P07、P08 | 已完成 | 独立复核R1/R2/R3关闭；53项关联及修复29项、范围覆盖/类型/规范通过，真实CLI与界面验证通过 |
| P10 | 专用原生命令与能力遗漏复核 | P02–P09 | 已完成 | 专用操作与 Codex 同实例后台终端已接；定向验证通过，active goal 按用户决定由原生 CLI 管理，保留续聊安全守卫 |
| P11 | 综合审阅、受控实机、文档与整合 | 全部 | 进行中 | 全范围验证与独立审阅通过；新增侧栏每工作区会话折叠体验，完成复核和阶段提交后保留分支待用户决定合入 |

以下任务以各自提交为验收单位；实现签名可因已核实的原生协议微调，必须先记录变更原因并检查下游任务。

## P01：能力契约与可用性

文件：新增 `packages/shared/src/conversation/native-features.ts`；修改 `capabilities.ts`、`index.ts`、三适配器 `capabilities.ts`、server 会话控制契约和模型缓存；关联测试放 `packages/shared/tests` 和现有 capabilities 测试。本阶段没有已接入的新交互，不为 `AgentControls.tsx` 添加无用途入口；P03–P06 实际接入时使用 `featuresForModel` 收紧所选模型能力，既有子代理历史入口不变。

接口：`NativeInteractionFeatures` 描述 `images`、`documents`、`questions`、`forms`、`steer`、`subagents` 的支持状态与限制说明；`AgentCapabilities.features?` 兼容旧缓存。`nativeFeaturesFor(agent, evidence)` 只依据已核对版本、协议握手与运行路径返回能力。

P01同时在 server `agents/contracts.ts` 定义可选会话级 `RuntimeControl` 契约（运行实例ID、原生会话ID、任务快照、`stopTask(id)`及资源失效），由P06实现。它的生命期独立于单轮TurnHandle；没有实现时不声明停止后台任务能力。

- [x] 补核心回归：旧缓存无 features 不意外开启新功能；AGY headless 与 ACP 区分；未知或握手失败保留文本能力，错误不显示成完整支持。
- [x] 实现共享契约和各适配器能力映射；模型 inputModalities 有明确限制时优先模型限制。
- [x] 运行 shared 与三 capabilities 关联测试、shared/server/web 类型；全部通过，另覆盖命令投递、能力缓存和模型缓存关联路径。
- [x] 更新原生对话能力说明、记录证据、提交 `feat(capabilities): 标记各 CLI 原生交互能力`。独立审阅通过。

## P02：AGY ACP 原生交互基础

文件：新增 `apps/server/src/agents/antigravity/acp/{client,runtime,mapper,types}.ts`；修改 `adapter.ts`、`process-environment.ts`、`capabilities.ts`、`bootstrap/cli-services.ts`；测试 `apps/server/tests/agents/antigravity/acp.test.ts` 与现有 adapter/历史/诊断测试。

接口：`AntigravityAcpClient.start(options)` 提供 `request(method, params)`、`notify`、`onRequest`、`onNotification`、`close`；`createAntigravityAcpRunner` 遵循 `TurnRunner`。初始化使用真实 `AgentDeck` 客户端身份；会话原生 ID 与项目归属复用现有验证。允许的方法为固定白名单，不暴露通用 RPC。

阶段边界：P02先验证无需人工登录的APIKey路径和既有批准接口，不声明尚未实现的elicitation客户端能力；P03完成共享交互服务后再启用会话前/运行中表单。未知请求明确取消，不能在P02等待尚不存在的P03组件。

- [x] 先在隔离配置与本机合成模型服务验证 initialize/authenticate(session API key)/new/prompt/cancel/load/resume；记录 URL＋Key、自定义模型、思考强度与权限模式的真实行为。正式续接使用resume，历史通过原管理服务读回；load仅为声明能力，不替代已验证的历史入口。
- [x] 添加协议回归：逐行有界解析、stderr 排空、握手失败、断流、不同会话 ID、取消迟到结果、审批撤回及工具终态。
- [x] 实现 ACP 并映射原生公开文本、工具、计划、上下文和完成状态；使用 CLI 的实际读写/工具实现，不由工作台冒充编辑器执行任意 RPC。
- [x] 仅在发送前可选择兼容路径；已投递 prompt 后绝不切换协议重发。若自定义模型或版本不支持 ACP，保留原 headless 并明确能力差异。
  - 隔离实测补充：AGY 1.5.3 ACP允许API Key＋自定义服务地址，但新会话默认Gemini型号并拒绝未知自定义模型ID（`Unknown model ID`）。必须核对用户显式/原生默认模型与ACP实际选择；不匹配则发送前走headless，不能悄悄换模型。协议试探不得在普通会话列表留下孤立空会话。
- [x] 核对原有 AGY 524 累计错误修复在两条路径上的行为；不再把 headless 专用累计诊断补丁套到无关协议。
- [x] 运行 ACP 与 Antigravity 直接关联测试、server 类型和范围规范；受控真实新建/续聊/读回/取消通过后提交。ACP范围语句88.51%、分支81.22%、函数88.04%、行92.45%。
- [x] 更新 `native-dialogue.md`、`architecture.md`、`cli-observability.md`；提交 `feat(antigravity): 接入 ACP 原生交互通道`。

## P03：问题、MCP 表单与授权链接

文件：新增 `packages/shared/src/conversation/interaction.ts`、`apps/server/src/chat/interactions.ts`、三适配器 `interactions.ts`、`apps/web/src/features/chat/InteractionCard.tsx`；修改 `events.ts`、`protocol.ts`、`contracts.ts`、`turn-manager.ts`、现有恢复服务、chat reducer/state/events、MessageItem 与时间线。

接口：`UserInteraction` 区分 `questions`、`form`、`url`；`InteractionAnswer` 区分提交、拒绝、取消。共享交互服务 `requestInteraction(owner, request)` 支持 owner 为 turn、session、nativeOperation，绑定已认证的宿主连接/操作身份及原生运行实例，不能仅依赖客户端传入ID。`AgentTurnInput.requestInteraction` 是回合包装，P02创建会话前的ACP request-scoped表单和P08无活动回合的OAuth使用操作包装。宿主交互ID与原生RPC requestId分开；新增 `interaction.respond` 客户端消息与 request/resolved 事件。题目最多 4 个，每题选项最多 20，表单最多 20 字段，单次答复最多 16 KiB；超限明确结束请求。

- [x] 核心回归先行：错误所属连接/运行实例/owner/request、重复/迟到答案拒绝；无活动回合的操作表单也能回答；单选、多选、自由输入、必填与秘密字段正确；中断、原生撤销、退出释放等待。
- [x] Claude 将 AskUserQuestion 的答案按原生 `answers` 写回；只声明已核实的 `onUserDialog` 种类，未知 dialogKind 不回答（SDK明确禁止把取消冒充用户关闭）；当前 supportedDialogKinds 为空，refusal_fallback_prompt 核查移交P10；`onElicitation` 仅映射已支持结构。
- [x] Codex 接 `item/tool/requestUserInput`，按 question.id 返回 answers；校验 threadId/turnId/itemId；尊重 isBlocking，不凭时间自动选择答案。
- [x] AGY ACP 按协商的 elicitation 扩展接入；无扩展时显示原生文字问题，不能伪造成功提交。明确协议来源与降级状态。
- [x] MCP 表单支持字符串、布尔、有限数值、单/多选与原生约束；不支持的组合 schema 拒绝。URL 仅允许原生返回的 http/https，用户点击才打开，不读取浏览器凭据。
- [x] 各协议单独映射结束：Claude AskUserQuestion提交使用allow＋updatedInput.answers，取消用deny；Claude MCP/ACP elicitation使用accept/decline/cancel；Claude onUserDialog只声明已验证的supportedDialogKinds，未知不回答并由原生按期限处理；Codex requestUserInput只有answers，取消先用隔离实验验证空answers的跳过语义，不支持时明确中断所属回合，不能发送虚构action字段。ACP批准使用用户选择的原生optionId，取消为cancelled outcome；session/cancel同步取消全部待批请求。
- [x] URL请求的“已打开/已提交”与“原生授权完成”分开；按原生elicitationId/loginId匹配完成或撤销。回合外请求不随普通turn.finished被删除。
- [x] 接入背景会话和断线恢复；秘密答案不进入消息历史、查询缓存或恢复日志；失效卡片保留“已取消/已回答”状态。
- [x] 验证 shared、turn manager、recovery、三交互适配、reducer/store 与组件相关测试；深浅主题、键盘及窄屏验证。
- [x] 更新需求/界面/原生对话文档；独立审阅通过，阶段提交 `feat(chat): 承接原生提问与交互表单`。

阶段边界：阻塞问题和标准表单已接通，独立审阅通过。Claude 专用拒绝回退对话与 Codex 计划模式入口在 P10；Codex 默认异步问题的结构化卡片/追加答复在 P05；真实 MCP 连接及 OAuth 状态闭环在 P08。CLI 合成模型已验证 Claude/ACP 正式 runner 的提问与取消、Codex 显式 Plan 模式的提交与空 answers 取消；未访问外部账号服务。

## P04：图片与文件上下文

文件：新增 shared `attachments.ts`、server `chat/attachments.ts`、`http/chat-attachments.routes.ts`、web `ComposerAttachments.tsx`、`MessageAttachments.tsx`；修改三 CLI 输入与历史 mapper、协议/恢复/草稿状态；复用现有认证和目录边界。

接口：`ChatAttachment` 包含宿主生成 ID、展示名、类型、大小与媒体种类，不由网页指定服务器路径。上传接口返回不透明 ID；发送按同一工作区、会话所有者与 revision 取得资产；新会话绑定已认证页面的临时conversationId，原生ID返回后在服务端原子绑定。`AgentTurnInput.attachments?` 是已验证内容；原生适配器分别转换为 SDK 内容块、Codex image/data URL或显式文件引用 或 ACP ContentBlock。历史媒体由已验证原生会话/消息的媒体定位器获取，不接受网页提供任意路径或URL；继承父会话/子代理归属检查。

- [x] 核心回归先行：伪 MIME、过大文件、数量超限、文件名路径/ADS、不同会话偷用 ID、重复提交、上传取消；纯图片可发送，图片不支持时不清草稿。
- [x] 实现选择文件、粘贴图片、拖放、缩略图与删除；每条最多8个附件（其中最多4张图片）、每个文件5 MiB、总计20 MiB，原生更小预算优先。大字节经上传接口，不进入WS恢复日志；含媒体原生RPC上限32 MiB，其余保持原预算，超限明确拒绝且不截断。
- [x] 普通文本/PDF/其他文件按各原生支持形成文档内容或明确文件引用；不默默转换成摘要、不执行上传文件，不宣称模型必然能读所有格式。
- [x] 附件使用独立缓存，上限 256 MiB；待发送资产24小时过期，原生已保留内容的预览缓存7日未访问回收，运行中固定租约。必须用隔离续聊证明原生媒体已自持久化才回收；若原生仅保存本机路径，对应资产固定引用，容量满拒绝新上传并提示，不能自动删掉仍用于续聊的文件。回收预览不能破坏原生续聊。
- [x] 实现历史图片回放与工具图片的支持范围；未知格式保留说明，不直接把远程 URL 自动下载成本地内容。
- [x] 增量验证附件路由/服务、三输入/历史映射、草稿切换/恢复及组件；隔离浏览器实测粘贴/拖放/预览/纯图片发送。
- [x] 更新媒体存储边界、界面和需求；提交 `feat(chat): 支持原生图片与文件上下文`。

P04 实现细化（2026-11-11）：上传采用独立有界 HTTP 二进制接口，使用已完成 WebSocket 恢复握手的页面身份校验，不把恢复令牌放在图片 URL。图片预览通过鉴权 fetch/blob；发送仅携不透明资产 ID 和 revision，并再次检查工作区、CLI、临时会话/原生会话拥有者。图片限制尺寸与像素预算，浏览器解码失败保留错误，不把文件扩展名当真实格式。

Claude/Codex 已由真实合成模型验证内联图像保存及进程关闭后续聊；Codex使用image/data URL输入时thread/read也返回图片，而localImage历史只保留原路径，因此新上传图片采用内联输入。旧原生localImage仅通过已验证会话返回的定位读取，无法取得或已删除时明确提示。通用文件路径引用固定缓存，不按图片自持久化证据删除；实际使用内联内容的资产才进入可回收预览期。

## P05：排队与原生引导

文件：新增 shared `followups.ts`、server `chat/followup-queue.ts`、web `FollowupQueue.tsx`；修改 turn manager、recovery、三运行时、chat-store、Composer。若既有大文件超出复杂度门槛，提取发送/追加处理，不顺带重构无关功能。

接口：`chat.followup` 包含 `turnId`、唯一 `clientMessageId`、`mode: queue|steer` 与内容；队列编辑/取消用 ID 与 revision。`TurnHandle.steer?(input)` 返回原生受理状态。状态至少区分 queued/dispatching/accepted/unknown/failed/cancelled；同一ID绑定内容摘要，重连时返回既有结果，异内容复用ID拒绝。原生受理确认丢失时标记unknown并暂停该发送，不能自动重试或改为新回合；有权威原生echo/receipt时再收敛。不把 HTTP/WS 送达当原生收到。

- [ ] 核心回归先行：首次消息尚无 sessionId、后台切换、重连重发去重、回合完成竞争、队列满、取消/失败暂停、修改模式/模型边界。
- [ ] 实现服务端有界队列和编辑/删除/清空；每会话 10 条、全宿主 100 条。绑定创建会话身份，成功结束顺序推进；失败/停止暂停，完整退出不持久自动重发。
- [ ] Codex 默认异步问题按 agentMessage delivery=async/questions 显示可回答卡片；以稳定原生消息/问题身份投递答案作为追加输入，重复答复去重、后台归属和结束后续接都验收，不发送不存在的RPC答复。
- [ ] Codex 原生引导使用当前 threadId 与 expectedTurnId；原生回合已结束时保留输入并提示，没有自动降级排队。
- [ ] Codex透传稳定clientUserMessageId，但不凭该字段假定原生幂等。队列、去重与暂停记录绑定恢复owner＋会话而非创建它的旧turn；队列非空/投递未决时不随旧turn五分钟记录回收。队列清空且全部确认后保留去重回执30分钟，上限每owner1000条；超限拒绝新追加，不提前删除未决记录。
- [x] Claude SDK隔离调度实验完成：now中断原请求；next在工具边界可合入同轮，但本轮直接结束时另起新轮；later为原生下一轮。当前只开放宿主可控“排队发送”，不把priority包装成保证同轮的引导，也不将尚可取消的队列提前送入原生。
- [ ] AGY ACP 验证重复 session/prompt 的 steering 与完成归属，headless 保留宿主排队。兼容路径不提供未经证明的引导入口。
  - 1.5.3隔离实测：第二次prompt用于引导时，原prompt请求会提前返回end_turn；最终输出与usage由新的prompt请求收尾。因此工作台回合完成门必须跟随最新受理的prompt，旧请求返回不能结束整个回合；覆盖多次引导与取消竞争。
- [ ] 图片/文件随队列持有租约，提问等待与权限等待不被排队覆盖；更改下一条模型/权限不偷偷改变正在执行的引导消息。
- [ ] 验证 queue、turn manager、recovery、三 adapter/runtime 与 store/composer；实测连续排两条、引导竞争、停止后不继续发送。
- [ ] 更新交互与生命周期规则；提交 `feat(chat): 区分排队发送与原生回合引导`。

### P05 前端接线（实现与验证完成，待独立复核）

- [x] 运行中默认排队、即时证据下显式引导、独立停止；模型/强度/技能作为下一轮选择，权限仍受运行锁保护。
- [x] 列表编辑/移除/清空/继续，unknown 确认仅移除记录；自动新轮与后台消息按独立尝试 ID 重建并去重。
- [x] 异步问题实时/历史去重、结束后及后台回答、错误恢复，保持 Composer 草稿独立。
- [x] 队列 File 与页面预算、可信 session 绑定、失效保留及显式重传、恢复草稿保存当前输入与 P04 备份。
- [x] 26 文件 231 项关联测试、125 项范围覆盖、web 类型/规范/构建及 1280/390 深浅浏览器验证；细节和失败事实见本地 p05-web-report.md。
- [x] 整合服务端验收与修复；初始独立审阅 Needs fixes 的 R1–R4 已修复，P10 UI 复查完成异步问题组件复杂度拆分。原始审阅结论保留，待原审阅者复核；P10 的可选协作模式字段不属于本次前端范围。

## P06：子代理与原生后台任务

文件：扩展 shared `subagents.ts`；新增 Codex/AGY `subagents.ts`，扩展 Claude 任务事件映射；修改 session providers/routes、SubagentHistoryDialog、session API 与右侧详情。

接口：`SubagentSummary` 保存原生 ID、父 ID、可用角色/状态；`SubagentRead` 增加摘要且兼容既有 agentIds。读取始终从已验证父会话枚举，页游标不暴露任意路径。P01的会话级`RuntimeControl.stopTask(id)`仅用于同运行实例确知的原生任务ID；任务事件通过会话级通道传递，不要求父turn仍存在。

### P06a：摘要与独立历史（已实现，待修复项复核）

- [x] 核心回归先行：伪父子关系、其他项目、嵌套/循环/超量、内部review/compact任务、活动历史读与迟到结果。
- [x] Claude 保留 SDK 原生分页，首条 parent_agent_id 建立同根关系；背景 task_id 与 SDK 子 ID 在隔离 profile 核实相同。当前任务状态缺失时保持未知。
- [x] Codex 从父历史 subAgentActivity.agentThreadId 发现子线程，同时核实 parentThreadId 与 source.subAgent.thread_spawn.parent_thread_id、depth；元数据通过后才按 thread/turns/list(full/asc) 分页读取。不依赖返回空子列表的普通 thread/list；拒绝内部记录与未知别名。
- [x] AGY 使用真实 invokeSubagent.subagents/results 描述和身份，交叉核实 parentConversationId/rootConversationId/nestingDepth/workspaceUris。新增活动快照专用只读方法，原管理 checked 的空闲/非子代理保护保持生效。
- [x] 三 CLI 共用摘要、独立对话/轨迹、嵌套返回、分页、刷新与媒体定位；根 session 固定，每次查询只沿已核实原生边向下读取。子正文/用量不并入父会话，异步问题只读展示，不伪造续聊或停止。
- [x] 关联测试、受控三 CLI 正式 provider 只读验证及1280/390深浅主题/键盘/图片/分页验证；修复浏览器实测发现的嵌套弹窗 Escape 冒泡。结果见 p06a-report.md，早期失败与修复记录保留。
- [x] 更新原生对话、统计与界面事实；阶段提交由主线程独立审阅后执行。

P06a 初审为 Needs fixes，发现 Claude 完整期限及 Codex/AGY 失效兄弟传播两项重要问题；已先复现后修复并定向验证，保留初审报告，待同审阅者复核后关闭，不预先追认审阅通过。

### P06b：会话级原生后台任务（实现与定向验证完成，待修复项复核）

- [x] 补任务通知/状态；只有原生任务标识和当前实例归属可核实时提供单任务停止。
- [x] Claude 任务状态、单任务停止、实例与工作区租约、父回合结束后的查看/停止、刷新恢复及有界退出清理。
- [x] 子代理提问/批准先核实本实例父子关联后归属父会话，拒绝任意子线程 ID。
- [x] 验证会话运行状态、后台租约、刷新恢复、取消清理，并联动 P05 完成门和队列生命周期。
- [x] 更新后台任务事实；保留原始审阅 Needs fixes 和 P06b 修复报告，待原审阅者复核后再将整项 P06 标为审阅完成。

## P07：Skills、规则、Hooks 与代理定义

文件：新增 shared `settings/native-management.ts`、server `native-management/{service,types,errors}.ts`、三 CLI `configuration/skills.ts`；扩展 `configuration/resources.ts` 与 native resource 服务；新增 web `NativeSkillsPanel.tsx` 并接入现有 NativeResourcesDialog。

接口：`NativeManagementContext={agent, projectId?}`；`NativeSkillEntry` 包含稳定来源 ID、原生名称、scope、origin、状态与可执行 actions。`readSkills(context)`、`changeSkill(context,{id,revision,action,value?})` 仅修改枚举过的资源。共享 action 返回状态，不强制三者拥有相同动作。

- [x] 核心回归先行：同名技能跨用户/项目/插件、托管只读、符号链接/路径越界、revision冲突、无禁用能力的技能。
- [x] Claude 使用原生 `skillOverrides` 的 on/name-only/user-invocable-only/off，保留作用域和默认继承；插件技能通过所属插件管理。
- [x] Codex 使用已核对的 skills/config/write，按原生 path/name身份；保存后重新读目录确认启停结果。
- [x] AGY 仅对原生清单可控制的技能提供 include/exclude；CLI私有与Shared目录不显示虚假禁用开关，保留编辑/来源说明。
- [x] 复用既有规则/技能创建和编辑，增加原生自定义代理与Hooks入口；本地技能导入只接受用户选定目录内普通文件，限制大小/层数，不运行安装脚本。删除只作用于用户拥有的目标并二次确认，插件/系统目录不能当独立技能删除。
- [x] 创建、导入、编辑、启停后刷新原生能力；运行中写操作互斥，失败保留用户草稿。
- [x] 成功或部分写入后同时重载或失效受影响的闲置原生实例，下一轮不能复用旧工具集合；通过会话级 withIdleAgent 判断忙碌，P06 的后台任务租约继续接入同一判断。P08/P09沿用这一规则，不能只刷新页面目录。
- [x] 验证管理服务、资源边界、各CLI配置、组件与能力失效；更新 native-configuration/界面；实现、验证与独立复核完成；阶段提交 `feat(skills): 按原生作用域管理技能与定制资源`。

已核实边界：结构化状态写入只对 Claude 2.1.317、Codex 0.166.0、AGY 1.5.3 开放；未核实版本保留自有文件管理。Claude 内建技能缺可靠离线清单，继续使用原生 /skills；AGY 复杂继承/路径过滤与同名名称排除转原文入口，不伪造路径级开关。原文入口、完整本地目录导入和确认删除已实现。

2026-11-11 审阅修复：Claude Skills 目录中的 @skills-dir 插件根与原文入口统一只读；AGY 清单选择器独立使用目录身份，保存后由原生目录确认；刷新区分未编辑状态与带原 revision 的真实草稿。模型表单的整个连接/原生文件/回滚事务进入一次维护租约，包括仅改 AGY Key，忙碌保留 409。定向回归及同版本真实隔离验证已通过；独立复核关闭全部问题。保留初审未通过事实。

## P08：MCP 配置与运行状态

文件：新增三 CLI `configuration/mcp.ts`、server `native-management/mcp-service.ts`、独立 `http/native-mcp.routes.ts`、web `NativeMcpPanel.tsx` 与管理 API；扩展 P07 契约及现有维护锁。HTTP 保持相同 native-management 路径前缀，分文件避免管理类别相互耦合。

接口：`NativeMcpEntry` 返回来源、作用域、transport、启用状态、脱敏配置及可用动作；`readMcp(context)` 为离线读取，`checkMcp(context,id)` 为显式连接。`saveMcp(context,{id?,revision,config})`、`operateMcp(context,{id,revision,action})` 处理指定来源；秘密字段使用保留/替换/清除动作，不回传旧值。

- [x] 核心回归先行：读取不启动MCP；URL/headers/env秘密遮蔽；重复名称作用域不同；修改外部更新冲突；部分失败后重读；托管/插件带入资源不误写。
- [x] Claude 用户/个人项目使用原生命令维护，项目 .mcp.json使用已支持安全事务；不整体改写混合状态文件。SDK运行态用于状态/重连/启停，区分运行态与持久配置。
- [x] Codex 持久配置保留TOML未知字段与注释；状态用 mcpServerStatus/list 分页，重载用 config/mcpServer/reload；不调用用户工具作为连接测试。
- [x] AGY 使用原生配置安全JSON事务落实 add/remove/enable/disable 的已核实语义（避免秘密进入命令参数），标明全局/项目/插件来源；若没有可验证的运行状态接口，返回“配置已存在，未检查”而非“已连接”。
- [x] 提供添加 stdio/http/sse（按原生支持）、编辑、删除、启停、显式检查和支持的重连；参数为结构化数组，不提供任意shell命令执行接口。诊断只返回固定安全类别。
- [x] Codex MCP OAuth 实现支持的原生跳转/完成通知，保持请求ID和取消；实际第三方账号授权留用户操作，不自动代登。无法保密提交的凭据路径必须保留高级配置入口，不在进程参数或日志中暴露明文秘密。
- [x] 区分持久配置维护锁与运行实例内控制：配置CRUD占CLI空闲维护锁；已有会话的状态/OAuth/重连使用该实例的窄控制租约，不等待其正在等待授权的回合结束，避免死锁。操作身份与运行代次绑定，原生实例销毁同步取消交互；新增实例的显式检查必须经过原生读活动锁，不能与CLI安装并发。
- [x] 验证三配置适配、鉴权/Origin、维护锁、敏感字段和组件；使用合成 stdio/http MCP 服务验证连接/失败/取消，外部请求为零。
- [x] 更新原生配置与界面；实现与自审完成，待独立审阅及主线程阶段提交 `feat(mcp): 管理原生服务配置与连接状态`。

实证细化（2026-11-11）：Claude 2.1.317 `mcp login --no-browser` 在 pipe stdin 下明确要求交互终端，本轮不新增 ConPTY 依赖，保留原生终端指引与 P03 SDK URL 请求通道。Codex OAuth 无 cancel RPC，采用独立有界 app-server 并绑定运行代次，取消只关闭授权进程。Codex 无线程状态原生返回 null 时只报告工具目录与未知运行状态；AGY 原生 list 已确认安全文件保存的配置/disabled 生效。Claude user/local add-json 无配置 stdin，含 URL/参数/秘密的写入保留高级入口；项目安全文件可完整编辑。Codex 插件清单可能联网，普通离线列表不调用，所属资源从插件管理入口处理。真实第三方账号、托管环境、AGY独立连接状态不记为已验收。

独立审阅修复（2026-11-11）：R1 运行登记绑定规范化 cwd，枚举/控制/绑定OAuth核对当前目录；操作先取项目活动租约再重读目录，后台OAuth租约覆盖至原生进程退出，与换目录竞争有明确裁决且不等待回合结束。R2 插件 sourceId 纳入原生scope及规范化安装根，entryId和revision随来源区分，路径不外泄。四项新增回归已先红后绿，7文件27项定向验证及覆盖门槛通过；原独立审阅暂不通过结论保留，待复核关闭。

## P09：原生插件管理

文件：新增三 CLI `configuration/plugins.ts`、server `native-management/plugin-service.ts`、web `NativePluginsPanel.tsx`；复用 CLI 安装任务的有界执行/取消模式，不复用其包名判断。

接口：`NativePluginEntry` 包含原生身份、来源、scope、版本、enabled及支持动作；`preparePluginOperation(input)` 返回服务器生成operationId、确切来源/动作/影响，不提前执行安装。Claude没有安装dry-run，首次start收到原生shownCommand时转awaiting-confirmation，展示命令及sha256后以同operationId继续；`startPluginOperation({operationId,revision,confirmation?})` 按该操作ID幂等受理并可读取终态。同操作重复请求返回原任务，变更参数拒绝；原生已启动而确认丢失记结果未知并重读，不能重新安装。客户端不能传任意可执行程序或shell。

- [x] 核心回归先行：同名不同市场/作用域、原生要求二次确认、错误revision、恶意来源/命令参数、部分安装、取消和关闭设置后继续跟踪。
- [x] Claude 使用 plugin list --json、install/enable/disable/update/uninstall；原生 shownCommand.sha256 确认与对应操作绑定，禁止无条件 --yes；卸载默认 --keep-data。
- [x] Codex 使用 plugin add/list/remove 与 marketplace 命令；普通 GET 读配置与安装缓存，config/read 核对托管/信任层；指定 Git 市场显式刷新后才调用限定 marketplace 的 list，本地源没有 upgrade；插件启停按原生 plugins.<name@marketplace>.enabled与托管层判断。官方明确不用于生产的 plugin RPC 不调用；市场刷新与插件更新不混为一谈。
- [x] AGY 使用 plugin list --json、install/uninstall/enable/disable/validate；没有已确认独立更新命令时不给“更新成功”假按钮，也不先卸载再重装来冒充更新。
- [x] 页面提供实际支持的列表、详情、安装来源、启停、卸载与更新/验证；列表离线来源不足时，显式“刷新来源”才允许联网。插件所带Skills/MCP标明从属关系。
- [x] 对原生支持的市场来源提供列表/添加/移除/指定来源刷新；不预装来源。Claude 插件 configure 读取配置需求，inputs/default 不回填，配置另有带宿主密钥的 revision 防止外部修改后覆盖，秘密值通过 values-stdin 写入；AGY 缺变量时保持原生待配置状态，不能自动启用。
- [x] 所有任务复核实际安装结果、失效相关能力与资源；错误可能部分写入时同样重读。运行/维护互斥，取消有界清理子进程。
- [x] 受控CLI夹具验证命令参数、原生确认、失败与恢复；真实验证只在隔离profile安装本地合成插件，不能碰用户插件或擅自访问付费/私有市场。
- [x] 原生配置/架构/界面文档已更新；独立审阅通过后由主线程提交 `feat(plugins): 接入各 CLI 原生插件管理`。

P09 实测修订：Claude plugin list 会返回其他项目的安装记录，插件/Skills/MCP 共用 projectPath 与规范化当前目录过滤；Codex 本地 marketplace upgrade 原生拒绝，因此仅 Git 来源显示刷新。任务在原生退出、真实重读和能力失效结束后才发布终态，取消与生成命令确认竞争时不会重新进入等待。验收证据与保留的初次失败见本地 p09-report.md；未进行真实第三方市场、账号授权或管理员策略环境验收。

## P10：专用操作与遗漏复核

文件：按实际能力扩展各 CLI capabilities/runtime与原生资源；新增必要的专用操作小模块，不添加通用RPC透传。同步本节能力清单与长期文档。

接口：已有 `NativeInvocation` 扩展明确的命令变体；每个变体有自己的输入schema、原生方法与完成事件。检查点预览/执行分离，执行只能使用原生返回的可回退位置和本次预览身份。

- [x] Claude 核查拒绝回退专用用户对话，仅声明已验证结构；Codex 提供原生 plan/default 协作模式入口，按协商能力启用 experimental 字段并保留原生设置。
- [x] Claude 文件 checkpoint/rewind 提供预览和明确确认后的原生回退，不恢复未追踪文件。
- [x] Codex review/start 与本机支持的历史回退按明确目标执行；会话历史回退和文件撤销分别预览、确认。
- [x] AGY ACP 可用斜杠命令按动态目录提供；不将 headless 无法执行的界面命令改写成提示词。
- [x] 对计划/后台终端、原生任务、外部编辑器/浏览器/MCP Apps、音频/实时、远端/云会话、账号计费和自动化逐项登记已接入、限制、未验证、待决或范围边界。
- [x] 可确定且可验证的遗漏已实施并补充子任务；会改变产品范围/存储承诺/授权方式的事项列入最终决策表，不阻塞其他任务。
- [x] 验证 P10a-d 专用操作适配及受控状态恢复；后台终端 helper/runtime control已接，范围测试继续中；更新 capability矩阵初稿。P11再作独立审阅和全范围核对。
- [x] 更新能力矩阵、需求与界面事实；最终独立审阅完成后提交 `feat(native): 补齐已核实的原生专用操作`。

### P10d：回复实际模型提示（已实现并定向验证）

- [x] 核对三 CLI 逐条回复字段；只将响应本身返回的有效标识作为实际响应模型。Codex/AGY 无可靠逐回复字段，矩阵明确记录不支持且不推测。
- [x] Claude 助手消息底部低强调显示实际“响应模型”；未知不显示，用户输入/工具条目不重复，历史模型变化不误合并。
- [x] 核心映射、消息合并和隔离正式 runner 验证；纳入 P10/P11 独立审阅。

### P10e：原生后台终端与持续目标（终端已接入，目标由原生 CLI 管理）

- [x] 隔离实测后台终端 list/terminate/clean 与 goal get/set/clear；验证同运行实例/重启边界、自动回合、暂停和清理语义。
- [x] 后台终端接入同一 RuntimeControl 与会话任务面板；停止/清理复核原生结果，限制于原 app-server，不与独立 shell 混同。
- [x] 实现刷新、分页、失联和终态处理；遵守用户决定不接管 active goal 生命周期，续聊前保留原生状态安全检查。
- [x] 界面、定向测试、隔离实机和能力矩阵完成；RuntimeControl 接线及 goal 守卫纳入 P11 独立审阅。

## P11：终验、审阅与整合

- [x] 逐行回看用户需求与P00–P10，每项均有代码、隔离证据或明确保留原因；active goal 与定时任务按用户决定由各原生 CLI 管理，账号/OAuth 暂缓。
- [x] 独立审阅整条功能分支及合并前追加差异，重点检查队列/跨 owner 答复、媒体与附件所有权、子代理来源和后台租约、原生回退确认、真实能力误报。合并前确认的子轮请求 owner、终端错误分类、MCP 子目录身份、技能删除恢复及聚合分页快照均已修复并独立复核；无待关闭 P1/P2。
- [x] shared/server/web/desktop 及脚本类型、分支范围规范/格式、文档导航、重复率通过；核心覆盖率按模块达到既有门槛。分支及关联回归 105 文件、953 项通过；新增分页边界后会话范围 5 文件、28 项通过，重叠数量不相加。
- [x] 网页独立 outDir 与桌面构建通过；各阶段已完成深浅/窄屏/键盘、导航与恢复、交互/附件/队列/管理页的隔离验证，本轮补审仅复验受影响范围。真实本机三 CLI 连接合成服务的分项证据见能力矩阵，不替代用户模型与第三方 OAuth 验收。
- [x] 侧栏工作区会话默认显示当前顺序前10条，独立展开/收起，保留当前旧会话并在会话搜索时显示全部匹配项；项目行数明确为已加载投影。12条列表、展开收起、当前旧会话和搜索行为测试通过。
- [x] 对照原有模型/权限/会话管理、CLI 更新与 AGY 运行路径，关联回归通过；SSH 实现未变，保留既有入口与历史验收结论，不重复远端连接，也不将既有失败改记为通过。
- [x] 迁移有效约束到需求、界面、架构、原生对话/配置与路线图；P05/P06 审阅状态及 active goal 续聊守卫已同步。
- [x] 用户于 2026-11-12 明确要求“审查后合入 main”；完成复核与阶段提交后，以 `--no-ff` 合入本地 main 并保留大功能分支。推送、升版本和打包不在本次授权范围。
- [x] 最终交付以能力矩阵、路线图、下方待决清单和本地 Git 记录为准；保留原生限制、外部验证失败和暂缓项。发布、包版本和真实账号授权分别决定。

## 资料与证据

### 关联验证命令

每项新增核心测试先运行并观察到预期失败，再实现；通过后不因更新文档重跑。以下列出任务必须覆盖的测试集合，新增路径与任务实现同时建立，不是要求复制整套既有测试。

| 任务 | 测试入口（仓库根执行 `npm.cmd test -- <入口>`） |
|---|---|
| P01 | `packages/shared/tests apps/server/tests/agents/claude/capabilities.test.ts apps/server/tests/agents/codex/capabilities.test.ts apps/server/tests/agents/antigravity/capabilities.test.ts` |
| P02 | `apps/server/tests/agents/antigravity` |
| P03 | `apps/server/tests/chat/interactions.test.ts apps/server/tests/chat/turn-manager.test.ts apps/server/tests/http/ws-recovery.test.ts apps/server/tests/agents/claude/interactions.test.ts apps/server/tests/agents/codex/interactions.test.ts apps/server/tests/agents/antigravity/acp.test.ts apps/web/tests/features/chat/interaction.test.tsx` |
| P04 | `apps/server/tests/chat/attachments.test.ts apps/server/tests/http/chat-attachments.routes.test.ts apps/server/tests/agents/claude apps/server/tests/agents/codex apps/server/tests/agents/antigravity/acp.test.ts apps/web/tests/features/chat/attachments.test.tsx` |
| P05 | `apps/server/tests/chat/followup-queue.test.ts apps/server/tests/chat/turn-manager.test.ts apps/server/tests/http/ws-recovery.test.ts apps/server/tests/agents/claude apps/server/tests/agents/codex apps/server/tests/agents/antigravity/acp.test.ts apps/web/tests/features/chat/followups.test.tsx` |
| P06 | `apps/server/tests/sessions apps/server/tests/agents/claude/subagents.test.ts apps/server/tests/agents/codex/subagents.test.ts apps/server/tests/agents/antigravity/subagents.test.ts apps/web/tests/features/sessions/subagents.test.tsx` |
| P07 | `apps/server/tests/settings/native-management.test.ts apps/server/tests/settings/native-resources.test.ts apps/server/tests/settings/model-settings-access.test.ts apps/web/tests/features/settings/native-skills.test.tsx` |
| P08 | `apps/server/tests/native-management/mcp.test.ts apps/server/tests/http/native-management.routes.test.ts apps/web/tests/features/settings/native-mcp.test.tsx` |
| P09 | `apps/server/tests/native-management/plugins.test.ts apps/server/tests/http/native-management.routes.test.ts apps/web/tests/features/settings/native-plugins.test.tsx` |
| P10 | `apps/server/tests/agents/claude/native-actions.test.ts apps/server/tests/agents/codex/native-actions.test.ts apps/server/tests/agents/antigravity/acp.test.ts apps/web/tests/features/chat/native-actions.test.tsx` |

预期：所选文件全部通过，无意外跳过核心用例。现有路径若因目录布局不同，先查实际测试并修订本表；不能用“没有测试文件”当通过。每阶段另跑 `npm.cmd run typecheck`、改动文件的 ESLint/Prettier 与 `npm.cmd run docs:check`；公共共享协议变更扩大至所有消费者。最终 `npm.cmd run dup`、网页独立 outDir 构建和 `npm.cmd run build:desktop`，不打安装包。

计划中的“真实隔离”指实际本机CLI连接合成服务，不是只让假runner返回成功；具体协议fixture及证据写入忽略目录，并在对应任务记录通过范围。

- [Claude SDK 输入模式](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、本机 SDK 类型与 CLI 隔离帮助。
- [Claude Skills](https://code.claude.com/docs/en/skills)、[MCP](https://code.claude.com/docs/en/mcp)、[插件](https://code.claude.com/docs/en/plugins)。
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)、本机 0.166.0 生成的 JSON schema；插件RPC的官方生产使用限制优先于schema存在性。
- [AGY headless](https://antigravity.google/docs/cli/headless/)、[ACP](https://antigravity.google/docs/cli/acp/)、[ACP完整指南](https://antigravity.google/docs/ide/extensions/acp/)、本机1.5.3隔离握手。
- 原始帮助、schema、官方正文与受控记录放本轮忽略目录；不提交开发机路径、隔离凭据或会话正文。

## 计划自审与独立审阅

- [x] 覆盖核查：用户列出的插件、Skills、MCP、图片、提问、排队/引导、子代理逐项对应任务，其余原生能力在P10明确收口。
- [x] 接口核查：能力→ACP→交互/附件→队列→恢复共享字段一致；资源管理身份→配置写入→任务执行→缓存失效一致。
- [x] 证据核查：原生声明、受控模拟、真实隔离运行、真实外部服务四类区分；AGY ACP不沿用headless的功能缺失结论。
- [x] 审阅五类风险均有对应测试步骤；未增加镜像实现的测试或开发机固定路径。
- [x] 独立审阅通过，可以开始P01。4项重要问题已修订：后台任务的会话级生命期与运行时失效；无活动回合的交互归属及原生取消映射；引导/插件操作受理去重和未知结果；附件预算、所有权与原生历史媒体回收。修订后文档检查通过。

## 最终待决策清单

以下仅登记真实需要用户选择的事项，执行中持续更新；可由技术判断决定的实现细节不转嫁用户。

| 编号 | 事项 | 已准备的可审阅结果 | 需要用户决定 | 状态 |
|---|---|---|---|---|
| D01 | 新版本安装包、签名与发布 | 本轮完成后填写源码范围和验证 | 是否制作/发布及版本 | 保留 |
| D02 | 真实账号与第三方OAuth现场授权 | 产品入口完成后填写支持范围 | 用户自行登录/授权及要验证的服务 | 按既有要求暂缓 |
| D03 | Codex 持续自主目标 | 隔离实测证明 active 与 resume active 会触发多轮模型请求；pause不取消当前轮 | 是否在工作台接管 goal 管理 | 用户决定由原生 Codex 管理；AgentDeck 不加管理面板，仅保留续聊安全检查 |
| D04 | 跨窗口定时任务 | 三 CLI 的定时能力依赖各自 CLI、桌面或云端宿主；AgentDeck 没有常驻调度器 | 是否要求 AgentDeck 关闭后仍负责调度、审批和通知 | 用户决定由各原生 CLI/宿主管理；AgentDeck 不接入持续调度 |
| D05 | MCP Apps 交互界面 | MCP Apps 可让 MCP 服务提供交互式界面资源；当前 AgentDeck 仅接工具调用与文本/结构化结果，没有嵌入此类远端界面 | 是否需要在 AgentDeck 中承载 MCP 服务提供的交互界面，以及允许的隔离与权限范围 | 待理解后决定 |
| D06 | 实时音频对话 | 本地 CLI 路径没有完成音频设备、权限及会话闭环验证 | 无 | 用户明确表示不需要，不纳入 |

新增限制先判断是否原生不支持；技术不可实现项进入能力矩阵，不伪装成等待用户审批。
