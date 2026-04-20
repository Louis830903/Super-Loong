<div align="center">

```
  ███████╗██╗   ██╗██████╗ ███████╗██████╗     ██╗      ██████╗  ██████╗ ███╗   ██╗ ██████╗ 
  ██╔════╝██║   ██║██╔══██╗██╔════╝██╔══██╗    ██║     ██╔═══██╗██╔═══██╗████╗  ██║██╔════╝ 
  ███████╗██║   ██║██████╔╝█████╗  ██████╔╝    ██║     ██║   ██║██║   ██║██╔██╗ ██║██║  ███╗
  ╚════██║██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗    ██║     ██║   ██║██║   ██║██║╚██╗██║██║   ██║
  ███████║╚██████╔╝██║     ███████╗██║  ██║    ███████╗╚██████╔╝╚██████╔╝██║ ╚████║╚██████╔╝
  ╚══════╝ ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝    ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ 
```

### *An AI that remembers, evolves, and never stops thinking.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-≥3.10-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=next.js&logoColor=white)](https://nextjs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://fastify.dev/)
[![pnpm](https://img.shields.io/badge/pnpm-≥9-F69220?style=for-the-badge&logo=pnpm&logoColor=white)](https://pnpm.io/)

<br/>

> **模块化 AI Agent 平台** — 三层持久记忆 · 自我演化引擎 · 多 Agent 协作 · 8 平台 IM 网关
>
> *零原生依赖数据库 · 零外部 Embedding · 开箱即用*

<br/>

[快速开始](#-快速开始) · [核心能力](#-核心能力) · [架构总览](#-架构总览) · [技能系统](#-技能系统) · [IM 网关](#-im-网关) · [API 参考](#-api-参考) · [贡献指南](#-贡献)

</div>

---

## 🙏 致敬 & 致谢

> *站在巨人的肩膀上。*

Super Loong 的诞生深受两个杰出开源项目的启发，在此致以最高敬意：

### [OpenClaw](https://github.com/AiClaw) 🐾

OpenClaw 开创性地提出了 **Heartbeat 心跳系统** —— 让 Agent 不再是被动的"问答机器"，而是一个拥有内在节律、能够主动轮询和自省的"活"的存在。我们从 OpenClaw 借鉴了：

- **Heartbeat 主动思考循环** — Agent 在无用户输入时仍保持"心跳"，持续反思与规划
- **子代理工具限制策略** — 按嵌套深度递减的工具访问矩阵，防止递归失控
- **7 段式子代理提示词架构** — 角色定义 → 行为规则 → 输出格式 → 禁止行为 → Spawn → 叶节点 → 上下文
- **Tool Result Truncation** — 智能截断过长的工具输出以保护上下文窗口

### [Hermes](https://github.com/letta-ai) 🪶

Hermes 定义了 Agent "灵魂"的存储范式 —— `SOUL.md` / `MEMORY.md` / `USER.md` 三文件模式让 Agent 的人格、记忆和用户画像各归其位、清晰可控。我们从 Hermes 借鉴了：

- **SOUL / MEMORY / USER 三文件人格范式** — 人格定义（人类编辑）、Agent 笔记（Agent 维护）、用户画像（对话驱动）
- **Nudge 自省系统** — 定期触发 Agent 反思自身行为模式，驱动渐进式进化
- **HRR 向量符号架构** — Holographic Reduced Representation，零外部依赖的确定性 Embedding
- **MemSkill 进化闭环** — 从失败案例中自动提炼经验 → 生成技能 → 反馈优化
- **System Prompt Snapshot 冻结机制** — 在运行时锁定系统提示词，防止注入篡改

**Super Loong 是对这两个项目思想的融合与延伸** —— 我们将 OpenClaw 的"心跳生命力"与 Hermes 的"灵魂记忆"编织在一起，并在此基础上构建了多 Agent 协作、10 层提示工程、三级安全沙箱和 8 平台 IM 网关等全新能力。

---

## ✨ 核心能力

<table>
<tr>
<td width="50%">

### 🧠 三层持久记忆
*灵感: Letta / Hermes*

| 层级 | 用途 | 存储 |
|------|------|------|
| **Core Memory** | 常驻上下文 (persona / user / goals) | 内存 + 文件 |
| **Recall Memory** | 对话历史全量索引 | SQLite FTS5 |
| **Archival Memory** | 长期知识库，语义检索 | SQLite + HRR |

Agent 工具：`remember` · `recall` · `forget` · `core_memory_read` · `core_memory_append` · `core_memory_replace`

</td>
<td width="50%">

### 🔄 自我演化引擎
*灵感: Hermes MemSkill*

```
失败交互 → CaseCollector 收集
    ↓ (≥10 cases + 1h 冷却)
NudgeTracker 触发自省
    ↓
LLM 分析模式 → 生成/优化技能
    ↓
EvolutionSnapshot 记录历史
    ↓
Agent 变得更强 🚀
```

双引擎驱动：**Nudge 自省** + **技能进化**，Session Flush 在上下文丢失前自动保存。

</td>
</tr>
<tr>
<td width="50%">

### 🤝 多 Agent 协作
*灵感: CrewAI + AutoGen*

**任务编排模式:**
- `Sequential` — 流水线串行
- `Hierarchical` — 主管分配 + 并行组
- `GroupChat` — 动态发言轮转

**发言者选择策略:**
- Round-Robin 轮询
- LLM 智能选择
- 手动指定

超时保护 · 结果聚合 · 错误恢复

</td>
<td width="50%">

### 🏗️ 10 层提示工程

```
┌─────────────────────────┐
│ L1  System Identity     │ ─┐
│ L2  Soul (SOUL.md)      │  │
│ L3  Personality Traits   │  ├─ 稳定层 (可缓存)
│ L4  Tool Definitions     │  │
│ L5  Behavioral Rules     │  │
│ L6  Output Format        │ ─┘
│ L7  Core Memory Blocks   │ ─┐
│ L8  Active Skills        │  ├─ 动态层 (每轮注入)
│ L9  Context Window       │  │
│ L10 User Message         │ ─┘
└─────────────────────────┘
```

L1-L6 Prefix Caching 优化，减少 70%+ Token 开销。

</td>
</tr>
<tr>
<td width="50%">

### 🛡️ 三级安全沙箱

| 级别 | 实现 | 限制 |
|------|------|------|
| **Process** | `child_process` | 超时 + 内存限制 |
| **Docker** | 容器隔离 | 128MB RAM, 无网络 |
| **SSH** | 远程执行 | 独立主机 |

自动探测可用沙箱级别，代码执行零信任。

</td>
<td width="50%">

### 🔌 MCP 工具集成

支持 [Model Context Protocol](https://modelcontextprotocol.io/) 三种传输：

- **stdio** — 本地进程通信
- **SSE** — Server-Sent Events 流式
- **streamable-http** — HTTP 流式传输

动态发现 · 热加载 · 工具权限控制 · Schema 验证

</td>
</tr>
<tr>
<td width="50%">

### 📡 8 平台 IM 网关

```
飞书 · 企业微信 · 钉钉 · 微信
Telegram · Discord · Slack · Webhook
```

Python FastAPI 微服务架构，统一消息管线，支持富文本 / 语音 / 图片 / 卡片消息。

</td>
<td width="50%">

### 🧩 更多能力

- ⏰ **Cron 定时任务** — 自然语言描述 → cron 表达式
- 🎙️ **语音 STT/TTS** — 多引擎语音输入输出
- 🔀 **子代理 Spawn** — 深度限制 + 工具矩阵
- 📊 **实体解析** — 别名管理 + 记忆关联
- 🗜️ **上下文压缩** — LLM 结构化摘要器
- 🤖 **OpenAI 兼容 API** — `/v1/chat/completions`
- 💡 **Heartbeat 心跳** — Agent 主动轮询

</td>
</tr>
</table>

---

## 🏛️ 架构总览

```
                            ┌──────────────────────────────────────────┐
                            │              Super Loong                  │
                            └──────────────┬───────────────────────────┘
                                           │
                 ┌─────────────────────────┼─────────────────────────┐
                 │                         │                         │
        ┌────────▼────────┐    ┌───────────▼──────────┐    ┌────────▼────────┐
        │  packages/web   │    │    packages/api       │    │ services/       │
        │  Next.js 16     │◄──►│    Fastify 5          │◄──►│ im-gateway      │
        │  React 19       │    │    REST + WebSocket    │    │ Python FastAPI  │
        │  Tailwind 4     │    │    OpenAI Compatible   │    │ 8 IM Channels   │
        └────────┬────────┘    └───────────┬──────────┘    └─────────────────┘
                 │                         │
                 │              ┌───────────▼──────────┐
                 │              │    packages/core      │
                 │              │                       │
                 │              │  ┌─────────────────┐  │
                 │              │  │  AgentRuntime    │  │
                 │              │  │  ┌────────────┐  │  │
                 │              │  │  │ PromptEngine│  │  │
                 │              │  │  │ MemoryMgr   │  │  │
                 │              │  │  │ LLMProvider  │  │  │
                 │              │  │  │ ToolExecutor │  │  │
                 │              │  │  └────────────┘  │  │
                 │              │  └─────────────────┘  │
                 │              │                       │
                 │              │  EvolutionEngine      │
                 │              │  CollabOrchestrator   │
                 │              │  SecurityManager      │
                 │              │  SkillLoader          │
                 │              │  MCPRegistry          │
                 │              │  CronScheduler        │
                 │              └───────────────────────┘
                 │                         │
                 │              ┌───────────▼──────────┐
                 │              │   sql.js (WASM)      │
                 │              │   Zero native deps   │
                 │              │   SQLite + FTS5       │
                 └──────────────┴──────────────────────┘
```

### 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| **前端** | Next.js 16 + React 19 + Tailwind CSS 4 | 13 个管理页面，实时 WebSocket |
| **API** | Fastify 5 + TypeScript | 11 个路由模块，JWT 认证 |
| **核心** | TypeScript + Zod + EventEmitter3 | Agent 运行时，记忆/演化/协作 |
| **数据库** | sql.js (WASM SQLite) | 零原生依赖，FTS5 全文搜索 |
| **Embedding** | HRR (自研) | 零外部 API 调用的确定性向量 |
| **IM 网关** | Python 3.10+ + FastAPI | 统一消息管线，8 平台适配 |
| **包管理** | pnpm Workspace | Monorepo 架构 |

---

## 🚀 快速开始

### 环境要求

- **Node.js** ≥ 20.0.0
- **pnpm** ≥ 9.0.0
- **Python** ≥ 3.10 (仅 IM 网关需要)

### 1. 克隆 & 安装

```bash
git clone https://github.com/Louis830903/Super-Loong.git
cd Super-Loong

# 安装 Node.js 依赖
pnpm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 填入你的 LLM 配置：

```env
LLM_PROVIDER=openai          # openai / anthropic / 或任何 OpenAI 兼容接口
LLM_MODEL=gpt-4o             # 模型名称
LLM_API_KEY=sk-xxx           # API Key
LLM_BASE_URL=                # 自定义 API 地址 (可选)
PORT=3001                    # API 服务端口
```

### 3. 启动

```bash
# 开发模式 (API + Web 同时启动)
pnpm dev

# 或分别启动
pnpm --filter @super-agent/api dev      # API 服务 → http://localhost:3001
pnpm --filter @super-agent/web dev      # Web 前端 → http://localhost:3000
```

### 4. (可选) 启动 IM 网关

```bash
cd services/im-gateway
pip install -r requirements.txt   # 或 pip install -e .
python server.py
```

访问 `http://localhost:3000` 即可开始使用 🎉

---

## 🧩 技能系统

Super Loong 的技能系统兼容多种格式，一个 `.md` 文件就是一个技能：

### 支持格式

| 格式 | 来源 | 说明 |
|------|------|------|
| **纯 Markdown** | OpenClaw 风格 | 直接写 Markdown，标题即技能名 |
| **YAML Frontmatter** | Hermes 风格 | YAML 头部定义元数据 + Markdown 正文 |
| **扩展格式** | Super Loong | 支持触发条件、依赖关系、版本管理 |

### 示例技能

```markdown
---
name: 天气查询专家
trigger: 当用户询问天气相关问题时
dependencies: [web_search]
version: 1.0.0
---

# 天气查询专家

## 行为规则
1. 使用 web_search 工具搜索实时天气
2. 返回格式化的天气信息，包含温度、湿度、风力
3. 如果用户未指定城市，先询问所在城市

## 输出格式
- 使用 emoji 让天气信息更直观
- 包含未来 3 天的简要预报
```

技能存放在 `data/skills/` 目录下，热加载生效，无需重启。

---

## 📡 IM 网关

<table>
<tr>
<td align="center"><b>飞书</b><br/>Feishu</td>
<td align="center"><b>企业微信</b><br/>WeCom</td>
<td align="center"><b>钉钉</b><br/>DingTalk</td>
<td align="center"><b>微信</b><br/>WeChat</td>
</tr>
<tr>
<td align="center"><b>Telegram</b></td>
<td align="center"><b>Discord</b></td>
<td align="center"><b>Slack</b></td>
<td align="center"><b>Webhook</b></td>
</tr>
</table>

- 统一的消息管线：接收 → 去重 → 路由 → Agent 处理 → 响应
- 支持富文本、语音、图片、卡片消息
- 附件自动处理 (图片 OCR / 语音 STT)
- 每个通道独立配置、独立生命周期
- Web UI 可视化管理通道配置

---

## 📚 API 参考

所有 API 基于 `http://localhost:3001`：

| 模块 | 端点 | 说明 |
|------|------|------|
| **Chat** | `POST /api/chat` | 对话（支持流式） |
| **OpenAI** | `POST /v1/chat/completions` | OpenAI 兼容接口 |
| **Agents** | `/api/agents/*` | Agent CRUD + 配置 |
| **Memory** | `/api/memory/*` | 记忆查询 / 搜索 / 管理 |
| **Skills** | `/api/skills/*` | 技能加载 / 列表 / 管理 |
| **Channels** | `/api/channels/*` | IM 通道配置 |
| **MCP** | `/api/mcp/*` | MCP 工具管理 |
| **Cron** | `/api/cron/*` | 定时任务管理 |
| **Collaboration** | `/api/collaboration/*` | 多 Agent 任务 |
| **Evolution** | `/api/evolution/*` | 演化记录查询 |
| **Security** | `/api/security/*` | 沙箱配置 |
| **Voice** | `/api/voice/*` | 语音 STT/TTS |

---

## 📁 项目结构

```
super-agent/
├── packages/
│   ├── core/           # 🧠 核心引擎 (Agent 运行时/记忆/演化/协作/安全)
│   ├── api/            # ⚡ API 服务 (Fastify + WebSocket)
│   ├── web/            # 🎨 Web 前端 (Next.js + React)
│   └── research/       # 🔬 研究与实验
├── services/
│   └── im-gateway/     # 📡 IM 网关 (Python FastAPI)
├── data/
│   ├── SOUL.md         # 👤 Agent 人格定义 (人类编辑)
│   ├── MEMORY.md       # 📝 Agent 笔记 (Agent 维护)
│   ├── USER.md         # 🧑 用户画像 (对话驱动)
│   └── skills/         # 🧩 技能目录
├── .env.example        # 环境变量模板
├── pnpm-workspace.yaml # Monorepo 配置
└── package.json        # 工作区根配置
```

---

## 🤝 贡献

欢迎一切形式的贡献！无论是 Bug 报告、功能建议还是代码 PR。

```bash
# Fork & Clone
git clone https://github.com/<your-username>/Super-Loong.git

# 创建分支
git checkout -b feat/amazing-feature

# 提交
git commit -m "feat: add amazing feature"

# 推送 & PR
git push origin feat/amazing-feature
```

---

## 📄 License

[MIT](LICENSE) © Louis830903

---

<div align="center">

**Super Loong** — *Remember Everything. Evolve Forever.*

*Built with passion, inspired by [OpenClaw](https://github.com/AiClaw) & [Hermes](https://github.com/letta-ai)*

</div>
