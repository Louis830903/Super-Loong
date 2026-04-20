# Super Agent 平台 — Repo Wiki

> 模块化通用 AI Agent 平台，单体仓库(monorepo)架构，版本 0.1.0

---

## 目录

1. [项目总览](#1-项目总览)
2. [仓库结构](#2-仓库结构)
3. [packages/core — 核心引擎](#3-packagescore)
4. [packages/api — API 服务](#4-packagesapi)
5. [packages/web — 前端 UI](#5-packagesweb)
6. [services/im-gateway — IM 网关](#6-servicesim-gateway)
7. [核心类型系统](#7-核心类型系统)
8. [模块深度解读](#8-模块深度解读)
9. [数据持久化](#9-数据持久化)
10. [消息处理流程](#10-消息处理流程)
11. [环境变量](#11-环境变量)
12. [开发指南](#12-开发指南)

---

## 1. 项目总览

| 属性         | 值                                       |
| ------------ | ---------------------------------------- |
| 包管理器     | pnpm >= 9.0.0 (workspace)               |
| Node 版本    | >= 20.0.0                                |
| 核心语言     | TypeScript (前后端) + Python (IM 网关)   |
| 构建工具     | tsup (core/api), Next.js 16 (web)        |
| 运行时数据库 | sql.js (WASM SQLite, 零原生依赖)         |
| 日志         | pino                                     |

**核心能力矩阵**：

| 能力             | 模块                    | 状态    |
| ---------------- | ----------------------- | ------- |
| Agent 运行时     | agent/runtime.ts        | ✅ 完成 |
| 多 Agent 协作    | collaboration/          | ✅ 完成 |
| 持久记忆(三层)   | memory/ + persistence/  | ✅ 完成 |
| 安全沙箱(三级)   | security/               | ✅ 完成 |
| 自我进化引擎     | evolution/              | ✅ 完成 |
| MCP 工具集成     | mcp/                    | ✅ 完成 |
| 提示工程(10 层)  | prompt/                 | ✅ 完成 |
| 技能市场         | skills/                 | ✅ 完成 |
| 定时任务         | cron/                   | ✅ 完成 |
| 语音 STT/TTS     | voice/                  | ✅ 完成 |
| IM 网关(8 平台)  | services/im-gateway/    | ✅ 完成 |
| Web UI(13 页面)  | packages/web/           | ✅ 完成 |

---

## 2. 仓库结构

```
super-agent/
├── package.json                 # 根工作区(scripts: dev/build/start)
├── pnpm-workspace.yaml          # packages/* + services/*
├── .env.example                 # 全局环境变量模板
├── data/                        # 运行时数据(SQLite 文件)
│
├── packages/
│   ├── core/                    # @super-agent/core — 核心 SDK
│   │   └── src/
│   │       ├── index.ts         # 189 行 — 主导出(60+ 符号)
│   │       ├── types/index.ts   # 293 行 — 全量类型 + Zod schemas
│   │       ├── agent/           # Agent 运行时 & 管理器
│   │       ├── llm/             # LLM 提供商抽象
│   │       ├── memory/          # 三层记忆系统
│   │       ├── persistence/     # SQLite 持久化(1055 行)
│   │       ├── security/        # 沙箱 & 凭证保险箱
│   │       ├── prompt/          # 10 层提示工程
│   │       ├── skills/          # 技能加载 & 市场
│   │       ├── mcp/             # MCP 客户端 & 注册表
│   │       ├── evolution/       # 自我进化引擎(702 行)
│   │       ├── collaboration/   # 多 Agent 协作(657 行)
│   │       ├── tools/           # 15 个内置工具
│   │       ├── voice/           # 语音 STT/TTS
│   │       ├── cron/            # 定时任务调度
│   │       ├── routing/         # 消息路由
│   │       └── __tests__/       # 单元测试
│   │
│   ├── api/                     # @super-agent/api — Fastify HTTP 服务
│   │   └── src/
│   │       ├── index.ts         # 143 行 — 服务器启动
│   │       ├── context.ts       # 150 行 — AppContext 工厂
│   │       ├── auth/            # JWT/API-Key/RBAC
│   │       ├── middleware/      # 请求链中间件
│   │       ├── ws/              # WebSocket 事件流
│   │       └── routes/          # 11 个路由模块
│   │
│   └── web/                     # @super-agent/web — Next.js 16 前端
│       └── src/
│           ├── app/             # 13 个页面 + layout
│           └── components/      # UI 组件库
│
└── services/
    └── im-gateway/              # Python FastAPI 微服务
        ├── server.py            # 284 行 — 入口 & 路由
        ├── bridge.py            # 220 行 — Agent API 桥接
        ├── adapter_manager.py   # 196 行 — 适配器管理
        └── adapters/            # IM 平台适配器
```

---

## 3. packages/core

> 核心 SDK，可独立使用(不依赖 api/web)

### 3.1 agent/ — Agent 运行时

| 文件         | 行数 | 核心类          | 职责                                 |
| ------------ | ---- | --------------- | ------------------------------------ |
| runtime.ts   | 545  | `AgentRuntime`  | 单 Agent 执行引擎，消息处理+工具调用 |
| manager.ts   | 143  | `AgentManager`  | 多 Agent 注册/查找/全局工具          |

**AgentRuntime 关键方法**：
```
constructor(options: AgentRuntimeOptions)
processMessage(messages: LLMMessage[]): Promise<LLMResponse>
registerTool(tool: ToolDefinition): void
executeTool(name, args, context): Promise<ToolResult>
  ├── sandboxLevel === "process" → ProcessSandbox
  ├── sandboxLevel === "docker"/"container" → DockerSandbox (降级→process)
  ├── sandboxLevel === "ssh" → SSHSandbox (降级→process)
  └── 无沙箱 → 直接执行
```

### 3.2 llm/ — LLM 提供商

| 文件        | 行数 | 核心类        | 职责                        |
| ----------- | ---- | ------------- | --------------------------- |
| provider.ts | 210  | `LLMProvider` | OpenAI/Anthropic/Ollama 统一接口 |

支持 Fallback 自动降级机制。调用链：`chat()` → 主 provider → 失败 → fallback provider。

### 3.3 memory/ — 三层记忆系统

| 文件       | 行数 | 核心类/接口                             |
| ---------- | ---- | --------------------------------------- |
| manager.ts | 802  | `MemoryManager`, `MemoryBackend`(接口) |

**Letta 三层架构**：

| 层          | 用途               | 存储           | 访问方式     |
| ----------- | ------------------ | -------------- | ------------ |
| Core Memory | 常驻人设/目标/用户 | XML 块(可编辑) | 始终注入提示 |
| Recall      | 最近对话历史       | SQLite         | 搜索/分页    |
| Archival    | 长期知识           | SQLite + FTS5  | 语义搜索     |

**Embedding 提供商**：
- `QwenEmbedding` — 通义千问 text-embedding-v4 (2048 维, 生产推荐)
- `SimpleEmbedding` — 内置哈希 (无外部依赖, 降级方案)

**后端**：
- `InMemoryBackend` — 开发/测试
- `SQLiteBackend` — 生产持久化

### 3.4 persistence/ — SQLite 持久化

| 文件      | 行数 | 导出                                    |
| --------- | ---- | --------------------------------------- |
| sqlite.ts | 1055 | `initDatabase`, `getDatabase`, 30+ CRUD |

使用 sql.js (WASM) 实现零原生依赖的 SQLite。支持 FTS5 全文搜索。

### 3.5 security/ — 安全沙箱

| 文件              | 行数 | 核心类             | 职责                        |
| ----------------- | ---- | ------------------ | --------------------------- |
| sandbox.ts        | 804  | `SecurityManager`  | 权限检查/审计/凭证管理      |
|                   |      | `CredentialVault`  | AES-256 加密凭证存储        |
|                   |      | `TokenProxy`       | 不透明 Token 代理           |
|                   |      | `ProcessSandbox`   | child_process 隔离          |
| docker-sandbox.ts | 252  | `DockerSandbox`    | Docker 容器隔离(128m/0.5cpu)|
| ssh-sandbox.ts    | 253  | `SSHSandbox`       | SSH 远程执行                |

**SecurityManager 注入链**：
```
securityManager.setDockerSandbox(dockerSandbox)  // 可选
securityManager.setSSHSandbox(sshSandbox)        // 可选
```

### 3.6 prompt/ — 10 层提示工程

| 文件               | 职责                              |
| ------------------ | --------------------------------- |
| engine.ts (274 行) | 主引擎：按层组装系统提示          |
| guidance.ts        | 工具/记忆使用指导 + 安全栏杆      |
| model-adapters.ts  | LLM 模型特定最佳实践              |
| platform-hints.ts  | 平台特定提示(IM 通道等)           |
| context-files.ts   | 项目上下文文件发现(.env 等)       |
| injection-guard.ts | 提示注入防御(正则+启发式检测)     |

**层级结构**：
```
┌─ 稳定前缀 (缓存复用) ─────────────┐
│ L1  Agent 身份 (role/goal/backstory) │
│ L2  工具使用强制指导                  │
│ L3  模型特定指导 (Qwen/GPT/Llama)    │
│ L4  记忆使用指导                      │
│ L5  技能清单                          │
│ L6  安全栏杆 & 注入防御               │
├─ 动态部分 (每轮重建) ─────────────┤
│ L7  Core Memory 块 (XML)             │
│ L8  项目上下文文件                    │
│ L9  可用工具 + 会话信息               │
│ L10 平台提示                          │
└───────────────────────────────────┘
```

### 3.7 skills/ — 技能系统

| 文件            | 行数 | 核心类             | 职责                    |
| --------------- | ---- | ------------------ | ----------------------- |
| loader.ts       | 217  | `SkillLoader`      | 本地技能热加载(chokidar)|
| marketplace.ts  | 283  | `SkillMarketplace` | 远程技能安装/版本管理   |
| parser.ts       | 146  | `parseSkillFile()` | 多格式解析              |

**兼容格式**：OpenClaw (纯 MD) / Hermes (YAML frontmatter) / Super Agent (扩展 frontmatter)

### 3.8 mcp/ — Model Context Protocol

| 文件        | 行数 | 核心类        | 职责                      |
| ----------- | ---- | ------------- | ------------------------- |
| client.ts   | 389  | `MCPClient`   | 连接单个 MCP 服务器       |
| registry.ts | 203  | `MCPRegistry` | 多服务器管理 & 跨服务调用 |

**传输模式**：stdio / SSE / streamable-http
**认证**：bearer / api-key / basic (MCPAuthConfig)

### 3.9 evolution/ — 自我进化

| 文件      | 行数 | 核心类                                         |
| --------- | ---- | ---------------------------------------------- |
| engine.ts | 702  | `EvolutionEngine`, `NudgeTracker`, `CaseCollector` |

**双引擎设计**：

| 机制           | 灵感来源 | 流程                                          |
| -------------- | -------- | --------------------------------------------- |
| Nudge 系统     | Hermes   | 定期记忆/技能回顾 → LLM 总结 → 更新 Core Memory |
| 技能进化       | MemSkill | 收集失败 → 模式分析 → LLM 两阶段改进 → 写文件  |

**applyProposal()** 将提案内容写入 `skillsDir/` 为带 YAML frontmatter 的 .md 文件。

### 3.10 collaboration/ — 多 Agent 协作

| 文件             | 行数 | 核心类                    |
| ---------------- | ---- | ------------------------- |
| orchestrator.ts  | 657  | `CollaborationOrchestrator` |

**两种编排模式**：

| 模式         | 灵感来源 | 特点                           |
| ------------ | -------- | ------------------------------ |
| 任务编排     | CrewAI   | Sequential/Hierarchical, 任务流 |
| 对话协商     | AutoGen  | GroupChat, 动态发言, Handoff    |

### 3.11 其他模块

| 模块            | 文件              | 行数 | 职责                                |
| --------------- | ----------------- | ---- | ----------------------------------- |
| tools/          | 4 个文件          | ~400 | 15 个内置工具(文件/代码/系统/Web)   |
| voice/          | provider.ts + aliyun.ts | 52+6KB | STT/TTS 接口 + 阿里云实现     |
| cron/           | scheduler.ts      | 351  | Cron 调度(表达式+自然语言)          |
| routing/        | router.ts         | ~100 | 消息分发路由                        |

---

## 4. packages/api

> Fastify 5 HTTP 服务器，端口 3001

### 启动流程

```
index.ts:main()
  ├─ 创建 Fastify 实例 (日志/CORS)
  ├─ 注册中间件 (requestId/rateLimit/errorHandler)
  ├─ createAppContext()           ← context.ts
  │   ├─ initDatabase()          (SQLite)
  │   ├─ new MemoryManager()     (SQLiteBackend + QwenEmbedding)
  │   ├─ new SecurityManager()
  │   │   ├─ DockerSandbox 探测 → setDockerSandbox()
  │   │   └─ SSH 环境变量检测   → setSSHSandbox()
  │   ├─ new LLMProvider()
  │   ├─ new PromptEngine()
  │   ├─ new AgentManager()
  │   ├─ new SkillLoader() + 热监听
  │   ├─ new MCPRegistry()
  │   ├─ new CronScheduler()
  │   ├─ new EvolutionEngine()
  │   └─ new CollaborationOrchestrator()
  ├─ 注册 11 个路由模块
  ├─ 创建默认 Agent (如不存在)
  └─ 监听 0.0.0.0:3001
```

### API 路由表

| 路由文件        | 前缀                | 核心端点                                         |
| --------------- | ------------------- | ------------------------------------------------ |
| agents.ts       | /api/agents         | GET/ POST/ GET/:id/ PUT/:id/ DELETE/:id          |
| chat.ts         | /api/chat           | POST/ POST/stream/ GET/history                   |
| skills.ts       | /api/skills         | GET/ POST/install/ DELETE/:name                  |
| channels.ts     | /api/channels       | GET/ POST/ PUT/:id/ DELETE/:id/ POST/:id/connect |
| memory.ts       | /api/memory         | GET/search/ POST/ DELETE/:id/ GET/stats          |
| collaboration.ts| /api/collaboration  | POST/crew/ POST/groupchat/ GET/history           |
| evolution.ts    | /api/evolution      | GET/proposals/ POST/analyze/ POST/:id/approve/apply |
| security.ts     | /api/security       | GET/policies/ POST/credentials/ GET/audit        |
| mcp.ts          | /api/mcp            | GET/servers/ POST/register/ POST/:id/tools       |
| cron.ts         | /api/cron           | GET/jobs/ POST/ PUT/:id/ DELETE/:id/ GET/history |
| voice.ts        | /api/voice          | POST/stt/ POST/tts                               |

### WebSocket

`ws/index.ts` — 实时事件推送：
- `agent:message` — Agent 消息
- `agent:tool-call` — 工具调用事件
- `agent:status` — Agent 状态变更
- 连接鉴权：JWT token 参数

---

## 5. packages/web

> Next.js 16.2.3 + React 19 + Tailwind CSS 4，端口 3000

### 页面清单

| 路径            | 页面          | 行数 | 功能                             |
| --------------- | ------------- | ---- | -------------------------------- |
| /dashboard      | 仪表盘        | 197  | 统计概览、系统状态               |
| /agents         | Agent 管理    | 241  | CRUD、模型配置、状态面板         |
| /chat           | 对话          | 620  | 消息收发、文件上传、语音输入     |
| /channels       | 通道管理      | 247  | IM 集成配置、连接状态            |
| /skills         | 技能市场      | 249  | 本地技能、远程安装、版本管理     |
| /memory         | 记忆管理      | 145  | 语义搜索、统计、删除             |
| /mcp            | MCP 工具      | 258  | 服务器注册、工具浏览、调用       |
| /cron           | 定时任务      | 259  | 任务 CRUD、执行历史              |
| /collaboration  | 多 Agent 协作 | 259  | Crew 编排、GroupChat             |
| /evolution      | 进化引擎      | 171  | 技能提案列表、审批/应用          |
| /security       | 安全管理      | 238  | 策略配置、凭证管理               |
| /settings       | 系统设置      | 186  | 全局配置                         |

### 侧边栏导航

```
components/layout/sidebar.tsx
├── 仪表盘        → /dashboard        (LayoutDashboard)
├── Agent 管理    → /agents           (Bot)
├── 对话          → /chat             (MessageSquare)
├── 通道管理      → /channels         (Radio)
├── 技能市场      → /skills           (Puzzle)
├── 记忆管理      → /memory           (Brain)
├── MCP 工具      → /mcp              (Wrench)
├── 定时任务      → /cron             (Clock)
├── 多 Agent 协作 → /collaboration    (Users)
├── 进化引擎      → /evolution        (Dna)
├── 安全管理      → /security         (Shield)
└── 系统设置      → /settings         (Settings)
```

---

## 6. services/im-gateway

> Python FastAPI 微服务，端口 8642

### 架构

```
IM 平台 ──webhook/长轮询──→ Adapter ──→ AdapterManager
                                            │
                                    ┌───────┼───────┐
                                    ▼       ▼       ▼
                                 server.py bridge.py adapter_manager.py
                                    │       │
                                    │  HTTP POST /api/chat
                                    │       │
                                    ▼       ▼
                              Super Agent API (localhost:3001)
```

### 核心文件

| 文件               | 行数 | 职责                                   |
| ------------------ | ---- | -------------------------------------- |
| server.py          | 284  | FastAPI 路由、全局消息处理器、语音转文字 |
| bridge.py          | 220  | AgentBridge — HTTP 桥接、STT 转写      |
| adapter_manager.py | 196  | 适配器生命周期管理、动态加载           |

### 支持的 IM 平台

| 平台       | 环境变量前缀     | 状态 |
| ---------- | ---------------- | ---- |
| 企业微信   | WECOM_*          | ✅   |
| 飞书       | FEISHU_*         | ✅   |
| 钉钉       | DINGTALK_*       | ✅   |
| 微信       | WEIXIN_*         | ✅   |
| Telegram   | TELEGRAM_*       | ✅   |
| Discord    | DISCORD_*        | ✅   |
| Slack      | SLACK_*          | ✅   |
| Webhook    | WEBHOOK_*        | ✅   |

### 语音转文字流程

```
收到语音消息 → bridge.transcribe_audio(audio_url)
  → POST {STT_BASE_URL}/v1/audio/transcriptions
  → 返回文本 → 追加到消息内容
  → bridge.send_message() → API
```

---

## 7. 核心类型系统

> `packages/core/src/types/index.ts` (293 行)

### 主要类型

```typescript
// ── Agent ──
AgentConfig { id, name, role, goal, backstory, model, provider, tools, ... }
AgentState  { id, status, currentTask, lastActive }

// ── LLM ──
LLMProviderConfig { provider, model, apiKey, baseUrl, fallback? }
LLMMessage  { role: "system"|"user"|"assistant"|"tool", content, ... }
LLMResponse { content, toolCalls?, usage }

// ── 消息 ──
InboundMessage  { id, channelId, userId, content, attachments?, metadata }
OutboundMessage { channelId, content, attachments?, replyTo? }
Attachment      { type, url, name, size?, mimeType? }

// ── 记忆 ──
MemoryEntry       { id, agentId, content, type, embedding?, metadata }
MemorySearchResult { entry, score }

// ── 工具 ──
ToolDefinition  { name, description, parameters(Zod), execute() }
ToolContext      { agentId, sessionId, userId, memory, ... }
ToolResult       { success, output, error? }

// ── 技能 ──
Skill           { name, description, content, version, author, ... }
SkillFrontmatter { name, description, version, triggers?, ... }

// ── 通道 ──
ChannelConfig { id, platform, credentials, agentId, ... }
ChannelState  { id, status, connectedAt, messageCount }

// ── 事件 ──
PlatformEvent { type, payload, timestamp }
```

### Zod Schemas

```typescript
AgentConfigSchema    // Agent 配置验证
ChatMessageSchema    // 聊天消息验证
ChannelConfigSchema  // 通道配置验证
```

---

## 8. 模块深度解读

### 8.1 沙箱路由决策树

```
executeTool(name, args)
  │
  ├─ sandboxLevel === "process"
  │   └─ ProcessSandbox.executeWithTimeout(30s, 128MB)
  │
  ├─ sandboxLevel === "docker" | "container"
  │   ├─ DockerSandbox 可用? → DockerSandbox.execute()
  │   └─ 不可用 → 降级 ProcessSandbox ⚠️ warn
  │
  ├─ sandboxLevel === "ssh"
  │   ├─ SSHSandbox 可用? → SSHSandbox.execute()
  │   └─ 不可用 → 降级 ProcessSandbox ⚠️ warn
  │
  └─ 无沙箱 → tool.execute(args, context) 直接执行
```

### 8.2 MCP 连接流程

```
MCPClient.connect()
  ├─ transport === "stdio"
  │   └─ 启动子进程 → JSON-RPC over stdin/stdout
  │
  └─ transport === "sse" | "streamable-http"
      └─ POST {url} (JSON-RPC initialize)
         ├─ Headers: buildAuthHeaders() 注入认证
         └─ 解析 capabilities
```

### 8.3 进化引擎工作循环

```
recordInteraction(case)
  → CaseCollector 积累
  → 达到阈值
  → analyzeFailures()
     → LLM 模式分析
     → proposeSkillImprovements()
        → SkillProposal (pending)
        → approveProposal()
           ├─ autoApplySkills? → applyProposal() 自动写文件
           └─ 等待人工审批
              → POST /api/evolution/proposals/:id/apply
                 → applyProposal() → 写入 skillsDir/*.md
```

---

## 9. 数据持久化

### SQLite 表结构

| 表名                  | 用途                  |
| --------------------- | --------------------- |
| memories              | 记忆条目(含 embedding)|
| memories_fts          | FTS5 全文搜索虚拟表   |
| agents                | Agent 配置            |
| sessions              | 对话会话              |
| sessions_fts          | FTS5 会话搜索         |
| core_memory_blocks    | Core Memory 块        |
| security_policies     | 安全策略              |
| cron_jobs             | 定时任务定义          |
| cron_history          | 任务执行历史          |
| mcp_servers           | MCP 服务器配置        |
| installed_skills      | 已安装技能元数据      |
| collaboration_history | 协作执行历史          |
| skill_proposals       | 进化技能提案          |

### 关键操作函数 (30+)

```typescript
// 数据库生命周期
initDatabase(path?) → Database
getDatabase() → Database
saveDatabase() → void

// Agent
saveAgentConfig(config) / loadAgentConfig(id) / listAgentConfigs()

// 记忆
insertMemory(entry) / searchMemories(query, filters, topK)
upsertCoreBlock(agentId, label, value) / getCoreBlocks(agentId)

// 会话
createSession(session) / getSession(id) / listSessions(agentId)

// 全文搜索
searchMemoriesFTS(query) / searchSessionsFTS(query)

// Cron
saveCronJob(job) / getCronJobs() / saveCronHistory(record)

// MCP
saveMCPServer(config) / getMCPServers() / deleteMCPServer(id)

// 技能
saveInstalledSkill(meta) / getInstalledSkills()
```

---

## 10. 消息处理流程

### 完整请求链

```
[IM 平台]
    │ webhook/长轮询
    ▼
[IM Gateway] server.py
    │ adapter 解析 → 语音转文字(如有)
    │ bridge.send_message()
    ▼
[API Server] POST /api/chat          ← packages/api/routes/chat.ts
    │ 认证 → 限流 → 路由
    ▼
[AgentRuntime] processMessage()       ← packages/core/agent/runtime.ts
    │
    ├─ PromptEngine.build()           组装 10 层系统提示
    │   ├─ L1-L6 稳定缓存
    │   └─ L7-L10 动态注入
    │
    ├─ MemoryManager.recall()         回忆相关记忆
    │
    ├─ LLMProvider.chat()             调用 LLM
    │   ├─ 主 provider
    │   └─ fallback (如失败)
    │
    ├─ [如有 tool_calls]
    │   └─ executeTool() → 沙箱路由 → 工具结果 → 再次 LLM
    │
    ├─ MemoryManager.add()            存储本轮记忆
    │
    └─ return LLMResponse
         │
         ▼
[API Server] → HTTP Response / WebSocket push
         │
         ▼
[IM Gateway] bridge 回调 → adapter 发送
         │
         ▼
[IM 平台] 用户收到回复
```

---

## 11. 环境变量

### 核心配置 (.env.example)

```bash
# ── 服务 ──
PORT=3001                              # API 端口
HOST=0.0.0.0                           # 监听地址
LOG_LEVEL=info                         # 日志级别 (debug/info/warn/error)
FRONTEND_URL=http://localhost:3000     # CORS 允许的前端 URL

# ── LLM ──
LLM_PROVIDER=openai                    # openai / anthropic / ollama
LLM_MODEL=gpt-4o-mini                 # 模型名
LLM_API_KEY=sk-...                     # API 密钥
LLM_BASE_URL=                          # 自定义 base URL

# ── 安全 ──
JWT_SECRET=your-secret                 # JWT 签名密钥

# ── IM 网关 ──
IM_GATEWAY_URL=http://localhost:8642   # 网关地址

# ── 可选: 通义千问 Embedding ──
DASHSCOPE_API_KEY=                     # 阿里云 DashScope

# ── 可选: SSH 沙箱 ──
SSH_SANDBOX_HOST=                      # SSH 主机
SSH_SANDBOX_USER=                      # SSH 用户
SSH_SANDBOX_KEY_PATH=                  # 私钥路径
SSH_SANDBOX_PASSWORD=                  # 密码(备选)
SSH_SANDBOX_PORT=22                    # SSH 端口
SSH_SANDBOX_TIMEOUT=30000              # 超时(ms)
SSH_SANDBOX_WORKDIR=/tmp/sa-sandbox    # 远程工作目录
```

---

## 12. 开发指南

### 快速启动

```bash
# 安装依赖
pnpm install

# 启动开发 (全部)
pnpm dev          # 并行启动 core(watch) + api(dev) + web(dev)

# 单独启动
pnpm --filter @super-agent/core dev    # 端口: N/A (库)
pnpm --filter @super-agent/api dev     # 端口: 3001
pnpm --filter @super-agent/web dev     # 端口: 3000

# 构建
pnpm build

# IM 网关 (Python)
cd services/im-gateway
pip install -e .
uvicorn server:app --port 8642
```

### 编译检查 (Windows 提速)

```powershell
# ❌ 慢 — npx 查找路径开销大
npx tsc --noEmit

# ✅ 快 — 直接调用 tsc.cmd
& "packages\core\node_modules\.bin\tsc.cmd" --noEmit
& "packages\api\node_modules\.bin\tsc.cmd" --noEmit
```

### 代码风格

- TypeScript strict mode
- ESM 模块 (import/export)
- pino 日志 (结构化 JSON)
- Zod 运行时验证
- EventEmitter3 事件系统

### 添加新模块检查清单

1. 在 `packages/core/src/` 下创建模块目录
2. 编写核心逻辑 + 类型定义
3. 在 `index.ts` 中导出公共 API
4. 在 `packages/api/src/routes/` 添加 API 路由
5. 在 `packages/api/src/context.ts` 中初始化模块
6. 在 `packages/web/src/app/` 添加前端页面
7. 更新侧边栏导航 `sidebar.tsx`

---

## 依赖关系图

```
                    ┌──────────────┐
                    │  packages/web │ (Next.js 16)
                    │  :3000        │
                    └──────┬───────┘
                           │ HTTP fetch
                           ▼
                    ┌──────────────┐
                    │ packages/api  │ (Fastify 5)
                    │ :3001         │
                    └──────┬───────┘
                           │ import
                           ▼
                    ┌──────────────┐
                    │ packages/core │ (SDK)
                    └──────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐   ┌─────────┐
         │ sql.js │  │ openai │   │ MCP/外部 │
         └────────┘  └────────┘   └─────────┘

         ┌────────────────────┐
         │ services/im-gateway │ (Python FastAPI)
         │ :8642               │
         └────────┬───────────┘
                  │ HTTP POST /api/chat
                  ▼
         ┌──────────────┐
         │ packages/api  │
         └──────────────┘
```
