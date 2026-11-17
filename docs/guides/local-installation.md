# 本地安装与打包

支持 Windows x64 本地安装版和便携版。现有包为 0.1.1，最新源码尚未打包，进度见[路线图](../roadmap.md)。

**0.1.1** 于 2026-11-05 完成本地构建，解压应用与便携版的首屏、预加载隔离、单实例和退出清理通过验收。

同版本首轮候选 NSIS 完成过隔离安装、启动和卸载；后续重建沿用候选验证，未逐次重装。原记录见 `b053fe1:docs/guides/local-installation.md`。

## 选择安装方式

| 产物 | 使用方式 |
|---|---|
| `AgentDeck-0.1.1-x64-setup.exe` | NSIS 安装向导，可选择当前用户的安装目录；安装结束不自动启动 |
| `AgentDeck-0.1.1-x64-portable.exe` | 直接运行，程序临时解压后启动，无需安装 |
| `win-unpacked/` | 解压后的完整应用目录，用于本地验收；须保留整个目录一起移动 |

产物位于仓库 `release/`，该目录不进入 Git。安装版和便携版都包含 Electron、后端、前端与必要资源，不依赖开发仓库或其 node_modules。运行工作台本身不要求单独安装 Node.js；各 CLI 的安装条件仍由其原生发行版决定。

当前包没有 Windows 数字签名，系统可能显示发布者未知。包中不含账户、密钥、项目记录或 CLI 可执行文件；Claude Code、Codex、Antigravity 继续使用本机安装与各自的原生认证或 URL/Key 配置。缺少某个 CLI 时设置页会单独提示，不阻止其余功能。

## 数据和升级

项目、服务器档案、插件设置等使用[工作台数据目录](../engineering/architecture.md#51-工作台数据)，原生会话仍由各 CLI 保存。便携版只免安装，业务数据仍按同样规则保存，并非随 exe 携带。

同一用户正常只运行一个实例，再次启动会聚焦现有窗口。退出会停止本机服务并清理本应用持有的连接与子进程。卸载安装版保留工作台数据及 CLI 原生文件。

更新时退出旧版本，再运行新安装包或替换便携包。签名、在线更新和公开发布渠道尚未启用。

制作新包前确认变更范围和版本，规则见[开发指南](dev-environment.md#3-启动与隔离验证)。

## 从源码构建

在 Windows x64 开发环境安装锁定依赖后运行：

```powershell
npm.cmd ci
npm.cmd run package:desktop
```

脚本先构建网页和 Electron，再由 electron-builder 生成两种 exe；参数固定为 `--publish never`。首次构建需要下载锁定版本的 Electron 和打包工具。仅需要解压版时运行 `npm.cmd run package:desktop:dir`。

产物版本取自 `apps/desktop/package.json`，更新时同步锁文件中的 desktop 版本。不同版本的 exe 可以保留在 `release/`；`win-unpacked/` 和验证报告用于当前构建，再次构建会更新它们。

桌面运行时依赖在 desktop 清单显式声明，与 server 保持一致；共享 TypeScript 源码编入主进程。应用使用本机 CLI，SSH 的可选原生加速模块采用 JavaScript 回退。

## 验收与核对

`node --import tsx scripts/packaging/smoke.ts` 把 `release/win-unpacked` 复制到仓库外的临时目录，并隔离用户、应用数据和 PATH。通过本机调试接口检查首屏、preload 隔离、空初始数据、第二实例退出、正常关窗及端口释放，最后清理临时目录。

验收报告和截图写入 `release/verification/`。默认检查解压应用；追加 `--portable <exe路径>` 检查便携版，`--installed <应用目录>` 检查已安装版。NSIS 安装与卸载另查注册项、快捷方式和安装目录。

Windows 下可运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/installer-smoke.ps1` 验证 NSIS。脚本选择 desktop 清单中的当前版本，发现已有安装、同名快捷方式或缓存时停止。每次交付按实际产物生成报告和摘要。

`node --import tsx scripts/packaging/record.ts` 核对包内版本、主进程、preload 和网页入口，记录源文件指纹、Git 提交和成品摘要。它检查 desktop 清单当前版本的两种 x64 exe，任一缺失时失败。结果写入 `release/SHA256SUMS.txt` 与 `release/verification/build-record.json`。

最终交付附 SHA-256 清单。可用 PowerShell 核对下载或复制后的文件：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\release\AgentDeck-0.1.1-x64-setup.exe
Get-FileHash -Algorithm SHA256 -LiteralPath .\release\AgentDeck-0.1.1-x64-portable.exe
```

安装冒烟使用隔离环境；模型和 SSH 链路的验证结果见路线图。

## 会话链接的安装验收边界

会话链接已接入初始参数、第二实例和页面订阅后的分发，系统安装验收待下次打包完成。验证使用独立 Windows 用户，检查协议登记、冷启动、运行中打开链接及卸载清理，并保留已有协议所有者。
