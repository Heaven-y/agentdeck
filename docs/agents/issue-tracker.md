# 工单：本地 Markdown

规格和工单保存在当前检出目录的 `.scratch/`，供本机推进；跨任务的正式交付状态仍记在[路线图](../roadmap.md)。GitHub Issues 和 PR 不是默认的工单入口。

- 每个主题一目录：`.scratch/<feature>/`。规格写 `spec.md`；实现工单各写一份 `issues/<NN>-<slug>.md`，从 `01` 编号。
- 状态在文件顶部用 `Status: <label>` 表示，采用[分流标签](triage-labels.md)。补充讨论追加到 `## Comments`。
- 技能所说的「发布到工单系统」是写入上述目录。读取工单用文件路径，或在主题已明确时按编号定位。
- 工单写验收条件、依赖和相关正式文档的链接，不复制用户会话、凭据或机器配置。

## 探路工单

`wayfinder` 用 `.scratch/<effort>/map.md` 记录备注、已定事项与未知项；子工单仍放 `issues/`。在文件顶部用 `Type:` 记录 `research`、`prototype`、`grilling` 或 `task`，用 `Blocked by:` 列出前置编号。这些是探索任务，不套用实现工单的分流标签。

先领取编号最小、前置已完成且无人领取的工单，写入 `Status: claimed`；完成时在 `## Answer` 下写结论、标 `Status: resolved`，并在地图中的已定事项处追加简要说明和链接。
