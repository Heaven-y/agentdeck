# 工作台插件

AgentDeck 从用户安装的插件包加载扩展。插件源码、依赖和业务说明在 [agentdeck-plugins](https://github.com/Heaven-y/agentdeck-plugins) 独立维护；本仓库维护插件管理和宿主接口。CLI 自己加载的插件见[原生配置](native-configuration.md#原生插件管理)。

## 插件包

插件目录包含 `agentdeck.plugin.json` 和自包含 HTML 页面，可附带根目录 README.md 和 LICENSE。页面内联脚本和样式，图片与字体使用 data URI。安装复制构建产物，不执行安装脚本。

```json
{
  "id": "project-helper",
  "name": "项目助手",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "index.html",
  "description": "显示当前项目与插件自己的设置",
  "permissions": ["storage", "project-context"],
  "commands": [{"id": "open", "title": "打开项目助手"}]
}
```

清单可选 `icon: "terminal"`，未指定时显示通用插件图标。v1 是静态页面插件。v2 支持贡献位置、宿主服务和事件；需要自己的本机服务时，同时声明 `backend: "backend.cjs"` 和 `backend` 权限。后端及其依赖打成一个 CommonJS 文件。不带后端的 v2 插件可以直接使用获准的宿主服务，不启动插件进程。有剪贴板操作时另声明 `clipboard`。宿主支持接口版本 1、2，未知版本不安装。

单包最多 10 MiB、256 个文件、8 层目录；命令最多 32 项。安装校验路径、普通文件身份和清单。v1 不接受后端；v2 只接受清单指定的后端文件。读取页面和启动 v2 后端前核对安装时保存的包摘要。

## 安装与生命周期

从左栏「插件」选择本地构建目录安装，查看声明的访问能力后启用。插件未安装时没有页面、业务路由或后端进程。

选择已安装插件的新构建目录可更新：先验证新包，停止旧服务，再替换程序。保留数据与原有启用状态；新增权限时保持停用，供用户重新启用。更新失败恢复可用的旧包。安装、启停、更新和卸载核对 registry revision。

v1 页面关闭后卸载 iframe，持久设置保留。v2 首次打开页面或调用命令时装载文档，之后随工作台保留；声明事件订阅的插件随工作台加载文档。后台命令不切换页面。隐藏页面收到可见性通知，可暂停前端刷新；本机后端仍只在首次后端请求时启动。停用、卸载与应用退出撤销页面、命令、事件和进程通道。

卸载清理安装副本，v1 同时清理页面设置。v2 保留页面设置，后端数据独立保存在 `workbench-plugins/data/<id>`，卸载程序时保留，重新安装同一插件后接续。

## 页面与宿主接口

### 贡献位置与命令

v2 使用 `contributes.pages` 声明 `{id, title, location}`，location 为 `sidebar` 或 `settings`。两处入口均打开插件自己的页面，并通过上下文 `page` 告知入口身份；设置页入口返回设置。多个入口复用一个文档和运行状态。未提供 contributes 的旧插件保留一个侧栏主页面，显式空 pages 可提供纯后台操作。

`commands` 的每项为 `{id, title, execution?, page?}`。execution 默认 `page`，可用 page 指定贡献页面；`background` 交付命令但保留当前页面。`contributes.actions` 用 `{command, location}` 把已有命令放入输入区的“扩展操作”，location 为 `composer` 或 `session`；插件管理中的“操作”菜单提供该插件全部已声明命令。宿主校验贡献 id、命令引用与页面引用。新增插件无需修改主应用的页面分支或命令表。

命令在文档就绪后仅交付一次，SDK 按顺序执行处理器。停用或更新清除未交付命令。命令携带触发时的工作台会话身份，草稿调用据此拒绝切换后的目标；读取草稿返回 revision，写入还核对会话和读取内容，避免覆盖用户新输入。插件编辑草稿后由用户发送。

页面放在 sandbox iframe；v2 允许本地表单交互，CSP 继续禁止表单导航与网络请求。页面没有主应用同源权限，不能直接调用主应用 HTTP 接口；宿主按页面来源与插件声明处理通信。启停和后端请求仍遵循主应用的访问控制。

| `window.agentdeck` 接口 | 所需权限 | 内容 |
| --- | --- | --- |
| `storage.get()` / `storage.set({value, revision})` | storage | 插件自己的 JSON 设置，最多 64 KiB |
| `project.get()` | project-context | 当前项目的 `{id, name, dir}` 或 null |
| `backend.request({method, url, body}, {signal})` | backend，v2 | 请求只发给该插件的后端，返回 `{status, body}`；支持取消 |
| `clipboard.readText()` / `clipboard.writeText(text)` | clipboard | 通过宿主读写剪贴板 |
| `onContext(callback)` | 无 | 可见性、深浅主题和颜色变量；返回取消订阅函数 |
| `onCommand(callback)` | 无 | 页面打开命令的 ID；返回取消订阅函数 |
| `host.request({method, params?}, {signal})` | projects 或 session-history，v2 | 已登记项目及原生会话的分页读取 |
| `session.get()` | session-context，v2 | 当前工作台会话身份及运行状态 |
| `composer.get()` / `composer.set({text, revision})` | composer，v2 | 读取草稿及其 revision，再按 revision 编辑草稿 |
| `onEvent(name, callback)` | session-context，v2 | 声明的工作台事件；返回取消订阅函数 |

单页面最多 16 个并发请求和每秒 60 次调用。取消和页面卸载会中止在途请求，插件后端应据此停止未完成的操作。

上下文除可见性、主题及颜色外，还包含当前贡献 page。只有声明 project-context 或 session-context 时，才分别携带项目或当前会话信息。未获准的字段不下发；命令同样遵循该规则。

### 宿主服务与事件

| method | 所需权限 | 输入和结果 |
| --- | --- | --- |
| projects.list | projects | 返回已添加项目的 id、name、dir |
| sessions.list | session-history | params 为 projectId、agent 和可选 cursor；返回 items 与 nextCursor |
| sessions.history | session-history | params 为 projectId、agent、sessionId 和可选 before；返回最近或更早一页原生历史 |

会话服务复用现有项目归属检查及原生游标，不复制历史、不整份读取长会话。前端和插件后端都能调用同一组服务，宿主逐次核对安装状态和权限，取消会中止读取。

v2 清单的 events 可声明 context.changed、turn.started、turn.completed；订阅需要 session-context。事件只携带 `{name, session}`，session 包含 conversationId、workspaceId、agent、sessionId 和 running，不携带正文。轮次事件涵盖当前和内存后台会话，切换页面不会产生虚假的轮次事件。来源是当前已连接工作台的会话状态，不重放关闭应用期间的事件，也不把轮次结束当作执行成功。

## v2 后端通信

后端由当前 Node 或 Electron 的 Node 模式启动，不监听网络端口。宿主不传递模型服务凭据。具有 `backend` 权限的进程可访问本机文件和网络，启用前界面展示这一权限。

使用 Node IPC 接收 `{id, type, input}`，成功返回 `{id, ok: true, value}`，失败返回 `{id, ok: false}`。请求 ID 由宿主生成。

| type | input | 后端行为 |
| --- | --- | --- |
| initialize | `{dataDir, hostDataDir}` | 准备插件数据并返回；dataDir 是插件专有目录，hostDataDir 是宿主配置根 |
| request | `{method, url, body?}` | 处理本插件请求，返回 `{status, body}` |
| cancel | null | 以相同 id 取消对应请求 |
| dispose | null | 关闭连接等资源，答复后退出 |

后端还应在 IPC disconnect 时释放资源并退出。宿主为初始化和请求设置有界等待；停用期间不再派发新请求，退出超时会终止进程。

后端可发送 `{type: "host.request", id, input}` 调用宿主服务，答复为 `{type: "host.response", id, ok, value?, message?}`；取消使用 `{type: "host.cancel", id}`。SDK 的 context.host.request 封装这些消息。权限检查以宿主保存的清单为准。

## 开发入口

[插件 SDK](https://github.com/Heaven-y/agentdeck-plugins/tree/main/sdk)提供浏览器类型和 definePlugin 后端接口；SSH Console 使用同一 SDK。[项目助手示例](https://github.com/Heaven-y/agentdeck-plugins/tree/main/examples/project-helper)演示四类贡献、草稿、会话服务、设置与事件，无需本机后端或构建步骤。

## 扩展验收

宿主回归覆盖空安装、静态包、贡献与引用、权限、原生分页、草稿冲突、后台事件、命令交付、访问控制、包摘要、独立进程、取消、升级、数据保留和卸载。SSH Console 的连接、凭据、SFTP、PTY 与监控测试随实现迁至插件仓库。此前内置版本的实现与验收可追溯 `27279c2:docs/engineering/workbench-plugins.md`。
