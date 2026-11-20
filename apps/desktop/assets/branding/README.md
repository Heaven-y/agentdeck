# AgentDeck 图标原稿

2026-11-20 通过用户指定的生图服务生成，调用模型标识为 `gpt-image-2.6-sunburst`。三版原图均保留；当前使用用户选定的第一版。

| 文件 | 方向 | 状态 |
|---|---|---|
| `agentdeck-a.png` | 叠合工作卡片构成 A | 当前使用 |
| `agentdeck-team.png` | 多个智能体协作 | 保留备选 |
| `agentdeck-assistant.png` | 自主助手与任务完成 | 保留备选 |

当前图标从第一版 1024×1024 原图裁取 `(74, 80, 950, 956)` 区域，以半径 208 像素的圆角遮罩移除外部背景，再用 Lanczos 缩放至 256×256。四倍分辨率绘制遮罩后缩小，保留边缘抗锯齿；图案和颜色未重绘。

- `apps/web/src/ui/assets/agentdeck.png`：网页和桌面窗口共用的透明 PNG。
- `apps/desktop/assets/icon.ico`：从同一 PNG 导出 16、24、32、48、64、128、256 像素图层，用于 Windows 应用和安装包。
- `scripts/packaging/record.ts`：核对 PNG 与 ICO 的大图层一致，并检查最终 EXE 主图标组的全部图层。

原稿和生成提示词可以保留，服务凭据不得写入仓库。
