# AgentDeck

AgentDeck 是 Windows 本机桌面工作台，用于按项目组织 Claude Code、Codex 和 Antigravity 的原生会话。各 CLI 继续管理自己的会话、配置、工具和权限。

## 主要功能

| 部分 | 当前能力 |
|---|---|
| 项目与会话 | 按目录管理项目；混合浏览三个 CLI 的历史，搜索、续聊、归档，并按来源提供重命名、分支和删除 |
| 原生对话 | 新建、续接、流式输出和中断；支持后台并行、断线补收和刷新恢复。Claude Code 和 Codex 的原生审批可在对话中处理 |
| 会话引用与轨迹 | 复制会话链接，跳转或按原生记录位置跨 CLI 参考历史；查看执行步骤、耗时、token 和上下文用量 |
| 原生配置 | 按各 CLI 的作用域管理模型、连接、规则、Skills、MCP 和原生插件；在「运行环境」安装、更新或修复 CLI |
| 用量工作台 | 内置用量概览、趋势与模型分布，按工作区与 CLI 筛选生成记录，自动匹配官网参考价 |

## 启动

Windows x64 安装版和便携版的使用与升级见[本地安装指南](docs/guides/local-installation.md)。从源码开发需要 Windows 10/11、Node.js 22+，并按需安装对应 CLI。

```powershell
npm.cmd ci
npm.cmd run dev:desktop
```

桌面开发模式支持界面热更新，后端或主进程变化时自动重启。浏览器开发用 `npm.cmd run dev`，生产式本机服务用 `npm.cmd start`。环境变量、隔离验证和 Git 流程见[开发指南](docs/guides/dev-environment.md)。

## 文档

- [文档导航](docs/README.md)：产品需求、界面约定与实现说明。
- [路线图](docs/roadmap.md)：已交付能力、后续事项与验收记录。
- [按功能找代码](docs/guides/repository-map.md)：源码和对应测试。
- [工作台扩展](docs/engineering/workbench-plugins.md)：插件的使用与开发。
