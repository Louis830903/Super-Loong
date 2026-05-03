# Super Agent

模块化通用 AI Agent 平台，支持持久记忆、自我进化、多智能体协作、知识库、视频生成与 IM 网关。

## 核心能力

| 能力 | 说明 |
|------|------|
| **Agent 运行时** | 完整的 Agent 生命周期管理，支持工具调用、推理链、流式响应 |
| **多 Agent 协作** | 编排器模式，支持层级/并行/串行多种协作拓扑 |
| **持久记忆（三层）** | Markdown 块 + SQLite 向量 + 会话上下文，跨会话知识保留 |
| **三级安全沙箱** | Process / Docker / Container，代码执行全隔离 |
| **自我进化引擎** | 反思学习 + 经验积累 + 策略自适应优化 |
| **MCP 工具集成** | Model Context Protocol 客户端，对接外部工具生态 |
| **技能市场** | 插件化技能安装/管理/版本控制 |
| **知识库系统** | 多格式文档解析（PDF/Word/Excel/PPT/HTML），向量检索 + BM25 混合搜索 |
| **视频生成** | ComfyUI 工作流 + RunningHub 云端模型，端到端出片 |
| **IM 网关（8 平台）** | 飞书/钉钉/企微/Telegram/Discord/Slack/WhatsApp/Line |
| **Web UI（14 页面）** | 对话/Agent 管理/知识库/视频工作室/设置/监控 |
| **全链路追踪** | OpenTelemetry 标准，请求级可观测 |
| **定时任务** | Cron 表达式调度，持久化任务状态 |
| **语音 STT/TTS** | 阿里云语音合成与识别 |

## 技术栈

| 层 | 技术 |
|----|------|
| 核心引擎 | TypeScript + Node.js ≥ 20 |
| API 服务 | Fastify 5 |
| 前端 | Next.js 16 + React 19 + Tailwind CSS 4 |
| 数据库 | sql.js (WASM SQLite) |
| 类型验证 | Zod 3.24 |
| 日志 | pino |
| IM 网关 | Python FastAPI |
| 知识库解析 | Python Docling |
| 视频生成 | Python FastAPI + ComfyUI |
| 包管理 | pnpm ≥ 9 (monorepo) |

## 快速开始

### 环境要求

- Node.js ≥ 20.0.0
- pnpm ≥ 9.0.0
- Python ≥ 3.11（知识库解析 + IM 网关 + 视频生成）

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/Louis830903/Super-Loong.git
cd super-agent

# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，至少填入一个 LLM Provider 的 API Key

# 启动全部服务（API + Web + Monitor + IM Gateway）
pnpm dev
```

启动后访问：
- Web UI: http://localhost:3000
- API 服务: http://localhost:3001
- 监控面板: http://localhost:3002
- IM 网关: http://localhost:8642

### 零配置启动（首次引导）

首次启动时，如果没有 `.env` 文件，系统会自动进入引导模式，在 Web UI 中引导完成初始配置。

## 项目结构

```
super-agent/
├── packages/
│   ├── core/        # 核心引擎（Agent 运行时/记忆/进化/安全）
│   ├── api/         # Fastify 5 API 服务
│   ├── web/         # Next.js 16 前端 UI
│   ├── monitor/     # Electron 监控面板
│   ├── research/    # 评估基准与学术研究工具
│   └── web-types/   # 前后端共享类型与常量
├── services/
│   ├── im-gateway/  # IM 平台适配网关（Python）
│   ├── video-forge/ # 视频生成微服务（Python + ComfyUI）
│   └── kb-parser/   # 知识库文档解析服务（Python Docling）
├── data/            # 运行时数据（不入库）
├── docs/            # 项目文档
└── .env.example     # 环境变量模板
```

## 配置

详见 [.env.example](.env.example)，关键配置项：

| 变量 | 说明 |
|------|------|
| `SA_ENCRYPTION_KEY` | **必填**。AES-256-CBC 加密密钥，用于加密数据库中的 API Key |
| `DASHSCOPE_API_KEY` | 阿里 DashScope（Qwen 系列） |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `ZHIPU_API_KEY` | 智谱 GLM |
| `MOONSHOT_API_KEY` | Moonshot（Kimi） |
| `ARK_API_KEY` | 火山方舟（豆包/图片生成） |
| `RUNNINGHUB_API_KEY` | RunningHub（视频生成） |

## 支持的模型 Provider

- **阿里 DashScope**（Qwen 系列，含多模态）
- **DeepSeek**（DeepSeek-V3 / R1）
- **智谱 GLM**（GLM-4.7 系列）
- **Moonshot**（Kimi K2.5）
- **火山方舟**（豆包 Seed 2.0 系列）
- **MiniMax**
- **OpenAI**（可选）
- **Ollama**（本地模型）

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm dev

# 构建
pnpm build

# 运行测试
pnpm test

# 代码检查
pnpm lint
```

## 许可证

MIT License — 详见 [LICENSE](LICENSE)
