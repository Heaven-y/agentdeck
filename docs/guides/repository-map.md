# 按功能找代码

从仓库根目录打开 `apps` 可以看到三个程序。`desktop` 负责桌面窗口、系统对话框和进程生命周期，`web` 负责工作台页面，`server` 在本机运行 CLI、管理会话和读写配置。前后端需要一起理解的数据格式放在 `packages/shared`。

## 从需求定位入口

| 要修改的内容 | 从哪里开始 | 通常还要看哪里 |
|---|---|---|
| 聊天输入、附件和斜杠补全 | [聊天输入区](../../apps/web/src/features/chat/composer/Composer.tsx) | 输入能力在聊天的 `controls`，发送后的会话状态在 `state` |
| 实时对话和历史里的消息样式 | [时间线公共入口](../../apps/web/src/features/conversation/timeline/index.ts) | 同目录的 `TimelineRowView` 管消息行，`ToolGroup` 管工具分组；[事件投影](../../apps/web/src/features/conversation/model/conversation-events.ts) 不持有会话状态。实时和历史宿主分别提供操作、附件身份及滚动／分页 |
| 聊天文件预览与长代码 | [文件预览面板](../../apps/web/src/features/chat/files/FilePreviewPane.tsx)、[工作区文件读取](../../apps/server/src/workspaces/file-preview.ts) | 链接识别在 `conversation/files`，代码折叠在 `conversation/timeline/CodeBlock.tsx`；复用现有右栏与 CodeMirror |
| AGY 主代理选择 | [主代理菜单](../../apps/web/src/features/chat/controls/MainAgentMenu.tsx) | 原生目录在 `agents/antigravity/models/main-agents.ts`，已有会话切换复用分支管理 |
| 模型的搜索、显示与选择 | [模型候选规则](../../apps/web/src/cli/shared/model-candidates.ts) | 聊天和设置各有 `models` 目录，CLI 原生差异放在前端 `cli` 子目录；AGY 官方额度读取走[原生命令](../../apps/server/src/agents/antigravity/usage/official-usage.ts) |
| 增加设置分类 | [设置页登记表](../../apps/web/src/features/settings/navigation/page-registry.tsx) | 在相应功能目录编写页面，在表中登记标题、图标、CLI 切换器和渲染组件。需要新增持久化字段时再看 [产品设置协议](../../packages/shared/src/settings/product-settings.ts) |
| 新增或调整一种 CLI | [支持名单](../../packages/shared/src/conversation/agents.ts)、[原生配置登记表](../../apps/server/src/agents/registry.ts) | 按实际能力实现该 CLI 的运行、历史和配置，接入[后端服务装配](../../apps/server/src/bootstrap/cli-services.ts)。设置、会话列表和探测使用共享身份；[Skills](../../apps/server/src/native-management/skills/adapters.ts)、[原生插件](../../apps/server/src/native-management/plugins/plugin-adapters.ts) 与[会话引用](../../apps/server/src/sessions/references.ts) 按能力分别登记 |
| 修复 CLI 安装、更新或回滚 | [安装服务](../../apps/server/src/cli-installation/service.ts) | `discovery` 识别当前安装，`native` 和 `npm` 处理对应安装方式，`transaction` 负责占用与文件保护。按钮与任务状态在前端设置的 `installation` |

## 工作台扩展

| 要修改的内容 | 从哪里开始 | 通常还要看哪里 |
|---|---|---|
| 工作台插件宿主 | [通用后端装配](../../apps/server/src/bootstrap/plugins.ts)、[页面容器](../../apps/web/src/features/plugins/PluginWorkspace.tsx) | [业务服务注入](../../apps/server/src/bootstrap/plugin-services.ts)复用原生分页；前端 `plugins` 管贡献入口、命令和事件。接口见[工作台插件](../engineering/workbench-plugins.md)，业务与 SDK 在 [agentdeck-plugins](https://github.com/Heaven-y/agentdeck-plugins) 仓库 |
| 增加工作台插件 | [静态插件示例](../../examples/workbench-plugin/agentdeck.plugin.json)、[v2 示例与 SDK](https://github.com/Heaven-y/agentdeck-plugins/tree/main/examples/project-helper) | 页面、设置、输入和会话操作从清单贡献，宿主按权限提供[插件接口](../engineering/workbench-plugins.md) |

## 测试与开发工具

在同一个工作区，把 `src` 换成 `tests`，按相同功能查找现有用例。例如，修改 CLI 占用判断可以从[占用测试](../../apps/server/tests/cli-installation/transaction/occupancy.test.ts)开始，修改一个设置分类可以从[设置页行为测试](../../apps/web/tests/features/settings/navigation/settings-page.test.tsx)开始。跨功能测试按用户进入功能的入口归档。

开发验证脚本放在 `scripts/dev`，其中 `e2e` 存放端到端检查，`fixtures` 提供本机受控数据。桌面构建产物的验证归 `scripts/packaging`。根目录保留各工具按约定读取的配置。运行命令和质量要求见[开发指南](dev-environment.md)。
