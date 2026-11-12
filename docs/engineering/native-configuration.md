# 原生配置与启动环境

以各 CLI 的原生文件与加载规则为准。常用模型设置通过表单直接修改用户原生文件，完整文件仍可从高级入口编辑；是否信任项目、是否启动 MCP、如何合并规则和权限仍由 CLI 决定。

Codex 自定义服务的“凭据获取方式”分别对应直接令牌、环境变量名和原生认证。直接填写会写入原生配置中的明文令牌；环境变量只配置变量名，值由 CLI 启动环境提供；原生认证沿用 Codex 的 ChatGPT 或 API Key 登录。`requires_openai_auth = true` 时原生忽略 `env_key`，表单也按这一优先级显示，普通模型修改不清除两者原文。凭据命令、网关 OAuth、AWS 或 Authorization 请求头继续走高级配置保护。依据：[认证说明](https://learn.chatgpt.com/docs/auth#alternative-model-providers)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 配置入口

“会话读取”开关显式登记或移除固定 `agentdeck_sessions` MCP。Claude 使用原生 `mcp add-json/remove --scope user`；Codex 精确修改用户 `config.toml` 的同名 `mcp_servers` 项；Antigravity 修改 `~/.gemini/config/mcp_config.json`，将 `read_session` 标为 eager。其他 MCP、权限与批准项保留，同名非自有配置或版本冲突时拒绝覆盖。

`GET/PUT /api/session-tools/:agent` 读状态及按 revision 更新。保存与运行器重新加载均在该 CLI 空闲锁内完成，运行中返回忙；下轮对话使用新配置，独立运行的原生客户端仍按自己的加载机制生效。入口固定工作台配置目录及三种 CLI 的原生历史根目录，避免跨 CLI 调用时继承了调用方临时 profile；不把认证变量写入 MCP 项。开发模式用 Node/tsx 的绝对入口，桌面分发使用独立 `session-tools.mjs` 与 Electron Node 模式，均不依赖用户工作目录。

便携版退出时会删除解包目录，不能把其中的可执行文件和脚本登记为长期 MCP 入口。因此便携版提供明确的安装版引导并禁止启停写入，也不注册默认系统协议；工作台内部的复制和链接跳转仍可使用。安装版和开发源码目录支持登记，目录移动后需要在原生 CLI 中处理失效的旧入口。

| CLI | 设置 | 规则与技能 | MCP 和原生插件 |
|---|---|---|---|
| Claude Code | 用户 settings.json；项目 .claude/settings.json 与 settings.local.json | CLAUDE.md、CLAUDE.local.md、条件回退 AGENTS.md；原生 rules/skills 目录 | 项目 .mcp.json；用户及个人项目 MCP 使用原生命令，避免编辑混合状态文件；插件管理使用原生入口 |
| Codex | 用户 config.toml 和受信任项目 .codex/config.toml | AGENTS.md/AGENTS.override.md、Starlark .rules、.agents/skills | MCP 保留在对应 TOML；插件由原生管理器维护 |
| Antigravity | 全局 .gemini/antigravity-cli/settings.json | AGENTS.md/GEMINI.md、.agents/rules/skills 及官方共享目录 | 全局与项目独立 mcp_config.json、hooks.json 和定制发现清单；不制造项目 settings 层 |

用户配置根尊重 Claude 的 CLAUDE_CONFIG_DIR 和 Codex 的 CODEX_HOME；Codex 共享 Skills 的用户目录仍是 ~/.agents/skills。项目与子目录按真实来源标注，列表不会把工作台当前选择解释成原生最终生效顺序。

原生插件不同于工作台插件。原生配置页提供各 CLI 实际支持的插件生命周期和 MCP 管理，全部原文入口保留；不直接改写插件安装缓存，也不把需要交互的 TUI 命令当作普通模型消息。

## 原生插件管理

“原生插件”按 CLI、实际来源、作用域、版本和启用状态列出安装记录，支持详情、安装、卸载和原生启停。Claude 使用原生 install/update/enable/disable/uninstall/validate/configure，卸载固定保留数据；Codex 使用 add/remove 和 marketplace 命令，启停只定点修改所选原生 plugins 配置字段；Antigravity 使用 install/uninstall/enable/disable/validate，不伪造独立更新。未知 CLI 版本、来源、托管资源或未能唯一核实的 Codex 安装缓存保持只读。

Claude 原生列表会跨项目返回记录，插件、Skills 和 MCP 共同按当前规范化目录与原生 projectPath 过滤项目/个人项目安装。Codex 普通 GET 联合本地配置和安装缓存读取目录，并通过 config/read 的原生层级判断托管及项目可信状态；不调用生产禁用的 plugin RPC，不自动调用可能联网的 plugin list。显式刷新 Git 市场后只对指定市场调用原生 list；本地 Codex 市场没有 Git 刷新按钮。Claude 支持按 user/project/local 增删市场及指定来源刷新，未知作用域不开放写入。Antigravity 没有自定义市场管理入口，也不预装来源。

prepare 仅生成宿主 operationId 与来源、动作、作用域和影响预览，不执行安装。Claude 没有 dry-run，首次 start 收到原生 shownCommand 后进入“等待命令确认”；用户核对全文与 SHA-256 后以同 operationId 继续，只有准确摘要通过 --accept-command 传入原生，不使用无条件 --yes。同一执行代次重复 start 返回原任务；参数或摘要变化拒绝。进程异常或部分失败重读真实状态并标记结果待核对，不重启安装。关闭设置可恢复同一宿主中的任务；宿主重启后旧操作 ID 不再执行，必须重新核对原生状态。

所有操作持有 CLI 空闲、原生维护和项目空闲租约至进程退出与能力失效结束，开始前复核项目目录和 revision。取消清理整棵原生进程树；单次安装命令预算 120 秒、输出 512 KiB，命令确认最多等待 10 分钟，预览 15 分钟过期。终态及部分失败都会失效能力与会话缓存并回收闲置实例，任务最多保留 100 条、24 小时。Claude 配置只展示需求和已配置状态，秘密与默认值不回填；通过 values-stdin 写入，未填写项保留。配置另有带宿主密钥的摘要校验，外部修改后拒绝覆盖，任务结束/取消/过期后清除待写值。Antigravity 缺变量时保留原生禁用状态，并引导到原生面板配置。

接口为 `GET /api/native-management/:agent/plugins` 及 `POST .../detail`、`.../prepare`、`.../start`、`.../operation`、`.../cancel`，继承本机会话鉴权、Origin 与 no-store。客户端只能选择固定动作和来源，不接受任意程序或命令参数。

## Skills 与定制资源管理

“原生配置与扩展”按 Skills、MCP、原生插件、规则 / Hooks / 代理定义分类，保留全部原文入口。Skills 列表以服务器枚举的来源身份、原生名称、作用域、目录与配置 revision 为准；同名资源分别显示，客户端不能提交任意本机路径替换身份。列表不含技能正文，也不会调用模型或执行技能、Hooks、MCP 工具。

| CLI | 技能状态与写入 | 保留边界 |
|---|---|---|
| Claude | skillOverrides 支持 on、name-only、user-invocable-only、off，另有“默认继承”删除所选层覆盖；用户、项目、个人项目设置分别选择 | 原生按技能名生效，同名来源共享设置；插件技能只读并转所属插件管理。同步与托管技能不直接删除；托管策略仍可覆盖本机设置 |
| Codex | skills/list 原生路径身份，skills/config/write 仅写所选绝对 SKILL.md 路径；之后 forceReload 重读同 cwd 并核对 effectiveEnabled | 开关写入 Codex 原生用户配置，不伪造项目启停层；插件、管理员、内置及未验证外部来源只读。项目可信状态不因保存而改变 |
| Antigravity | 普通用户 config/skills 与项目 .agents/skills 可使用各自 skills.json 顶层 exclude；选择器取真实目录名，展示名独立保留，写后重新读取原生目录确认 | 私有 antigravity-cli/skills 和 Shared skills 不受清单排除控制，提供自有文件编辑与确认删除。复杂 entries/inherits/路径过滤以及目录名冲突保留原文，避免把目录名称排除伪装为单一路径开关 |

Claude 已安装插件技能由有界 `plugin list --json` 加安全目录读取发现，不刷新市场、不执行插件。原生插件根身份保留到技能来源；个人或项目 Skills 目录中的 `@skills-dir` 插件，其根 SKILL.md 与原文入口同样只读，不作为普通自有技能独立启停或删除。离线资源扫描也检查 `.claude-plugin/plugin.json` 标记，避免原生目录暂不可读时误开放写入。没有可靠离线来源的 Claude 内建技能不编造目录或开关，仍由原生 `/skills` 管理；这与完整管理自有本地技能的范围分开。未知版本或原生目录读取失败时显示“未核实”，不把失败当作未安装或完整支持。

自有 Skills 仍可新建与编辑 SKILL.md；“导入本地技能目录”由浏览器选择整个目录，将普通文件及二进制资料一并导入既有资源根，不接受服务器任意源路径。上限为 128 文件、6 层、每文件 1 MiB、合计 8 MiB，SKILL.md 另限 256 KiB 与有效 UTF-8；不运行安装脚本。暂存目录组装后一次更名，已有目录不覆盖。删除需明确确认整个目录，revision 覆盖支持文件；隔离后的复核失败会保留外部更改并恢复原位置，原位置已被占用等情况保留隔离内容并报告结果待核实。插件、托管、同步及链接来源不提供删除动作。

Hooks 与代理定义继续编辑原生文件：Claude 的 hooks 位于各 settings 层，代理定义来自 agents 目录；Codex 的 hooks.json、config.toml agents 声明及 agents/*.toml 保留来源和信任说明；Antigravity 的 hooks.json、agents.json 与 agents 下原文保持原生作用域。Markdown 代理正文只验证编码和大小，真实语义与执行仍由 CLI 负责，不自建运行器。

写操作依次取得 CLI 空闲租约、原生进程维护锁、项目空闲租约，再进入文件事务。普通原生目录读取与 CLI 安装互斥；同一操作内部不重复取锁。资源保存、创建、导入、删除及启停成功或可能部分写入的失败都会失效能力与会话缓存，并回收对应 CLI 的闲置运行实例，下轮重新读取资源；活动回合不被管理操作强制打断。后台任务的长期占用由会话级运行控制统一接入这一空闲判断。未编辑的设置随刷新同步；真实草稿按所选范围保留值和开始编辑时的 revision，外部更新后不会自动改绑新 revision，可明确放弃草稿并采用最新设置。正文仍由原文编辑器单独保护。

模型表单把连接环境保存、原生文件提交、冲突回滚和最终失效放在同一个用户配置维护租约内；内部使用已持有租约的窄写入口，避免重复加锁。Antigravity 仅改 API Key 而原生 JSON 不变时同样遵守此边界。忙碌保存返回安全的 409 agent_busy，不能误报为磁盘读写故障。

技能目录接口为 `GET /api/native-management/:agent/skills`，写操作使用 `POST .../change` 与 `POST .../import`，均继承本机会话鉴权、Origin 检查与 no-store；请求只接受服务器返回的资源 ID、revision、限定动作与实际作用域。

## 模型与服务连接

模型与连接页顶部选择 CLI，表单按服务连接、模型和运行参数排列。常用字段使用同一套输入控件，认证变量和原始文件收进高级设置；只有表单内容滚动，保存按钮固定。表单仍修改原生配置，不另存模型默认，也不读取 CC Switch 数据库。

| CLI | 表单写入 | 认证与地址 |
|---|---|---|
| Claude | model、modelPicker.options 中选中模型的 label、effortLevel；别名映射收进高级设置 | 原生 env 中的 ANTHROPIC_BASE_URL 与 API Key/Auth Token；账号登录由 CLI 管理 |
| Codex | model、model_provider、服务商 name、model_reasoning_effort、整数 model_context_window、model_auto_compact_token_limit | 自定义 provider 的 base_url 与 Responses 协议；直接填写 Key 使用 experimental_bearer_token，原生高级认证保留 |
| Antigravity | model、modelProvider、自定义模型的 label/modelName/maxTokens | 同页配置 Gemini API URL 与 Key，分别映射 GOOGLE_GEMINI_BASE_URL、GEMINI_API_KEY，经加密启动环境交给新进程 |

三者共用模型输入、缓存候选和“获取模型”操作。工作台分开保留 CLI 选择值、显示名称和底层真实型号；模型入口显示具体型号，名称仍可用于搜索，发送时使用原始选择值。Claude 的 `[1m]` 后缀在匹配模型能力时单独处理，不会从发送值中删除。推理强度优先采用模型目录报告，未报告时只按已核对的精确型号补全；未手动选择时省略覆盖参数，有适用的默认值则显示其档位，否则仅保留强度图标；这不等于原生 `auto`。Claude、Codex 与 Antigravity 的档位不能互相套用，详细表见[模型身份与推理强度](model-capabilities.md)。 Claude 的名称仍是 picker label，Codex 的名称仍是服务商名称；Claude 持久默认可写 low/medium/high/xhigh，max 仅用于会话。Antigravity 默认强度仍通过模型变体表示，不写不存在的顶层 effort 字段。

上下文窗口按实际语义显示：Codex 可写数字 token 上限，自动压缩阈值独立填写 token 数并写入原生 model_auto_compact_token_limit，留空移除该覆盖；Antigravity 自定义模型写 maxTokens；Claude 默认显示“由模型决定”。Claude 的条件性网关窗口覆盖与压缩阈值继续留在原始配置，不自动关闭压缩，也不将压缩阈值冒充模型窗口。

Codex 的 provider、端点与认证放在用户配置。当前原生版本会忽略项目 .codex/config.toml 中的这些字段，不能把项目表单当作有效服务商切换。已有高级认证命令、认证请求头、云认证以及内置服务商保持原生配置；简单 Key 表单不能覆盖。TOML 使用 AST 范围修改指定字段，保留注释、未知表、换行和 BOM；不能安全修改的结构转原文编辑，不整体重新序列化。JSON 表单保留未知字段、缩进与换行习惯。

`/api/settings/models/:agent` 返回允许的字段及密钥存在状态；界面用圆点占位，输入新值替换、清除按钮删除。秘密值不回填或进入模型缓存，空输入保留旧值。Claude/Codex 遵循原生文件格式；Antigravity URL/Key 从同一表单保存到启动环境，使用原生文件与环境的复合 revision，原生写入冲突时恢复本次连接改动。

保存后，新的 CLI 进程读取更新文件；当前会话显式模型、托管规则或原生更高优先级配置仍可能覆盖默认值，运行中的进程不会被强制切换。服务端与前端同时清理对应 CLI 的模型能力缓存，并拒绝旧刷新结果回填；下一次打开菜单按原生接口重新发现。

Antigravity 的 `customModelsConfig.customModels` 是对象映射，每个条目使用稳定键、裸 `modelName`、`label` 和可选 `maxTokens`。原生默认 `model` 保存 label，条目键也可用于显式 `--model`。保存模型选择时复用隔离的原生目录，把内置 ID 转成 label；未知服务型号自动登记自定义条目，不要求先填显示名或窗口。目录读取失败时保留用户输入，有明确自定义连接时仍可登记。

本机 agy 1.5.1 的 headless 默认选择自定义模型时可能返回空模型；工作台仅在未显式选择且原生默认命中自定义条目时补充 `--model` 键。读取采用本轮启动环境与原生配置，准备期间可取消；显式模型保持优先。此适配不修改外部 CLI 程序，也不表示其独立 headless 默认选择问题已修复。

服务地址唯一写入启动环境 `GOOGLE_GEMINI_BASE_URL`，不会再把地址拼进 `modelName`；读取旧的 `gemini-api://.../models/...` 条目时提取模型 ID，保存时标准化。提交的地址去掉末尾 `/v1beta`，由原生 CLI 添加版本路径，避免重复。已有环境地址优先，旧 URI 的地址只在环境没有显式值时迁移，用户明确停用时不恢复。仅 Gemini 模式使用这些条目，不能把 OpenAI Responses 地址当作 Gemini 地址。旧数组形式的说明已纠正，历史可从 `5d5d0c6` 追溯。

模型目录按 CLI 与实际目录持久缓存，成功结果在应用重启后继续使用；用户可点击重新获取，填写过配置时明确显示“保存并获取模型”。设置 GET `/api/settings/models/:agent/catalog` 只读缓存，POST 使用原生接口获取；不会探测任意服务的 /v1/models 或发送对话。Claude 使用 supportedModels，Codex 使用 model/list 并补入原生当前自定义 ID。模型列表是否列全由原生协议决定，始终允许手输。

窗口和 token 阈值文本框接受整数或十进制简写，例如 `128K`、`1M`、`1.5m`；K 为 1,000，M 为 1,000,000。保存时精确转换成原生整数，读取仍回显原生数值；空白恢复默认，负数、溢出或换算后不是整数的值拒绝保存。这里是输入格式便利，不改变各 CLI 对窗口、压缩和 maxTokens 的定义。

Codex 的自动压缩计数口径 `model_auto_compact_token_limit_scope` 和较新版本的轮末压缩百分比 `model_post_turn_compact_threshold_percent` 仍可从原始配置编辑；前者不等于窗口大小，后者不是普通自动压缩阈值的替代。常用表单不改写这些未选择字段。依据为[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)和本机 app-server 的 ConfigReadResponse schema。

## 读取与编辑边界

`GET /api/native-resources/:agent?projectId=...` 只返回已知文件与有界目录的元数据。显式打开使用 `POST /api/native-resources/:agent/:resourceId/open`，此时可能返回文件中的敏感字段；正文只在编辑器局部状态保存，不进入公共查询缓存或浏览器持久存储。

文件保存使用同一资源路径的 PUT，请求携带原文和 revision。接口按真实文件格式检查 JSON/TOML；Markdown 和 Starlark 文本只检查有效 UTF-8 与大小，后者的语义交给原生 CLI。固定资源根内可以创建规则、代理定义文件或 SKILL.md，不接受任意文件路径。

正文上限 256 KiB；目录扫描总预算 4096 项、深度上限 6 层。拒绝符号链接、路径越界和已被外部修改的文件；读取失败和不存在分别显示。兼容的两文件配置接口与新接口共用路径写入队列，防止并发覆盖。

## 启动环境

`/api/settings/launch-environment/:agent` 只显示变量来源与状态，写入不回显已有值。每种 CLI 的白名单单独定义；禁止 PATH、NODE_OPTIONS、PYTHONPATH 等改变加载行为的变量。所有显式值以当前 Windows 用户的 DPAPI 密文保存，无法使用系统加密时不退回明文。

| CLI | 允许的变量 |
|---|---|
| Claude | ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ANTHROPIC_BASE_URL |
| Codex | OPENAI_API_KEY、OPENAI_BASE_URL |
| Antigravity | GEMINI_API_KEY、GOOGLE_GEMINI_BASE_URL、AGY_ADC_AUTH、GOOGLE_CLOUD_QUOTA_PROJECT、GOOGLE_CLOUD_LOCATION |

Antigravity 的 Gemini 密钥还需要原生 `modelProvider: "gemini"`；ADC 使用 `AGY_ADC_AUTH=true`。不把 GOOGLE_API_KEY、.env 或 SDK 专用变量当作 CLI 的同等接口。

高级启动环境仍保留继承、设置和停用的原生语义，常用模型页面不要求用户操作这些状态。保存不修改全局进程环境或打断回合；新会话使用新的启动快照，已有会话可在空闲时通过高级入口重新启动 CLI。

这些变量只传给工作台新启动的进程。用户在另一个终端直接执行 CLI 时，仍使用那个终端的环境；工作台不会修改系统环境变量。设置页会标明已有工作台覆盖，避免把原生文件中的值误当作最终有效值。

## 会话权限偏好

工作台在自己的 `session-preferences.json` 中保存会话权限覆盖，与原生默认配置分开。version 1 文档保留 `archived`，增加可选 `permissions` 数组；每项只有 `agent`、原生 `sessionId` 和该 CLI 支持的权限选择，不写会话正文、标题或项目路径。旧文档缺少该数组时视为空。

归档和恢复保留权限，删除会话时清理对应记录。Claude/Antigravity 重置时移除覆盖；Codex 的显式重置保留 `native` 动作，以便续接时重新读取原生有效配置。写入沿用事务与文件身份核对，不能覆盖同时发生的其他偏好更新；记录损坏时报告不可用，不静默重建。

## MCP 配置与运行管理

“原生配置与扩展 → MCP”离线列出实际来源、作用域和持久启用状态。读取列表不运行 `claude mcp list/get`，不启动 MCP、不访问插件市场；Claude/Antigravity 使用只读已安装插件列表识别所属 MCP，插件资产只读。Codex 的原生命令列表可能访问市场，普通列表从配置和已核实安装缓存读取插件 .mcp.json，保留所属插件、实际 scope 和安装根身份；插件带入服务只读。

Claude 用户与个人项目配置由原生 `mcp add-json/remove --scope` 维护，避免整体改写混合状态文件。该命令没有配置 stdin，含 URL、参数或秘密的写入保留原生高级入口；项目 `.mcp.json` 支持 stdio、HTTP、SSE 的完整表单。Codex 用户 `config.toml` 与项目 `.codex/config.toml` 分别编辑，支持 stdio、HTTP；TOML 定点更新保留未知字段、工具策略及注释。Antigravity 全局 `config/mcp_config.json` 与项目 `.agents/mcp_config.json` 使用安全 JSON 事务，支持 stdio、HTTP 和原生 `disabled`；避免把秘密放入 CLI 参数，也不把全局命令当项目命令。

秘密仅写：URL 只显示 origin，参数不回填，环境变量和请求头只显示名称；保留、替换和清除分别提交。保存携带来源身份和 revision，冲突不覆盖外部更新，界面保留原草稿及原 revision。持久写使用 CLI 空闲维护锁并与安装、项目活动和文件事务互斥；成功或可能部分写入的失败均失效相关能力并回收空闲实例。

运行状态与持久配置分开。选择活实例后，Claude 使用 SDK 状态、重连和运行启停，Codex 使用分页 `mcpServerStatus/list` 与实例级 `config/mcpServer/reload`；操作针对所选实例中有效的同名服务，重载不是单个服务器的持久开关。没有实例时，只有显式检查才创建有界临时原生进程并发现工具，不执行工具或模型回合。Codex 无线程查询可能返回工具目录但 `runtimeStatus=null`，此时显示“无法核实运行状态”，不宣称持续连接。Antigravity 1.5.3 没有可靠的独立运行状态接口，保持“已配置，未检查”，检查与 OAuth 转原生 MCP 面板。

运行实例分别保存项目 ID、登记项目根与实际会话目录；项目子目录会话可被列出，项目换根后不显示或接受旧实例。选择实例后按其实际目录重新读取配置并显示该目录，实例视图只提供运行控制；持久修改须切回项目配置。检查、控制与 OAuth 均按实际目录核实配置身份，同名多来源无法确定对应关系时拒绝执行。控制与检查先取得项目普通活动租约再重读目录，授权操作保持租约至原生进程结束；项目换目录、删除与这些操作互斥，同时不阻塞等待用户答复的回合。插件 MCP 的内部来源身份包含原生作用域和规范化安装根，同插件同名服务跨来源不碰撞，安装路径不直接返回网页。

Codex OAuth 由独立 app-server 承载，授权链接只在用户启动后出现；成功以同一 loginId 的完成通知为准。取消、超时或所绑定对话实例退出会关闭授权进程，迟到成功无效；关闭设置后再次打开可恢复未结束操作。该操作使用原生读取活动租约，不等待正在等待授权的回合空闲。Claude 2.1.317 的 `mcp login --no-browser` 实测仍要求交互终端，管道 stdin 不可用；此入口提供原生终端指引，对话内 SDK URL 请求继续通过问题卡片处理。真实第三方账号授权由用户操作，本轮仅验证本地合成服务。

2026-11-11 隔离验证：Claude stdio/HTTP 连接与失败、user/local 原生命令增删；Codex stdio/HTTP 工具发现、线程状态与重载、OAuth 成功/失败/取消；Antigravity 原生 `mcp list` 识别配置及禁用均有实测记录。未修改真实用户 profile，未执行 MCP 工具。后台任务对维护空闲的裁决由后续子代理阶段接入，不能把当前回合结束当作所有后台任务完成。

## Antigravity MCP 工具加载

默认按原生方式加载 MCP。AGY 1.5.1 的通用工具包装未限制 Arguments 的类型；部分模型服务会返回 JSON 字符串，标准 MCP 服务要求对象而拒绝执行。可以在设置的 MCP 配置文件中，对确实需要的工具启用原生 `eager`：在已有服务器项内添加 `tools: { "read_notes": { "eager": true } }`，保留原来的 command、args、env 或地址。这会让模型直接看到该工具的完整参数定义，可能增加请求长度；不需要把所有工具改为 eager。

此选项与 `permissions.allow` 是不同配置：直接加载不代表允许执行。工作台不会自动写入用户的允许规则，也不会把返回的错误参数改成猜测值。真实工具执行仍由 CLI 按用户选择的权限处理。依据为[官方加载方式](https://antigravity.google/docs/mcp/#tool-loading-lazy-vs-eager)以及本机原生 CLI 与标准 MCP SDK 对照验收。

## 依据与验证

2026-11-05 复核了本机帮助、官方配置文档和 CC Switch 当前 Direct 实现；版本升级后按真实协议调整。

- Claude：[设置](https://code.claude.com/docs/en/settings)、[规则](https://code.claude.com/docs/en/memory)、[Skills](https://code.claude.com/docs/en/skills)、[MCP](https://code.claude.com/docs/en/mcp)。
- Codex：[配置参考](https://developers.openai.com/codex/config-reference/)、[认证](https://developers.openai.com/codex/auth/)、[规则](https://developers.openai.com/codex/rules/)、[Skills](https://developers.openai.com/codex/skills/)、[插件](https://developers.openai.com/codex/plugins/)。
- Antigravity：[设置](https://antigravity.google/docs/settings/)、[定制发现](https://antigravity.google/docs/customization-discovery/)、[MCP](https://antigravity.google/docs/mcp/)、[启动认证](https://antigravity.google/docs/install/)。
- CC Switch：[Direct 原生写入](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/live/project/codex.rs)、[agy 启动配置](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/agy_config.rs)。Direct 与代理模式不同；agy 也使用子进程环境提供 Key，不能概括为所有配置都修改真实原生文件。

使用临时目录和合成 CLI 验证读写与启动接线；真实账号、模型端点和 MCP 服务的结果仍须单独记录。当前完成程度见[路线图](../roadmap.md)。

## CLI 程序版本管理

程序安装独立于原生模型配置。工作台识别实际可执行入口及官方 npm 包身份，npm 更新只作用于对应的全局安装位置；Claude 原生更新沿用自身通道和禁止更新设置，Antigravity 使用原生更新命令。未知来源不自动改装；缺失安装按本机可用安装工具与官方安装器处理，系统权限不足时报告失败，不自动提升权限。

`GET /api/settings/cli-installation/:agent` 读取本机状态与已缓存版本，`POST .../:agent/check` 查询固定官方来源，`POST .../:agent/operations` 接收动作及状态 revision。客户端不能传入命令、URL、路径或安装版本；执行前复核安装身份。任务由后端持有，同时只允许一项安装，更新先回收对应 CLI 的空闲运行实例，阻止新回合与原生读取进入。退出应用时取消并清理本次安装进程。

完成后重新读取实际入口与版本，并检查工作台所需的原生接口。未达到目标版本、入口仍指向旧安装或接口不兼容时明确失败；可能发生部分更新的失败也会清除旧能力缓存。前端任务观察独立于设置页面，完成或失败后刷新环境与能力；网络中断或超时停止观察，重新打开可恢复状态。版本检查失败不丢掉已有本机状态，原始安装输出不进入页面。

官方依据：[Claude 安装与更新](https://code.claude.com/docs/en/setup)、[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[Antigravity CLI 入门](https://antigravity.google/docs/getting-started?tab=cli)。版本元数据与安装方式随各来源核对；已知版本不代表用户模型服务可用。
