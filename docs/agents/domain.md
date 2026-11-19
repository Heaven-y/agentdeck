# 领域文档

AgentDeck 使用一份仓库级[术语表](../../GLOSSARY.md)，不按前端、服务端、桌面或各 CLI 分别定义同一业务概念。调研、拆工单和命名测试时，查术语及正式说明中与当前主题有关的部分。

| 需要确认 | 到哪里查 |
|---|---|
| 产品行为与验收条件 | [产品需求](../product/requirements.md)、[界面约定](../product/ui-layout.md) |
| 协议、会话与能力边界 | [原生对话接入](../engineering/native-dialogue.md)、[架构](../engineering/architecture.md) |
| 方案取舍及历史原因 | [设计决策](../engineering/decisions.md) |

只把已经确定、会反复用到的词写入术语表，不写接口或实现过程。现有决策继续在设计决策文档维护；若新的跨模块取舍确实需要独立 ADR，再在 `docs/adr/` 建记录，从设计决策和[文档导航](../README.md)链接过去，避免重复写理由。调研假设和未确定方案先留在本地工单。
