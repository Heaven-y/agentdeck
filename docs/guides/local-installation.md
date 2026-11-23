# 本地安装与打包

支持 Windows x64 本地安装版和便携版。当前本地包为 **0.1.3**，于 2026-11-23 从主线 `48e66e2` 构建，纳入 AGY 账号、空回复和回合错误显示修复，进度见[路线图](../roadmap.md)。

0.1.3 的解压版、便携版和已安装版均通过隔离启动检查。本机以原目录和全机范围把 0.1.2 静默原位升级到 0.1.3；卸载登记仍为同一项，程序文件与成品一致，五份已有工作台配置校验值不变。没有另测交互式覆盖、UAC 提示或卸载。0.1.2 的原生 NSIS 页面回归和首次向导验收见 `25f475f:docs/guides/local-installation.md`。

0.1.1 的首轮候选安装、启动和卸载记录见 `b053fe1:docs/guides/local-installation.md`。

## 选择安装方式

| 产物 | 使用方式 |
|---|---|
| `AgentDeck-0.1.3-x64-setup.exe` | 首次安装选择用户范围和目录；已有一份有效安装时沿用原范围和目录更新；安装结束不自动启动 |
| `AgentDeck-0.1.3-x64-portable.exe` | 直接运行，程序临时解压后启动，无需安装 |
| `win-unpacked/` | 解压后的完整应用目录，用于本地验收；须保留整个目录一起移动 |

产物位于仓库 `release/`，该目录不进入 Git。安装版和便携版都包含 Electron、后端、前端与必要资源，不依赖开发仓库或其 node_modules。运行工作台本身不要求单独安装 Node.js；各 CLI 的安装条件仍由其原生发行版决定。

当前包没有 Windows 数字签名，系统可能显示发布者未知。包中不含账户、密钥、项目记录或 CLI 可执行文件；Claude Code、Codex、Antigravity 继续使用本机安装与各自的原生认证或 URL/Key 配置。缺少某个 CLI 时设置页会单独提示，不阻止其余功能。

## 数据和升级

项目、偏好和插件数据保存在[工作台数据目录](../engineering/architecture.md#51-工作台数据)，原生会话由各 CLI 保存。便携版免安装，仍使用同一个数据位置。

同一用户正常只运行一个实例，再次启动会聚焦现有窗口。退出会停止本机服务并清理本应用持有的连接与子进程。卸载安装版保留工作台数据及 CLI 原生文件。

更新时退出旧版本，再运行新安装包。正常只有一份安装时，向导识别原程序后直接沿用安装范围和目录，无需重复选择；程序文件在原位置更新，工作台数据和 CLI 原生文件继续保留。当前用户与全机范围都已有安装时，先选择要更新的范围，再沿用对应目录。仅有登记、原程序已经不存在时保留安装选择。全机安装仍按 Windows 要求请求管理员权限。

手动指定 `/currentuser`、`/allusers` 或 `/D=` 时继续遵循显式参数；`/D=` 必须放在最后，不加引号，目录可以包含空格。静默安装 `/S` 使用 electron-builder 的原生流程；上述本机升级使用 `/S /allusers` 并显式指定原目录。便携版更新只需替换便携包。签名、在线更新和公开发布渠道尚未启用。

制作新包前确认变更范围和版本，规则见[开发指南](dev-environment.md#3-启动与隔离验证)。

## 从源码构建

在 Windows x64 开发环境安装锁定依赖后运行：

```powershell
npm.cmd ci
npm.cmd run package:desktop
```

脚本先构建网页和 Electron，再由 electron-builder 生成两种 exe；参数固定为 `--publish never`。首次构建需要下载锁定版本的 Electron 和打包工具。仅需要解压版时运行 `npm.cmd run package:desktop:dir`。

应用采用用户选定的叠卡 A 图标，三版原稿保留在 `apps/desktop/assets/branding/`。网页标签与桌面开发窗口共用 `apps/web/src/ui/assets/agentdeck.png`；安装版把同一文件复制到 `resources/icon.png`。应用 EXE、安装包和快捷方式使用 `apps/desktop/assets/icon.ico`，其多尺寸图层从该 PNG 导出；修改图案时同步更新衍生文件，并核对最终包内资源。

产物版本取自 `apps/desktop/package.json`，更新时同步锁文件中的 desktop 版本。`win-unpacked/` 和验证报告用于当前构建，再次构建会更新它们；同版重建后以新的 SHA-256 清单核对。0.1.2 安装版、便携版和版本专属校验清单保留，旧构建报告已归档。

桌面运行时依赖在 desktop 清单显式声明，与 server 保持一致；共享 TypeScript 源码编入主进程。应用使用本机 CLI，SSH 的可选原生加速模块采用 JavaScript 回退。

## 验收与核对

`node --import tsx scripts/packaging/smoke.ts` 把 `release/win-unpacked` 复制到仓库外的临时目录，并隔离用户、应用数据和 PATH。解压版检查使用便携标记，避免把临时程序登记为系统协议入口。通过本机调试接口检查首屏、preload 隔离、空初始数据、第二实例退出、正常关窗及端口释放，最后逐项清理临时目录，不跟随目录链接。

验收报告和截图写入 `release/verification/`。默认检查解压应用；追加 `--portable <exe路径>` 检查便携版，`--installed <应用目录>` 检查已安装版。NSIS 安装与卸载另查注册项、快捷方式和安装目录。

Windows 下可运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/packaging/installer-smoke.ps1` 验证 NSIS。脚本选择 desktop 清单中的当前版本，发现已有安装、同名快捷方式或缓存时停止。每次交付按实际产物生成报告和摘要。

仅检查安装页面逻辑时，在 PowerShell 7 中运行 `pwsh -NoProfile -File scripts/packaging/installer-pages-smoke.ps1`。脚本使用已缓存的 NSIS 工具执行生产页面钩子，覆盖首次安装、当前用户/全机更新、双范围、残留登记、显式范围和路径以及原生更新参数；中文、空格和非默认旧目录均需原样保留。测试不改真实安装登记，不安装或卸载应用，临时文件逐项清理；结果写入 `release/verification/installer-pages.json`。

`node --import tsx scripts/packaging/record.ts` 核对包内版本、主进程、preload、网页入口和窗口图标，并检查 PNG 与 ICO 的 256 像素图层一致，再逐一比较应用 EXE、安装包、便携包内主图标组的全部图层与当前 ICO，记录源文件指纹、Git 提交和成品摘要。它检查 desktop 清单当前版本的两种 x64 exe，任一缺失时失败。结果写入 `release/SHA256SUMS.txt` 与 `release/verification/build-record.json`。

最终交付附 SHA-256 清单。可用 PowerShell 核对下载或复制后的文件：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\release\AgentDeck-0.1.3-x64-setup.exe
Get-FileHash -Algorithm SHA256 -LiteralPath .\release\AgentDeck-0.1.3-x64-portable.exe
```

验收范围见[路线图](../roadmap.md#已有验收证据)。

## 会话链接的安装验收边界

会话链接已接入初始参数、第二实例和页面订阅后的分发。0.1.3 升级后核对了当前用户的协议登记、公共桌面和开始菜单快捷方式，均指向原安装目录。未通过系统链接实测冷启动、运行中跳转或卸载清理；这些场景使用独立 Windows 用户验证，并保留已有协议所有者。
