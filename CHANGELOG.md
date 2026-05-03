# 更新日志

## [0.1.0] — 2026-05-02

### 新增

- **Agent 运行时**：完整的 Agent 生命周期管理，支持工具调用和推理链
- **多 Agent 协作**：编排器模式，支持层级/并行/串行多种协作拓扑
- **持久记忆（三层）**：Markdown 块 + SQLite 向量 + 会话上下文
- **三级安全沙箱**：Process / Docker / Container 级别隔离
- **自我进化引擎**：反思学习 + 经验积累 + 策略自适应优化
- **MCP 工具集成**：Model Context Protocol 客户端
- **技能市场**：插件化技能安装/管理
- **知识库系统**：多格式文档解析 + 向量/BM25 混合检索
- **视频生成**：ComfyUI + RunningHub 端到端出片
- **IM 网关**：飞书/钉钉/企微/Telegram/Discord/Slack/WhatsApp/Line
- **Web UI**：14 个路由页面（对话/Agent 管理/知识库/视频工作室/设置/监控）
- **全链路追踪**：OpenTelemetry 标准
- **定时任务**：Cron 表达式调度
- **语音 STT/TTS**：阿里云集成
- **零配置启动**：首次引导模式
- **模型 Provider**：阿里 DashScope / DeepSeek / 智谱 GLM / Moonshot / 火山方舟 / MiniMax / OpenAI / Ollama

### 已知限制

- 监控面板（Electron）为骨架，待实现
- 部分工具在 Docker 沙箱中暂不可用
