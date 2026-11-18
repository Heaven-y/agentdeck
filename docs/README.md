# 文档导航

整理日期：2026-11-18。先看交付进度，再按问题查阅产品、实现或使用文档。

## 从哪里开始

| 需要了解 | 文档 |
|---|---|
| 从需求找到源码、登记入口和对应测试 | [按功能找代码](guides/repository-map.md) |
| 产品定位与启动 | [项目入口](../README.md) |
| 已完成、待办与验收边界 | [路线图](roadmap.md) |
| 功能范围和验收条件 | [产品需求](product/requirements.md) |
| 界面、导航、设置与交互 | [界面约定](product/ui-layout.md) |
| 模块、生命周期、存储与配额 | [架构](engineering/architecture.md) |
| 当前方案的理由及历史锚点 | [设计决策](engineering/decisions.md) |
| 开发、验证、分支与合并 | [开发指南](guides/dev-environment.md) |
| 配置未生效、错误跟随或同一问题反复修复 | [AGY 两例复盘](engineering/incidents/antigravity-repeated-regressions.md)、[排查与验收方法](guides/dev-environment.md#51-同一问题反复修复) |
| 安装、打包与升级 | [本地分发](guides/local-installation.md) |

## 按功能查阅

| 功能 | 文档 |
|---|---|
| 三 CLI 对话、会话管理、权限与引用读取 | [原生对话接入](engineering/native-dialogue.md) |
| 原生文件、URL/Key、启动环境与作用域 | [原生配置](engineering/native-configuration.md) |
| 上下文、token、速度和执行轨迹 | [统计口径](engineering/cli-observability.md) |
| 模型显示、Claude 1M 与推理档位 | [模型能力](engineering/model-capabilities.md) |
| 静态页面插件、宿主接口与 SSH Console | [插件契约](engineering/workbench-plugins.md) |
| 三 CLI 原生能力逐项状态、限制与产品边界 | [原生能力矩阵](engineering/native-capability-matrix.md) |

## 维护规则

- 需求写“做什么”，界面写“怎么操作”，架构和专项说明写“怎么实现”，决策写“为什么”，路线图写“交付到哪里”。参数只在所属文档维护，其他位置引用。
- `AGENTS.md` 只放每次任务都适用的规则；只在特定场景适用的经验放[开发指南的按症状查](guides/dev-environment.md#5-按症状查)，出现症状时再读，不往每次必读的清单里堆条件分支。
- 代码已接入、受控验证、真实环境通过和外部阻塞分别记录。只改文档不重新推定历史结果。
- 已完成计划归入[历史追溯](engineering/decisions.md#历史追溯)，有效约定写入对应专题，后续工作见路线图。
- 新文档加入本导航；重命名或移除章节时同步修复链接。整理后运行文档检查，不因纯文档修改重复业务测试。
