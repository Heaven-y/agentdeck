# SSH Console 改为服务器中心形态

## 目标

让内置 SSH Console 与 DSH 的同名插件一致：**以服务器为单位**，服务器清单来自服务器档案，页面内不再有"项目"这一层。项目绑定（`server` / `remoteDir`）整层移除。

## 为什么现在能做

改造后只有少数几处还在读项目绑定，且都不是插件主体的需要：

| 使用者 | 实际依赖 |
|---|---|
| 控制台概览、进程、文件、终端 | 只要 `serverId`，不读项目 |
| Slurm | 只需要服务器别名，却被挂在"必须已绑定项目"的旧链路上 |
| 旧资源采样 | 需要远端目录，但控制台已按 `serverId` + `path` 采样 |
| 旧文件写任务、旧终端 | 控制台已覆盖同等能力 |
| codex / claude 适配器 | 仅作为运行时缓存键的一部分 |

Slurm 的前端一直嵌在旧资源视图底部，代码里留有说明：「Slurm 仍留在资源视图里，等后续任务再拆成独立标签」。本计划就是那个后续任务。

## 分阶段

### 阶段 A：Slurm 改为按服务器

- 新增 `console/slurm.ts`，走控制台的 `access.capture(serverId)` 租约，复用连接代次与凭据变化检查。
- `legacy/slurm/commands.ts`、`parse.ts`、`abort.ts` 移入 `console/`，去掉对工作区目标的依赖。
- 路由改为 `GET /api/ssh-console/:serverId/jobs`，与其余控制台路由同构。
- 前端新增「作业」页签（`ConsoleJobs`），删除旧 `SlurmJobs` 与 `useSlurm`。输出按原生列宽原样显示，不二次拆列。

### 阶段 B：把控制台真正依赖的工具移出 legacy

`console/` 目前仍从 `legacy/` 引入若干通用工具，它们不是旧业务，只是位置遗留：

- `legacy/resources/cache.ts` → `console/cache.ts`
- `legacy/resources/commands.ts` → `console/host-command.ts`（只留 `HOST_RESOURCE_COMMAND`）、`parse.ts` → `console/host-parse.ts`
- `legacy/terminal/input.ts`、`initialization.ts`、`errors.ts` → `ssh/terminal-input.ts`、`ssh/terminal-init.ts`、`ssh/terminal-errors.ts`
- `remotePath`（原 `legacy/remote-files/paths.ts`）内联进 `console/files.ts`，只保留 `~` 展开

另新增 `console/command.ts`：overview、processes、jobs 三条只读命令共用同一套租约通道与取消逻辑。

### 阶段 C：删除旧视图

服务端删除 `legacy/` 全部剩余内容与对应路由（`remote-files`、`remote-file-actions`、`terminal`、`resources`、`slurm`）；前端删除 `legacy/` 目录，`Workspace.tsx` 只保留服务器档案对话框与控制台。

旧文件写任务的落盘记录不再保留：本机从未产生过（`AgentDeck` 数据目录下没有任务文件），且新控制台的文件页只读，不承担写任务语义。任务记录的 schema、存储、重放与 `needs_check` 判定一并删除。

### 阶段 D：移除项目绑定整层

- `WorkspaceSchema` 去掉 `server` / `remoteDir`、`BoundWorkspace`、`isBoundWorkspace`。
- 删除 `workspaces/bound.ts`；`store` 与 `import` 不再校验、迁移绑定字段。
- `projects.routes.ts` 的补丁字段只保留 `name`、`dir`。
- codex / claude 适配器的运行时键去掉绑定字段。
- `ssh/profiles.ts` 去掉"服务器被项目引用即锁定"的计数；服务器是否可删只看凭证与连接。前端 `SshConnectionPanel`（只为展示项目绑定状态而存在）一并删除。
- `scripts/dev` 的两个本机夹具改到新控制台路由，仍用真实 ssh2 服务端验收。

### 阶段 E：文档与验证

同步 `ui-layout`、`architecture`、`workbench-plugins`、`requirements`、`roadmap`、`decisions`，跑完整 `npm run check`。

## 验收

- 控制台四个既有视图不受影响，新增「作业」页签按当前服务器查询。
- 服务器管理不再因项目引用而锁定；删除服务器只受凭证状态约束。
- `Workspace` 不再含 `server` / `remoteDir`；旧配置里这两个字段被 zod 丢弃而不报错。
- 完整门禁通过，覆盖率不低于本轮起点。
- 提交按阶段划分，历史中不出现"加进来又删掉"的自相矛盾记录。
