# 三 CLI 原生能力矩阵

基础核查日期：2026-11-12。证据基线为 Claude Code 2.1.317 / Agent SDK 0.3.286、Codex 0.166.0、Antigravity 1.5.3。本文记录各项能力及验证范围，后续 AGY 上下文修订见[统计口径](cli-observability.md)。阶段记录见[历史追溯](decisions.md#历史追溯)。

## 判定口径

| 标记 | 含义 |
|---|---|
| 已接入 | 工作台有对应入口或事件映射，原生负责执行；下文限定已经验证的路径 |
| 管理已接入 | 在原生允许的来源和作用域内提供列举、创建/导入、编辑、启停或删除等实际动作；只列目录不计入 |
| 部分接入 | 一部分流程可用，列出的限制仍存在 |
| 待接入 | 已发现可验证的原生接口，尚不能按已交付功能使用；继续跟踪技术实施 |
| 协议限制 | 当前版本或运行路径没有所需能力，或还没有可靠执行证据；不伪造入口 |
| 范围待定 | 会增加账号授权、持久调度、媒体采集或新的宿主执行环境，需要明确产品范围 |

证据分为协议声明、本机隔离运行和外部服务验收。“原生实测”指本机 CLI 连接合成服务，验证协议与接线；模型质量、视觉理解及第三方授权需由外部服务验收确认。CLI 升级后按变化复核。

## 对话与原生运行

| 能力 | Claude Code | Codex | Antigravity |
|---|---|---|---|
| 原生对话、续聊与历史 | **已接入**：SDK 执行与原生历史读取，正文仍由 CLI 保存 | **已接入**：app-server 的 thread/turn/item，按原生身份恢复 | **已接入**：ACP 对话及原管理协议读历史；保留 headless 兼容路径。ACP 实际模型与用户选择不符时，在发送前选择兼容路径，不暗换型号。E01 |
| 图片、文件与历史媒体 | **已接入**：图片及已验证的文本文档/PDF内容块，原生保存后可读回 | **已接入**：内联 image 输入及原生历史；普通文件使用明确路径引用，不假称所有文件内容直接内联 | **部分接入**：ACP 图片已传输/续接验证；resource 文件上下文实际转成路径引用。headless 保留文件引用，不支持图片输入。公共类型/大小/归属预算仍生效。E02 |
| 主代理提问、MCP 表单与授权链接 | **已接入**：AskUserQuestion、已支持结构的 elicitation；专用 `refusal_fallback_prompt` 未取得真实 payload/取消证据，未声明支持 | **已接入**：计划模式的阻塞问题；默认模式异步问题以追加输入回答；MCP 表单/URL分别跟踪完成与撤销 | **已接入**：ACP `elicitation/create`、原生批准及取消；headless 不承接交互问题，批准需求由原生软拒。E03 |
| 运行中追加与待发队列 | **部分接入**：可见队列、编辑/清空/恢复；SDK priority 的实测边界不能保证同轮引导，因此没有“引导本轮” | **已接入**：宿主队列及 `turn/steer`，校验 expectedTurnId 与原生 clientId，未知受理不自动重发 | **部分接入**：ACP 支持队列和同轮引导，按最新 prompt 完成门结束；headless 只用宿主队列。失败、结果未确认、停止、失联或阻塞答复时暂停队列。E04 |
| 子代理独立历史与嵌套关系 | **已接入**：SDK 子代理 ID、消息、分页与独立媒体 | **已接入**：父活动发现子线程，再核验双 parent、cwd、depth；普通列表不保证枚举全部子线程 | **已接入**：父 `invokeSubagent.results` 定位子轨迹，核验 parent/root/depth/workspace。三者只读历史均与父正文、统计和分叉入口分离。E05 |
| 子代理运行状态、批准与停止 | **部分接入**：本宿主实例任务状态、父回合结束后的批准、`stopTask`；原生前/后台子代理禁用 AskUserQuestion | **部分接入**：核实后的活动子 turn 可中断，父结束后仍能批准；默认子代理未开放异步问题工具 | **协议限制**：保留独立历史与整轮取消，尚无经验证的单子任务停止协议。不得把历史记录当活动任务。E05 |
| 原生工具创建的后台终端 | **已接入**：后台 Bash 属于会话任务，原生终态后释放维护租约，父回合结束不丢失停止控制 | **已接入**：固定到同一 RuntimeControl/app-server；分页有界、读取失败保留活动租约、停止需原生确认并复读列表、每5秒检查自然终态。新实例不能接管旧终端。E10 | **部分接入**：命令调用、输出和原生轨迹可展示；尚未证实独立后台终端枚举/单项停止的公开 ACP 入口。E05、E10 |
| 计划与执行模式 | **已接入**：原生 plan 权限模式及计划工具事件；模式语义沿用 Claude | **已接入**：显式 default/plan，通过 `collaborationMode/list` 核对并协商实验字段；不为触发问题自动换模式 | **部分接入**：原生模式/模型配置映射与 ACP `/plan`；计划内容由 CLI 执行和返回，不复制原生提示词。E09 |
| 长期目标 | **原生 CLI 管理**：可由原生技能/代理工作流执行；本轮不另建 goal 管理器 | **原生 Codex 管理**：active 与 resume active 会触发自主回合，pause 不取消当前轮；用户决定由原生端管理。AgentDeck 仅在续聊前检查 active 并阻止普通回合，不显示或控制 goal。E10 | **原生 ACP 命令**：`/goal` 分派已验证，可产生多次请求并支持整轮取消；持续生命周期由原生 CLI 管理。E09、E10 |
| 专用代码审查 | **部分接入**：通过原生技能和普通对话审查；没有假造 Codex 式 review RPC | **已接入**：`review/start` inline，默认审查未提交改动，或使用明确目标；不伪装普通提示词发送 | **部分接入**：原生工具、技能和差异记录继续显示；未另造 IDE 专用审查面板。E09 |
| 文件回退、历史回退与分叉 | **已接入**：原生文件 checkpoint 的 dryRun 预览与确认后 rewind；保留会话历史，部分恢复如实显示。分叉是独立会话操作 | **已接入**：持久普通 turn 的 `thread/revert` 预览/确认；删所选轮及以后历史，保留工作区文件。review展示turn没有可靠边界时不可回退 | **部分接入**：沿用已验证的原生会话管理动作；ACP压缩产生的 checkpoint 不等于可执行文件撤销。没有新增未经验证的回退按钮。E09 |
| 工具执行、审批、压缩与用量 | **已接入**：原生工具/公开思考/批准、compact/context与范围明确的用量 | **已接入**：命令、文件、MCP、搜索、计划、协作活动及compact；未知统计不补造 | **已接入**：ACP工具/计划/批准与已验证的compact；headless/历史统计采用各自口径。详见[统计说明](cli-observability.md) |
| 每条回复的实际响应模型 | **已接入**：取 `stream_event.message_start.message.model` 与历史助手 `message.model`；未知或合成占位不显示 | **协议限制**：公开 agentMessage/Turn 没有响应型号；Thread.model 明确是配置而非执行遥测，路由事件也不证明每条回复的服务端型号 | **协议限制**：ACP model配置与headless init.model是所选型号；历史modelUsage为内部枚举，metadata显示名不证明实际响应。E11 |

## 原生配置与扩展管理

“管理已接入”仅适用于原生允许编辑的资源。插件、托管、同步或无法验证的来源仍遵守各自只读/继承规则；不能为三个 CLI 强造同一种开关或两层作用域。具体参数只在[原生配置](native-configuration.md)维护。

| 能力 | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Skills | **管理已接入**：自有技能创建、完整目录导入、编辑、确认删除；skillOverrides四态及默认继承。插件技能转所属插件，内建离线来源不明时保留原生入口 | **管理已接入**：路径身份的发现/状态/创建/导入/编辑/删除及 `skills/config/write`，写后forceReload核对有效状态；启停不伪造项目层 | **管理已接入**：普通用户/项目技能及清单排除；私有/Shared目录不受exclude控制，只提供原生确实支持的文件操作。复杂清单保留原文。E06 |
| MCP持久配置 | **管理已接入**：local/user/project各原生作用域CRUD、脱敏和启停；混合状态文件沿用原生命令 | **管理已接入**：用户/受信任项目配置CRUD、enabled和工具筛选，保留高级字段与托管约束 | **管理已接入**：用户/项目配置CRUD、disabled和工具配置；原生命令及字段按AGY解释。页面列表不隐式联网。E07 |
| MCP运行状态与OAuth | **部分接入**：SDK状态、工具、重连与运行启停；独立 `mcp login` 实测需TTY，保留原生终端指引 | **已接入**：分页状态、线程连接复用、重载及独立OAuth流程；完成通知才算授权完成 | **部分接入**：原生配置/禁用识别与检查；没有虚构的 `mcp auth`，缺独立公开授权控制时保留原生入口。真实第三方OAuth未验收。E07 |
| 原生插件及市场 | **管理已接入**：安装/卸载/更新/启停/校验/配置；按原生作用域管理市场。安装命令确认与凭据只写保留 | **管理已接入**：CLI add/remove、配置启停和市场管理；Git市场刷新不冒充单插件更新。官方禁止生产调用的plugin RPC未使用 | **管理已接入**：安装/卸载/启停/校验；未伪造update或任意市场管理。缺变量/认证时原生不可用状态保留。E08 |
| 规则、Hooks与代理定义 | **管理已接入**：各settings层、规则和agents原文，来源/范围可见 | **管理已接入**：规则、hooks.json、config.toml代理声明与agents原文，保留信任限制 | **管理已接入**：rules/hooks/agents及discovery清单原文，复杂继承不简化。三者均由CLI解析执行，工作台不另建执行器。E06 |
| 模型、思考强度与权限 | **已接入**：原生目录/默认值、所选模型和支持的effort及权限模式，高级项原文保留 | **已接入**：model/list、effort、批准与sandbox语义；计划模式独立于权限模式 | **部分接入**：原生模型/变体/effort与权限；ACP按实际目录校验，客户端不支持的第三方模型不可伪装解锁。详见[模型能力](model-capabilities.md) |
| 原生命令 | **部分接入**：原生Skills、compact/context及已有等价网页操作；其他目录条目显示未接入，不统一当提示词发送 | **部分接入**：已验证的compact、review及模式/管理等价操作；不存在的命令不造RPC | **部分接入**：动态ACP目录与本机会话目录同时校验，只开放 compact/plan/grill-me/learn/browser/goal；schedule列出限制。headless不借用ACP专用命令。E09 |
| CLI安装、版本与更新 | **管理已接入** | **管理已接入** | **管理已接入**：三者复用已有版本管理与维护锁；当前核查不自动升级，安装包发布另行决定 |

## 宿主外工作流

下表区分本机 CLI、桌面端、IDE 扩展和云端各自提供的功能。

| 能力 | Claude Code | Codex | Antigravity |
|---|---|---|---|
| 外部编辑器 / IDE | **部分接入**：CLI读取和修改当前项目；用户可另开编辑器，但外部窗口、选区和diff审查不由本工作台管理 | **部分接入**：workspace文件工具和外部原生编辑器并存；未嵌入VS Code/Codex客户端或提供IDE双向选择同步 | **部分接入**：ACP原生设计给IDE客户端使用，AgentDeck展示协议事件；不控制IDE窗口、编辑器选区或其他ACP客户端。E12 |
| 浏览器 | **部分接入**：原生工具/插件可按CLI配置使用；不读取或接管用户已登录浏览器状态 | **部分接入**：已显示原生web search和工具轨迹；不承接Codex产品的浏览器交互客户端 | **部分接入**：动态ACP `/browser` 由原生代理执行，工作台显示会话事件；不提供独立浏览器录制/窗口控制。E09、E12 |
| MCP Apps交互界面 | **协议/运行环境待核**：本机SDK类型有条件的tool UI元数据，不等同于AgentDeck已承载外部`ui://`应用 | **协议已声明，工作台未承载**：Codex schema有MCP App资源URI/显示模式字段；当前界面未加载远端UI资源或提供完整隔离执行容器 | **协议/运行环境待核**：本轮未取得并验证ACP中可承载MCP App UI的宿主扩展；MCP服务配置管理不等于嵌入App。E13 |
| 音频 / 实时语音 | **不纳入**：用户不需要实时音频；当前CLI运行路径也未核实语音会话协议 | **不纳入**：schema虽列出`thread/realtime/*`方法，本轮不建设录放界面 | **不纳入**：ACP报告`audio=false`，且用户明确不需要此功能 |
| 远程 / 云会话 | **范围待定**：官方支持Web/Cloud/Remote Control及`--teleport`，是账号和原生远端执行生命周期；当前集成本机CLI会话，不创建云会话或把云数据并入本地历史 | **部分接入**：当前集成本地app-server `stdio://`。官方另有remote TUI/app-server与云端环境，但工作台未把它们接成会话host，也不接受任意远程主机凭据 | **范围待定**：Remote Control使用Antigravity原生远端产品；当前ACP/headless工作在本机目录，不作透明远端代理。E15 |
| 账号 / 计费 | **本机原生登录**：登录状态由CLI和用户账户决定；AgentDeck不创建/退出订阅账号，不显示账单、权益价格或代扣方式 | **本机原生登录**：协议有account、rate limit与usage读取表面，但本功能分支没有接入通用账号/账单页；原生额度/响应不等同于AgentDeck推算费用 | **本机原生登录**：Google 原生登录或 API Key 按原生方式工作，模型目录及工作台显示范围分别保存；官方账号可手动读取原生 `/usage`，不读取 API Key 服务商的用量、个人账单或完整订阅信息。真实对话和 OAuth 兼容性分别验证。E16 |
| 自动化 / 定时任务 | **原生 Claude 管理**：session Cron/Create 依赖 CLI 进程、空闲时机和项目身份；Cloud/Desktop scheduled task 属于其他宿主。AgentDeck 不提供跨应用调度 | **原生 Codex 管理**：active goal 不是 cron；Codex 应用 Automations 也不由本机 CLI adapter 管理。AgentDeck 不接管持续目标或定时任务 | **原生 CLI 管理/生命周期未验证**：ACP目录可出现 `schedule`，但 AgentDeck 未验证其恢复、取消和跨进程寿命，也不接管调度。E10、E17 |

## 证据索引

以下报告存于本机忽略目录，阶段结果见 `b1ec36f:docs/plans/native-capability-parity.md`。

| 编号 | 证据 |
|---|---|
| E01 | `p10-acp-production-report.json`：本机AGY 1.5.3 ACP真实三轮、同一session和历史读回；ACP实际型号与配置限制见早期ACP审计 |
| E02 | `p04-production-report.json`、`p04-native-images-report.json`、`p04-headless-files-report.json`及P04历史读回报告：三CLI图片/文本文件分别按实际原生路径验证 |
| E03 | `p03-report.md`、`p05-web-report.md`、`p06b-report.md`：阻塞/异步问题、表单、批准及子代理限制分开验证 |
| E04 | P05 Claude/Codex/ACP steer生产报告与P05网页报告：同轮引导取决于原生调度，队列独立且unknown不重发 |
| E05 | `p06a-report.md`、`p06b-report.md`及对应Claude/Codex/AGY真实隔离子轨迹报告 |
| E06 | `p07-report.md`与Skills原生验证报告：来源、作用域、托管限制及规则/Hooks/代理定义操作 |
| E07 | `p08-report.md`及Codex OAuth、Claude登录边界和AGY MCP验证报告 |
| E08 | `p09-report.md`：真实隔离CLI插件管理、安装结果核对和未验证的第三方服务范围 |
| E09 | `p10-implementation.md`、`p10-audit-report.md`与P10动态ACP目录/回退报告：本轮专用命令、模式、review与回退 |
| E10 | `p10e-native-audit-report.json`、`p10e-goal-lifecycle-report.json`：Codex终端同实例控制；goal自动轮次、暂停/预算及active resume的实测顺序 |
| E11 | `p10-response-model-report.json`、Claude响应模型生产验证、Codex本机experimental schema及AGY合成ACP轨迹 |
| E12 | 三CLI正式runner事件、ACP协议与本机界面能力边界；没有外部编辑器或已登录浏览器控制凭据 |
| E13 | Codex 0.166.0 app-server schema、Claude SDK类型及当前映射代码；没有MCP App资源加载/渲染闭环 |
| E14 | Codex experimental schema中的`thread/realtime/*`方法及AGY `audio=false`真实ACP握手；未接音频设备 |
| E15 | [Claude Code overview](https://code.claude.com/docs/en/overview.md)、[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Antigravity ACP](https://antigravity.google/docs/cli/acp/)；这些产品/协议文档不代表AgentDeck远端接线完成 |
| E16 | Codex app-server account schema；Claude/AGY本地配置及CLI文档；本轮未访问真实订阅账户或读取账单 |
| E17 | [Claude scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks.md)、[Antigravity schedule](https://antigravity.google/docs/commands/schedule/)；AGY schedule未标验证通过。Codex goal实测见E10 |

### 本机实现入口

| 证据主题 | 当前代码入口 |
|---|---|
| 原生响应与轨迹映射 | [Claude mapper](../../apps/server/src/agents/claude/run/mapper.ts)、[Codex mapper](../../apps/server/src/agents/codex/run/mapper.ts)、[Antigravity mapper](../../apps/server/src/agents/antigravity/run/mapper.ts)、[ACP runtime](../../apps/server/src/agents/antigravity/acp/runtime.ts) |
| 子代理与后台任务 | [Claude tasks](../../apps/server/src/agents/claude/run/tasks.ts)、[Codex child tasks](../../apps/server/src/agents/codex/tasks/tasks.ts)、[AGY subagents](../../apps/server/src/agents/antigravity/history/subagents.ts)、[Codex background terminal helper](../../apps/server/src/agents/codex/tasks/background-terminals.ts) |
| 专用命令、审查与回退 | [Claude native actions](../../apps/server/src/agents/claude/history/native-actions.ts)、[Codex native actions](../../apps/server/src/agents/codex/history/native-actions.ts)、[Codex history actions](../../apps/server/src/agents/codex/history/history-actions.ts)、[AGY ACP commands](../../apps/server/src/agents/antigravity/acp/commands.ts) |
| Skills、MCP、插件和规则 | [Native configuration](native-configuration.md)及其列出的三CLI配置适配器；状态/隔离验收见E06–E08 |
| 本机协议类型 | Claude使用当前安装SDK的`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`；Codex 0.166.0 schema由本机app-server `generate-json-schema --experimental`生成；AGY依据ACP initialize和本机CLI/管理协议。schema与SDK声明只说明字段/方法，不代替E索引中的真实隔离执行证据 |

## 需要产品选择

1. 是否承载 MCP Apps：MCP 服务除返回工具结果外，还可提供 `ui://` 交互界面资源；AgentDeck 目前没有加载这类远端界面的隔离容器与动作授权桥接。

用户已决定 Codex goal 和各 CLI 定时任务由原生端管理，AgentDeck 不接管；实时音频对话不纳入本轮计划。

Codex 后台终端清单和停止使用同一 RuntimeControl，active goal 检测与续聊守卫已接入；审阅和验证结果见路线图。
