# Super Agent — Repo Wiki

> **模块化通用 AI Agent 平台** · Monorepo 架构 · v0.1.0
>
> 最后更新: 2026-04-21

---

## 目录

1. [项目总览](#1-项目总览)
2. [仓库结构](#2-仓库结构)
3. [packages/core — 核心引擎](#3-packagescore--核心引擎)
4. [packages/api — API 服务](#4-packagesapi--api-服务)
5. [packages/web — 前端 UI](#5-packagesweb--前端-ui)
6. [packages/monitor — 监控面板](#6-packagesmonitor--监控面板)
7. [services/im-gateway — IM 网关](#7-servicesim-gateway--im-网关)
8. [核心类型系统](#8-核心类型系统)
9. [模块深度解读](#9-模块深度解读)
10. [数据流与消息处理](#10-数据流与消息处理)
11. [数据持久化](#11-数据持久化)
12. [全链路追踪](#12-全链路追踪)
13. [插件系统](#13-插件系统)
14. [环境变量与配置](#14-环境变量与配置)
15. [开发指南](#15-开发指南)
16. [依赖关系图](#16-依赖关系图)

---

## 1. 项目总览

| 属性         | 值                                       |
| ------------ | ---------------------------------------- |
| 包管理器     | pnpm ≥ 9.0.0 (workspace)               |
| Node 版本    | ≥ 20.0.0                                |
| 核心语言     | TypeScript (前后端) + Python (IM 网关)   |
| 构建工具     | tsup (core/api) · Next.js 16 (web)      |
| 运行时数据库 | sql.js (WASM SQLite, 零原生依赖)         |
| 日志框架     | pino (结构化 JSON)                       |
| 类型验证     | Zod 3.24                                 |

### 核心能力矩阵

| 能力               | 模块                      | 关键文件                  | 状态 |
| ------------------ | ------------------------- | ------------------------- | ---- |
| Agent 运行时       | agent/                    | runtime.ts (1453 行)      | ✅   |
| 多 Agent 协作      | collaboration/            | orchestrator.ts (28.8KB)  | ✅   |
| 持久记忆 (三层)    | memory/ + persistence/    | manager.ts (51.9KB)       | ✅   |
| 安全沙箱 (三级)    | security/                 | sandbox.ts (29.7KB)       | ✅   |
| 自我进化引擎       | evolution/                | engine.ts (41.1KB)        | ✅   |
| MCP 工具集成       | mcp/                      | client.ts (17.9KB)        | ✅   |
| 提示工程 (10 层)   | prompt/                   | engine.ts (274 行)        | ✅   |
| 技能市场           | skills/                   | marketplace.ts (20.4KB)   | ✅   |
| 定时任务           | cron/                     | scheduler.ts (351 行)     | ✅   |
| 语音 STT/TTS       | voice/                    | aliyun.ts                 | ✅   |
| 上下文管理         | context/                  | compressor.ts (20.2KB)    | ✅   |
| 媒体处理           | media/                    | loader.ts + store.ts      | ✅   |
| 工具集 (30+)       | tools/                    | 24 个文件, 4 个子目录     | ✅   |
| 全链路追踪         | tracing/                  | tracer.ts + instrument.ts | ✅   |
| 插件系统           | plugins/                  | registry.ts + hooks.ts    | ✅   |
| IM 网关 (8 平台)   | services/im-gateway/      | server.py (40.3KB)        | ✅   |
| Web UI (14 页面)   | packages/web/             | 14 个路由页面             | ✅   |
| API 服务 (17 路由) | packages/api/routes/      | 17 个路由文件             | ✅   |
| 监控面板           | packages/monitor/         | Electron 独立窗口         | ✅   |

---

## 2. 仓库结构

```
super-agent/
├── package.json                 # 根工作区 (scripts: dev/build/start/test/clean)
├── pnpm-workspace.yaml          # packages/* + services/*
├── .env.example                 # 全局环境变量模板
├── .env                         # 运行时环境变量 (不入库)
├── REPO-WIKI.md                 # 本文件
├── FIX-PLAN-2026-04-15.md       # 修复规划文档 (84 个问题)
│
├── data/                        # 运行时数据目录
│   ├── MEMORY.md                # Agent 持久化内存块 (Markdown 格式)
│   ├── SOUL.md                  # Agent 人设灵魂档案
│   ├── USER.md                  # 用户档案数据
│   ├── super-agent.db           # SQLite 数据库文件
│   ├── super-agent.db.bak       # 数据库自动备份
│   ├── backups/                 # 增量备份
│   ├── cache/                   # 缓存目录
│   ├── logs/                    # 日志输出
│   ├── sessions/                # 会话 JSONL 序列化
│   └── skills/                  # 技能文件存储
│
├── docs/                        # 项目文档
│   ├── SPEC-media-service-layer.md         # 媒体服务层规格书
│   ├── system-prompt-engineering-research.md # 提示工程研究
│   ├── 三项目全面对比.md                    # Super Agent / OpenClaw / Hermes 对比
│   └── 飞书通道P0-P2修复计划.md             # 飞书适配修复
│
├── packages/
│   ├── core/                    # @super-agent/core — 核心 SDK (可独立使用)
│   ├── api/                     # @super-agent/api  — Fastify 5 HTTP 服务
│   ├── web/                     # @super-agent/web  — Next.js 16 前端
│   └── monitor/                 # @super-agent/monitor — Electron 监控面板
│
└── services/
    └── im-gateway/              # Python FastAPI 微服务 — IM 平台适配
```

---

## 3. packages/core — 核心引擎

> `@super-agent/core` · 可独立使用，不依赖 api/web · ESM 模块

### 3.1 目录总览

```
packages/core/src/
├── index.ts              # 主导出 (14.9KB, 60+ 公开符号)
├── types/index.ts        # 全量类型定义 (377 行)
│
├── agent/                # Agent 运行时 & 管理器
│   ├── runtime.ts        # AgentRuntime — 单 Agent 执行引擎 (1453 行)
│   ├── manager.ts        # AgentManager — 全局 Agent 管理
│   └── index.ts
│
├── llm/                  # LLM 提供商抽象
│   ├── provider.ts       # LLMProvider — OpenAI SDK 统一封装 (10.8KB)
│   ├── provider-store.ts # 多供应商配置存储 (11.9KB)
│   ├── model-catalog.ts  # 模型目录 & 供应商声明 (14.2KB)
│   ├── model-capabilities.ts  # 能力检测 (视觉/推理/PDF)
│   └── index.ts
│
├── memory/               # 三层记忆系统 (Letta 架构)
│   ├── manager.ts        # MemoryManager — Core/Recall/Archival (51.9KB)
│   ├── markdown-memory.ts # Markdown 持久化 (9.8KB)
│   ├── provider.ts       # 内存提供商编排 (8.7KB)
│   ├── entity-resolver.ts # 实体提取 & 别名解析 (3.2KB)
│   ├── hrr.ts            # 向量符号架构 HRR (8.6KB)
│   └── plugin-loader.ts  # 内存插件发现 (2.5KB)
│
├── persistence/          # 持久化层
│   ├── sqlite.ts         # SQLite WASM (sql.js) 持久化 (1055 行)
│   └── jsonl-writer.ts   # JSONL 会话序列化
│
├── security/             # 安全隔离 & 审计
│   ├── sandbox.ts        # SecurityManager + CredentialVault + TokenProxy + ProcessSandbox (29.7KB)
│   ├── docker-sandbox.ts # Docker 容器隔离 (7.7KB)
│   ├── ssh-sandbox.ts    # SSH 远程执行 (7.4KB)
│   ├── sysops-security.ts # 系统操作安全策略 (7.3KB)
│   ├── approval.ts       # 安全审批机制 (6.5KB)
│   ├── command-guard.ts  # 命令安全守卫 (14.5KB)
│   ├── write-guard.ts    # 写操作守卫 (5.0KB)
│   ├── env-isolation.ts  # 环境隔离 (8.8KB)
│   └── shared-security.ts # 共享安全上下文 (2.5KB)
│
├── prompt/               # 10 层提示工程引擎
│   ├── engine.ts         # 主引擎: 按层组装系统提示 (274 行)
│   ├── guidance.ts       # 工具/记忆使用指导
│   ├── model-adapters.ts # 模型特定最佳实践 (Qwen/GPT/DeepSeek)
│   ├── platform-hints.ts # 平台特定提示 (IM 通道等)
│   ├── context-files.ts  # 项目上下文文件发现
│   └── injection-guard.ts # 提示注入防御 (正则+启发式)
│
├── skills/               # 技能系统 (热加载+市场)
│   ├── loader.ts         # 技能热加载器 (chokidar 监听) (8.4KB)
│   ├── marketplace.ts    # 远程技能安装/版本管理 (20.4KB)
│   ├── parser.ts         # 多格式技能解析 (4.8KB)
│   ├── commands.ts       # 斜杠命令激活 (6.6KB)
│   ├── guard.ts          # 技能安全审计 (22.3KB)
│   ├── readiness.ts      # 就绪状态机 (11.5KB)
│   ├── lockfile.ts       # 版本锁定管理 (10.4KB)
│   ├── snapshot-cache.ts # 技能快照缓存 (8.7KB)
│   ├── config-inject.ts  # 技能配置注入 (9.3KB)
│   ├── tools.ts          # 技能相关工具定义 (14.6KB)
│   ├── sources/          # 多源适配器
│   │   ├── base.ts       # 基础适配器接口
│   │   ├── router.ts     # SourceRouter 统一路由
│   │   ├── skillhub.ts   # SkillHub 源
│   │   ├── github.ts     # GitHub 源
│   │   ├── clawhub.ts    # ClawHub 源
│   │   └── local.ts      # 本地源
│   └── index.ts
│
├── mcp/                  # Model Context Protocol 集成
│   ├── client.ts         # MCP 客户端 (17.9KB)
│   ├── server.ts         # MCP 服务端能力 (12.6KB)
│   ├── registry.ts       # 多服务器管理 (8.2KB)
│   ├── marketplace.ts    # MCP 官方市场 (7.7KB)
│   ├── server-transport.ts # 传输层抽象 (7.7KB)
│   ├── event-bridge.ts   # 事件桥接 (8.2KB)
│   └── index.ts
│
├── evolution/            # 自我进化引擎
│   ├── engine.ts         # 双引擎: Nudge + 技能进化 (41.1KB)
│   ├── session-search.ts # 会话搜索引擎 (9.1KB)
│   ├── knowledge-extractor.ts # 知识提取 (11.8KB)
│   ├── insights.ts       # 洞察生成 (11.5KB)
│   └── verification.ts   # A/B 验证流程 (8.4KB)
│
├── collaboration/        # 多 Agent 协作
│   ├── orchestrator.ts   # 编排器: Crew + GroupChat (28.8KB)
│   ├── subagent-spawn.ts # 子代理生成管理 (13.8KB)
│   ├── subagent-prompt.ts # 子代理系统提示 (7.5KB)
│   └── subagent-announce.ts # 子代理宣告 (7.6KB)
│
├── tools/                # 工具集 (30+ 工具)
│   ├── index.ts          # 工具导出 & 工厂 (7.2KB)
│   ├── filesystem.ts     # 文件系统工具 (7.6KB)
│   ├── code-exec.ts      # 代码执行 (4.7KB)
│   ├── run-shell-cmd.ts  # Shell 命令执行 (2.5KB)
│   ├── system.ts         # 系统信息工具 (6.3KB)
│   ├── web.ts            # Web 搜索/抓取 (8.3KB)
│   ├── productivity.ts   # 生产力工具 (10.9KB)
│   ├── git-tools.ts      # Git 操作 (18.6KB)
│   ├── browser.ts        # 浏览器自动化 (12.4KB)
│   ├── vision.ts         # 视觉分析 (13.6KB)
│   ├── voice-tools.ts    # 语音工具 (10.2KB)
│   ├── media.ts          # 媒体处理 (9.6KB)
│   ├── image-gen.ts      # 图像生成 (11.3KB)
│   ├── data-transform.ts # 数据转换 (15.2KB)
│   ├── configure.ts      # 配置工具 (6.0KB)
│   ├── config-store.ts   # 服务配置存储 (11.3KB)
│   ├── terminal-engine.ts # 终端引擎 (14.7KB)
│   ├── process-registry.ts # 进程注册表 (12.6KB)
│   ├── output-processor.ts # 输出处理器 (8.4KB)
│   ├── shared-security.ts # 共享安全上下文 (8.5KB)
│   ├── browser/          # 浏览器子系统
│   │   ├── index.ts      # 浏览器工具入口 (9.6KB)
│   │   ├── session-manager.ts # 浏览器会话管理
│   │   ├── cookie-store.ts    # Cookie 存储
│   │   ├── security.ts        # 浏览器安全策略
│   │   ├── vision.ts          # 视觉交互
│   │   └── types.ts           # 浏览器类型定义
│   ├── desktop/          # 桌面控制工具
│   │   ├── gui-control.ts     # GUI 控制 (15.3KB)
│   │   ├── screen-capture.ts  # 屏幕截取 (7.5KB)
│   │   ├── app-control.ts     # 应用控制 (7.2KB)
│   │   └── computer-use.ts    # 计算机使用 (6.3KB)
│   ├── ops/              # 运维工具
│   │   ├── system-monitor.ts  # 系统监控 (8.6KB)
│   │   ├── docker-manage.ts   # Docker 管理 (9.4KB)
│   │   ├── deploy-execute.ts  # 部署执行 (9.5KB)
│   │   ├── service-manage.ts  # 服务管理 (8.3KB)
│   │   └── network-diagnose.ts # 网络诊断 (8.2KB)
│   └── dev/              # 开发工具
│       ├── env-manage.ts      # 环境管理 (9.0KB)
│       ├── package-manage.ts  # 包管理 (8.3KB)
│       └── test-build.ts      # 测试构建 (10.5KB)
│
├── voice/                # 语音服务
│   ├── provider.ts       # VoiceProvider 接口
│   └── aliyun.ts         # 阿里云 NLS 实现
│
├── cron/                 # 定时任务调度
│   ├── scheduler.ts      # CronScheduler (351 行)
│   └── heartbeat.ts      # 心跳引擎
│
├── media/                # 媒体处理
│   ├── loader.ts         # 统一媒体加载器 (7.4KB)
│   ├── store.ts          # 本地临时存储 (7.7KB)
│   ├── parse.ts          # 媒体标记解析 (2.7KB)
│   ├── mime.ts           # MIME 检测和转换 (7.3KB)
│   ├── security.ts       # 媒体安全策略 (5.7KB)
│   ├── constants.ts      # 媒体常量定义 (3.7KB)
│   └── index.ts
│
├── context/              # 上下文管理
│   ├── compressor.ts     # 上下文压缩器 (20.2KB)
│   ├── summarizer.ts     # 上下文摘要器 (11.7KB)
│   ├── tool-result-truncation.ts # 工具结果截断 (8.0KB)
│   └── preemptive-check.ts # 抢占式紧凑检查 (5.5KB)
│
├── tracing/              # 全链路追踪
│   ├── tracer.ts         # 追踪核心 (7.3KB)
│   ├── store.ts          # 追踪数据存储 (6.1KB)
│   ├── instrument.ts     # 组件自动埋点 (6.2KB)
│   ├── types.ts          # 追踪类型定义 (2.0KB)
│   └── index.ts
│
├── plugins/              # 插件系统
│   ├── registry.ts       # 插件注册表 (9.3KB)
│   ├── hooks.ts          # Hook 分发系统 (5.2KB)
│   ├── loader.ts         # 插件加载器 (6.5KB)
│   ├── types.ts          # 插件类型定义 (10.6KB)
│   └── adapters/         # 内置适配器
│       ├── channel-adapter.ts  # 通道适配器
│       ├── memory-adapter.ts   # 内存适配器
│       └── tool-adapter.ts     # 工具适配器
│
├── routing/              # 消息路由
│   └── router.ts         # 消息分发路由
│
├── config/               # 配置管理
│   └── index.ts          # 路径解析 & 目录初始化
│
├── platform/             # 平台抽象 (2 文件)
├── utils/                # 工具函数
│   └── content-helpers.ts # 内容帮助函数
│
└── __tests__/            # 单元测试 (17 项)
```

### 3.2 核心依赖

| 依赖            | 版本    | 用途                     |
| --------------- | ------- | ------------------------ |
| openai          | ^4.80.0 | LLM 统一 SDK             |
| sql.js          | ^1.14.1 | WASM SQLite 持久化       |
| zod             | ^3.24.0 | 运行时类型验证           |
| chokidar        | ^4.0.0  | 文件监听 (技能热加载)    |
| eventemitter3    | ^5.0.1  | 事件系统                 |
| gray-matter     | ^4.0.3  | YAML Frontmatter 解析    |
| pino            | ^9.6.0  | 结构化日志               |
| cron-parser     | ^5.5.0  | Cron 表达式解析          |
| uuid            | ^11.1.0 | UUID 生成                |

### 3.3 可选依赖 (按需安装)

| 依赖            | 用途                     |
| --------------- | ------------------------ |
| ssh2            | SSH 远程沙箱             |
| playwright      | 浏览器自动化             |
| xlsx            | Excel 文件处理           |
| pdf-parse       | PDF 文件解析             |
| sharp           | 图像处理                 |
| qrcode          | 二维码生成               |
| @nut-tree/nut-js | 桌面 GUI 控制           |
| diff            | 文本差异比对             |

---

## 4. packages/api — API 服务

> `@super-agent/api` · Fastify 5 · 端口 3001

### 4.1 目录结构

```
packages/api/src/
├── index.ts              # 服务器主入口 (11.3KB)
├── context.ts            # AppContext 工厂 (11.6KB)
├── gateway-launcher.ts   # IM 网关启动器 (5.4KB)
├── auth/
│   └── index.ts          # JWT / API-Key / RBAC 认证
├── middleware/
│   ├── index.ts          # 中间件注册
│   └── error-handler.ts  # 错误处理中间件
├── ws/
│   └── index.ts          # WebSocket 实时推送
├── shared/
│   └── dedup.js          # 请求去重缓存
└── routes/               # 17 个 API 路由模块
    ├── agents.ts          (3.0KB)
    ├── chat.ts            (18.4KB)
    ├── skills.ts          (4.1KB)
    ├── channels.ts        (11.7KB)
    ├── memory.ts          (7.7KB)
    ├── collaboration.ts   (5.4KB)
    ├── evolution.ts       (8.1KB)
    ├── security.ts        (7.8KB)
    ├── mcp.ts             (13.8KB)
    ├── cron.ts            (5.4KB)
    ├── voice.ts           (7.3KB)
    ├── models.ts          (7.4KB)
    ├── services.ts        (4.8KB)
    ├── files.ts           (5.4KB)
    ├── media.ts           (6.7KB)
    ├── settings.ts        (5.7KB)
    └── traces.ts          (6.0KB)
```

### 4.2 启动流程

```
index.ts:main()
  ├─ 创建 Fastify 实例 (pino 日志 / CORS)
  ├─ 注册中间件 (requestId / rateLimit / errorHandler)
  ├─ createAppContext()                    ← context.ts
  │   ├─ initDatabase()                   (SQLite WASM)
  │   ├─ new MemoryManager()              (SQLiteBackend + QwenEmbedding)
  │   ├─ new SecurityManager()
  │   │   ├─ DockerSandbox 探测           → setDockerSandbox()
  │   │   └─ SSH 环境变量检测             → setSSHSandbox()
  │   ├─ new LLMProvider()
  │   ├─ new PromptEngine()
  │   ├─ new AgentManager()
  │   ├─ new SkillLoader() + chokidar 热监听
  │   ├─ new MCPRegistry()
  │   ├─ new CronScheduler()
  │   ├─ new EvolutionEngine()
  │   ├─ new CollaborationOrchestrator()
  │   ├─ Feature Flag 恢复 (ConfigStore)
  │   └─ return AppContext
  ├─ 注册 17 个路由模块
  ├─ 恢复/创建默认 Agent
  ├─ 监听 0.0.0.0:3001
  └─ 启动 IM 网关 (gateway-launcher.ts)
```

### 4.3 完整 API 路由表

#### Agent 管理

| 方法   | 路径                 | 描述             |
| ------ | -------------------- | ---------------- |
| GET    | /api/agents          | 列表所有 Agent   |
| POST   | /api/agents          | 创建 Agent       |
| GET    | /api/agents/:id      | 获取 Agent 详情  |
| PUT    | /api/agents/:id      | 更新 Agent 配置  |
| DELETE | /api/agents/:id      | 删除 Agent       |

#### 消息与会话

| 方法   | 路径                              | 描述                     |
| ------ | --------------------------------- | ------------------------ |
| POST   | /api/chat                         | 发送消息 (同步)          |
| POST   | /api/chat/stream                  | 发送消息 (SSE 流式)      |
| GET    | /api/conversations                | 列表会话                 |
| POST   | /api/conversations                | 创建会话                 |
| GET    | /api/conversations/:id/messages   | 获取消息 (分页)          |
| DELETE | /api/conversations/:id            | 删除会话                 |
| PATCH  | /api/conversations/:id            | 更新会话标题             |
| GET    | /api/conversations/search         | FTS5 全文搜索            |

#### 技能管理

| 方法   | 路径                  | 描述         |
| ------ | --------------------- | ------------ |
| GET    | /api/skills           | 列表本地技能 |
| POST   | /api/skills/install   | 远程安装技能 |
| DELETE | /api/skills/:name     | 卸载技能     |

#### 通道管理

| 方法   | 路径                       | 描述         |
| ------ | -------------------------- | ------------ |
| GET    | /api/channels              | 列表通道     |
| POST   | /api/channels              | 创建通道     |
| PUT    | /api/channels/:id          | 更新配置     |
| DELETE | /api/channels/:id          | 删除通道     |
| POST   | /api/channels/:id/connect  | 连接/激活    |

#### 内存管理

| 方法   | 路径               | 描述         |
| ------ | ------------------ | ------------ |
| GET    | /api/memory/search | 语义搜索     |
| POST   | /api/memory        | 添加内存     |
| DELETE | /api/memory/:id    | 删除内存     |
| GET    | /api/memory/stats  | 统计信息     |

#### 多 Agent 协作

| 方法 | 路径                        | 描述           |
| ---- | --------------------------- | -------------- |
| POST | /api/collaboration/crew     | Crew 编排执行  |
| POST | /api/collaboration/groupchat | GroupChat 执行 |
| GET  | /api/collaboration/history  | 协作历史       |

#### 进化引擎

| 方法 | 路径                               | 描述         |
| ---- | ---------------------------------- | ------------ |
| GET  | /api/evolution/proposals           | 技能提案列表 |
| POST | /api/evolution/analyze             | 分析失败案例 |
| POST | /api/evolution/:id/approve         | 审批提案     |
| POST | /api/evolution/:id/apply           | 应用提案     |

#### 安全管理

| 方法   | 路径                        | 描述             |
| ------ | --------------------------- | ---------------- |
| GET    | /api/security/policies      | 列表安全策略     |
| POST   | /api/security/credentials   | 添加凭证         |
| GET    | /api/security/credentials   | 列表凭证 (加密)  |
| DELETE | /api/security/credentials/:id | 删除凭证       |
| GET    | /api/security/audit         | 审计日志         |

#### MCP 工具

| 方法   | 路径                  | 描述               |
| ------ | --------------------- | ------------------ |
| GET    | /api/mcp/servers      | 列表 MCP 服务器    |
| POST   | /api/mcp/servers      | 注册新服务器       |
| POST   | /api/mcp/:id/tools    | 查询服务器工具     |
| DELETE | /api/mcp/:id          | 注销服务器         |

#### 定时任务

| 方法   | 路径              | 描述         |
| ------ | ----------------- | ------------ |
| GET    | /api/cron/jobs    | 列表任务     |
| POST   | /api/cron         | 创建任务     |
| PUT    | /api/cron/:id     | 更新任务     |
| DELETE | /api/cron/:id     | 删除任务     |
| GET    | /api/cron/history | 执行历史     |

#### 语音服务

| 方法 | 路径            | 描述       |
| ---- | --------------- | ---------- |
| POST | /api/voice/stt  | 语音转文字 |
| POST | /api/voice/tts  | 文字转语音 |

#### LLM 模型

| 方法 | 路径                    | 描述         |
| ---- | ----------------------- | ------------ |
| GET  | /api/models             | 列表可用模型 |
| POST | /api/models/providers   | 配置供应商   |

#### 其他

| 方法     | 路径                    | 描述               |
| -------- | ----------------------- | ------------------ |
| GET/POST | /api/files/*            | 文件上传/下载      |
| GET/POST | /api/media/*            | 媒体服务           |
| GET/POST | /api/services/*         | 服务目录           |
| GET/POST | /api/settings/*         | 系统设置           |
| GET      | /api/traces/*           | 追踪数据查询       |
| POST     | /v1/chat/completions    | OpenAI 兼容端点    |

### 4.4 WebSocket 实时推送

```
ws/index.ts — GET /ws?token={jwt}

事件类型:
  agent:message    — Agent 文本消息
  agent:tool-call  — 工具调用事件 (名称/参数/结果)
  agent:status     — Agent 状态变更 (idle/running/error)
  agent:thinking   — 推理过程 (reasoning content)
```

### 4.5 核心依赖

| 依赖             | 版本     | 用途              |
| ---------------- | -------- | ----------------- |
| fastify          | ^5.3.0   | HTTP 框架         |
| @fastify/cors    | ^11.0.0  | CORS 中间件       |
| @fastify/jwt     | ^9.0.0   | JWT 认证          |
| @fastify/static  | ^8.1.0   | 静态文件服务      |
| @fastify/websocket | ^11.0.0 | WebSocket 支持   |
| mammoth          | ^1.8.0   | Word 文档解析     |
| jszip            | ^3.10.1  | ZIP 文件处理      |
| pdf-parse        | ^1.1.1   | PDF 文件解析      |
| xlsx             | ^0.18.5  | Excel 文件处理    |

---

## 5. packages/web — 前端 UI

> `@super-agent/web` · Next.js 16.2.3 · React 19 · Tailwind CSS 4 · 端口 3000

### 5.1 页面清单

| 路径            | 页面           | 功能描述                          |
| --------------- | -------------- | --------------------------------- |
| /               | 首页           | 自动重定向到 /dashboard           |
| /dashboard      | 仪表盘         | 统计概览、系统状态、资源监控      |
| /agents         | Agent 管理     | CRUD、模型配置、状态面板          |
| /chat           | 对话           | 消息收发、文件上传、语音输入、流式 |
| /channels       | 通道管理       | IM 集成配置、连接状态、凭证管理   |
| /skills         | 技能市场       | 本地技能、远程安装、版本管理      |
| /memory         | 记忆管理       | 语义搜索、统计、删除              |
| /mcp            | MCP 工具       | 服务器注册、工具浏览、工具调用    |
| /cron           | 定时任务       | 任务 CRUD、Cron 表达式、执行历史  |
| /collaboration  | 多 Agent 协作  | Crew 编排、GroupChat 对话         |
| /evolution      | 进化引擎       | 技能提案列表、审批/应用           |
| /security       | 安全管理       | 策略配置、凭证管理、审计日志      |
| /settings       | 系统设置       | 全局配置、Feature Flag            |
| /media          | 媒体管理       | 媒体文件浏览和管理                |

### 5.2 组件结构

```
packages/web/src/
├── app/                  # 14 个路由页面 + layout
│   ├── layout.tsx        # 根布局 (侧边栏 + 内容区)
│   ├── page.tsx          # 首页重定向
│   ├── globals.css       # 全局样式 (Tailwind)
│   └── {route}/page.tsx  # 各功能页面
│
├── components/
│   ├── layout/           # 布局组件 (导航栏/侧边栏)
│   ├── ui/               # 通用 UI 组件
│   └── weclaw-panel.tsx  # WeClaw 集成面板 (11.9KB)
│
├── hooks/                # React 自定义 Hook
└── lib/                  # 工具函数库
```

### 5.3 侧边栏导航

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
├── 媒体管理      → /media            (Image)
└── 系统设置      → /settings         (Settings)
```

### 5.4 技术栈

| 依赖           | 版本     | 用途           |
| -------------- | -------- | -------------- |
| next           | 16.2.3   | React 框架     |
| react          | 19.2.4   | UI 库          |
| lucide-react   | ^0.500.0 | 图标库         |
| tailwindcss    | ^4       | CSS 框架       |
| clsx           | ^2.1.0   | 类名合并       |
| tailwind-merge | ^3.2.0   | Tailwind 合并  |

---

## 6. packages/monitor — 监控面板

> `@super-agent/monitor` · Electron 独立窗口

```
packages/monitor/src/
├── main.js       # Electron 主进程 (2.8KB)
├── preload.js    # 预加载脚本 (0.5KB)
└── renderer/     # 渲染进程 (监控 UI)
```

用于开发模式下的全链路追踪可视化和性能监控，随 `pnpm dev:monitor` 启动。

---

## 7. services/im-gateway — IM 网关

> Python FastAPI 微服务 · 端口 8642

### 7.1 目录结构

```
services/im-gateway/
├── server.py              # FastAPI 主服务器 (40.3KB)
├── bridge.py              # Agent API 桥接 (31.6KB)
├── config_manager.py      # 配置管理 (9.1KB)
├── gateway_state.py       # 网关状态管理 (8.4KB)
├── health_monitor.py      # 健康监控 (9.0KB)
├── health_policy.py       # 健康策略 (4.0KB)
├── reconnect.py           # 重连引擎 (12.1KB)
├── structured_logger.py   # 结构化日志 (8.3KB)
├── weclaw_adapter.py      # WeClaw 适配器 (9.8KB)
│
├── adapters/              # IM 平台适配器
│   ├── base.py            # 适配器基类 (11.1KB)
│   ├── wecom.py           # 企业微信 (7.2KB)
│   ├── feishu.py          # 飞书 (9.8KB)
│   ├── dingtalk.py        # 钉钉 (7.2KB)
│   └── __init__.py        # 适配器注册
│
├── channels/              # 通道管理 (按平台分目录)
│   ├── wecom/             # 企业微信通道 (14 文件)
│   ├── feishu/            # 飞书通道 (17 文件)
│   ├── dingtalk/          # 钉钉通道 (7 文件)
│   ├── weixin/            # 微信通道 (7 文件)
│   └── __init__.py
│
├── core/                  # 新架构核心层
│   ├── registry.py        # 渠道注册表 (2.1KB)
│   ├── message_pipeline.py # 消息管道 (13.6KB)
│   ├── config_persistence.py # 配置持久化 (5.6KB)
│   ├── config_schema.py   # 配置 Schema (2.9KB)
│   ├── session_manager.py # 会话管理 (8.0KB)
│   ├── agent_router.py    # 三级 Agent 路由 (6.7KB)
│   ├── attachment_processor.py # 附件处理 (8.7KB)
│   ├── dedup.py           # 消息去重 (1.8KB)
│   ├── http_client.py     # HTTP 客户端 (2.3KB)
│   ├── token_manager.py   # Token 管理 (3.6KB)
│   ├── contracts.py       # 契约/接口定义 (10.2KB)
│   └── types.py           # 类型定义 (10.7KB)
│
├── data/                  # 运行时数据 (3 文件)
├── tests/                 # 单元测试 (4 文件)
├── scripts/               # 辅助脚本 (2 文件)
├── pyproject.toml         # Python 项目配置
├── .env                   # 环境变量
└── .env.example           # 环境变量模板
```

### 7.2 架构流程

```
IM 平台 ──webhook/长轮询──→ Adapter (base.py 子类)
                                  │
                          ┌───────┴────────┐
                          ▼                ▼
                     server.py        core/message_pipeline.py
                          │                │
                          │   消息去重 / 附件处理 / 会话管理
                          │                │
                          └───────┬────────┘
                                  ▼
                            bridge.py
                     HTTP POST /api/chat
                                  │
                                  ▼
                     Super Agent API (:3001)
```

### 7.3 支持的 IM 平台

| 平台       | 适配器文件      | 环境变量前缀 | 消息协议           |
| ---------- | --------------- | ------------ | ------------------ |
| 企业微信   | wecom.py        | WECOM_*      | Webhook 回调       |
| 飞书       | feishu.py       | FEISHU_*     | 事件订阅           |
| 钉钉       | dingtalk.py     | DINGTALK_*   | Stream 长连接      |
| 微信       | channels/weixin | WEIXIN_*     | 公众号/小程序接口  |
| Telegram   | (扩展)          | TELEGRAM_*   | Bot API            |
| Discord    | (扩展)          | DISCORD_*    | Gateway WebSocket  |
| Slack      | (扩展)          | SLACK_*      | Events API         |
| Webhook    | (通用)          | WEBHOOK_*    | HTTP POST          |

### 7.4 核心特性

- **消息管道 (MessagePipeline)**：统一的消息处理流水线，支持拦截器
- **Agent 路由 (AgentRouter)**：三级路由策略 (通道级→群组级→默认)
- **消息去重 (Dedup)**：requestId + TTL 缓存，防止重试重复
- **附件处理 (AttachmentProcessor)**：自动下载/转码/上传附件
- **重连引擎 (ReconnectEngine)**：指数退避 + 抖动的自动重连
- **健康监控 (HealthMonitor)**：各适配器连接状态实时监测
- **配置持久化**：通道配置持久存储到本地 JSON/SQLite

---

## 8. 核心类型系统

> `packages/core/src/types/index.ts` (377 行)

### Agent 相关

```typescript
AgentConfig {
  id: string
  name: string
  role: string              // Agent 角色描述
  goal: string              // Agent 目标
  backstory?: string        // 背景故事
  systemPrompt?: string     // 自定义系统提示
  model?: string            // LLM 模型名
  provider?: string         // LLM 提供商
  llmProvider?: LLMProviderConfig
  tools?: string[]          // 启用的工具列表
  skills?: string[]         // 启用的技能列表
  channels?: string[]       // 绑定的通道
  maxToolIterations?: number // 最大工具调用次数 (默认 90)
}

AgentState {
  id: string
  status: "idle" | "running" | "error" | "stopped"
  activeSessions: number
  lastActivityAt: Date
}
```

### LLM 相关

```typescript
LLMProviderConfig {
  type: string              // openai / anthropic / ollama / custom
  model: string             // 模型名称
  apiKey?: string           // API 密钥
  baseUrl?: string          // 自定义 API 地址
  fallback?: LLMProviderConfig  // 降级配置
  providerId?: string       // 多供应商唯一标识
  supportsReasoning?: boolean
  supportsVision?: boolean
}

LLMMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentPart[]
  toolCalls?: LLMToolCall[]
  reasoningContent?: string // 推理过程 (DeepSeek/Kimi)
}

LLMResponse {
  content: string
  toolCalls?: LLMToolCall[]
  reasoningContent?: string
  usage?: { promptTokens, completionTokens, totalTokens }
  finishReason?: string
}

LLMToolCall {
  id: string
  type: "function"
  function: { name: string, arguments: string }
}

ContentPart = { type: "text", text: string }
            | { type: "image_url", image_url: { url: string } }
```

### 消息相关

```typescript
InboundMessage {
  id?: string
  channelId?: string
  platform?: string
  chatId?: string
  senderId?: string
  text: string
  timestamp?: number
  attachments?: Attachment[]
  metadata?: Record<string, any>
}

OutboundMessage {
  channelId: string
  chatId: string
  text: string
  attachments?: Attachment[]
  metadata?: Record<string, any>
}

Attachment {
  path?: string
  url?: string
  base64?: string
  mimeType?: string
  filename?: string
  size?: number
}

MediaDescriptor {
  localPath?: string
  buffer?: Buffer
  contentType?: string
  kind?: string
  filename?: string
}
```

### 记忆相关

```typescript
MemoryEntry {
  id: string
  agentId: string
  content: string
  type: string              // "recall" | "archival" | "core"
  embedding?: number[]      // 向量嵌入
  metadata?: Record<string, any>
  createdAt?: Date
}

MemorySearchResult { entry: MemoryEntry, score: number }
CoreMemoryBlock { id: string, agentId: string, label: string, value: string }
```

### 工具相关

```typescript
ToolDefinition {
  name: string
  description: string
  parameters: ZodSchema     // Zod Schema (自动转 JSON Schema)
  execute: (args, context) => Promise<ToolResult>
}

ToolContext {
  agentId: string
  sessionId: string
  userId?: string
  memory?: MemoryManager
  llmProvider?: LLMProvider
}

ToolResult {
  success: boolean
  output: string
  error?: string
}
```

### 技能相关

```typescript
Skill {
  id: string
  frontmatter: SkillFrontmatter
  content: string           // Markdown 正文
  filePath: string
  enabled: boolean
  loadedAt: Date
  readiness?: string
}

SkillFrontmatter {
  name: string
  description: string
  version?: string
  author?: string
  platforms?: string[]
  prerequisites?: string[]
  security?: SkillSecurityConfig
  triggers?: string[]       // 触发关键词
}
```

### 通道 / 协作 / 进化

```typescript
ChannelConfig { id, platform, enabled, credentials, settings, agentId }
ChannelState  { status: "connected"|"disconnected"|"error"|"configuring" }

CrewTask   { id, name, description, agent, tool, dependencies }
CrewResult { output, logs, duration }

SkillProposal { id, skillName, improvements, status, createdAt }
InteractionCase { sessionId, turn, input, output, success, timestamp }
```

### Zod Schemas

```typescript
AgentConfigSchema     // Agent 配置运行时验证
ChatMessageSchema     // 聊天消息验证
ChannelConfigSchema   // 通道配置验证
MCPServerSchema       // MCP 服务器配置验证
CronJobSchema         // 定时任务验证
```

---

## 9. 模块深度解读

### 9.1 Agent 运行时引擎

> `agent/runtime.ts` — 1453 行

```
AgentRuntime.processMessage(messages)
  ├─ 1. PromptEngine.build()           10 层系统提示
  ├─ 2. MemoryManager.recall()         Core/Recall/Archival 记忆注入
  ├─ 3. 上下文预检 → 压缩             Token 管理
  ├─ 4. LLMProvider.chat()             主 provider → fallback
  ├─ 5. 工具执行循环 (≤90 次)         沙箱路由 → 截断 → 再调 LLM
  ├─ 6. MemoryManager.add()            存储记忆
  ├─ 7. EvolutionEngine.record()       案例收集
  └─ 8. return LLMResponse
```

特性：流式 SSE · 推理模式 (reasoning_content) · 心跳保活 · 会话持久化

### 9.2 沙箱路由

```
executeTool(name, args)
  ├─ "process"  → ProcessSandbox (child_process, 30s, 128MB)
  ├─ "docker"   → DockerSandbox (128m/0.5cpu) | 降级 Process
  ├─ "ssh"      → SSHSandbox (ssh2 远程) | 降级 Process
  └─ 无沙箱     → 直接执行
```

安全链：command-guard → write-guard → env-isolation → sysops-security → approval

### 9.3 三层记忆 (Letta)

| 层       | 用途         | 存储            | 访问     |
| -------- | ------------ | --------------- | -------- |
| Core     | 人设/目标    | XML 块          | 始终注入 |
| Recall   | 对话历史     | SQLite          | 搜索分页 |
| Archival | 长期知识     | SQLite + FTS5   | 语义搜索 |

Embedding: QwenEmbedding (2048 维) / SimpleEmbedding (哈希降级)

### 9.4 10 层提示工程

稳定前缀 L1-L6 (缓存复用)：身份 · 工具指导 · 模型指导 · 记忆指导 · 技能清单 · 安全栏杆
动态部分 L7-L10 (每轮重建)：Core Memory XML · 项目上下文 · 工具+会话 · 平台提示

### 9.5 自我进化 (双引擎)

- **Nudge**: 定期回顾 → LLM 总结 → 更新 Core Memory
- **技能进化**: 失败积累 → 模式分析 → 提案 → A/B 验证 → 审批应用

### 9.6 多 Agent 协作

- **Crew** (CrewAI): Sequential / Hierarchical 任务流
- **GroupChat** (AutoGen): 动态发言 · Handoff · 共识终止
- **子代理**: spawn · prompt · announce

### 9.7 MCP 集成

传输: stdio / SSE / streamable-http · 认证: bearer / api-key / basic
功能: 多服务器管理 · 工具发现 · 市场安装 · 事件桥接 · 服务端能力

### 9.8 上下文管理

- compressor.ts (20.2KB): Token 超限压缩
- summarizer.ts (11.7KB): LLM 摘要旧消息
- tool-result-truncation.ts: 长输出截断
- preemptive-check.ts: 提前检测上限

### 9.9 工具集 (30+, 6 类)

| 类别   | 工具                                             | Flag            |
| ------ | ------------------------------------------------ | --------------- |
| 基础   | filesystem, code-exec, shell, system, web        | 默认            |
| 媒体   | media, image-gen, vision, voice, data-transform  | 默认            |
| 浏览器 | browser/ (会话, Cookie, 截图, 视觉)              | 默认            |
| 桌面   | desktop/ (gui, screen, app, computer-use)        | DESKTOP/COMPUTER|
| 运维   | ops/ (monitor, docker, deploy, service, network) | OPS_TOOLS       |
| 开发   | dev/ (env, package, test-build)                  | DEV_TOOLS       |

---

## 10. 数据流与消息处理

### 10.1 完整请求链

```
IM 平台 → Gateway(:8642) → API(:3001) → AgentRuntime → LLM → 工具循环 → 回复
         adapter解析      认证/去重     10层提示       调用    沙箱执行   持久化
         去重/附件处理    路由匹配      记忆注入       fallback 结果截断  记忆存储
         语音转文字                     上下文压缩
```

### 10.2 流式响应

```
POST /api/chat/stream
  → SSE: data: { content, toolCalls, reasoning }
  → WebSocket: agent:message / agent:tool-call
  → 完成: data: [DONE]
```

### 10.3 OpenAI 兼容

`POST /v1/chat/completions` — 标准 OpenAI Chat API，任何客户端直接对接。

---

## 11. 数据持久化

### 11.1 SQLite 表 (20+)

| 表名                  | 用途         | 表名                  | 用途         |
| --------------------- | ------------ | --------------------- | ------------ |
| agents                | Agent 配置   | cron_jobs             | 定时任务     |
| conversations         | 会话         | cron_history          | 执行历史     |
| conversation_messages | 消息         | mcp_servers           | MCP 配置     |
| memories              | 记忆条目     | installed_skills      | 技能元数据   |
| memories_fts          | FTS5 搜索    | skill_proposals       | 进化提案     |
| core_memory_blocks    | Core Memory  | collaboration_history | 协作记录     |
| security_policies     | 安全策略     | config_store          | KV 配置      |
| credentials           | 加密凭证     | audit_logs            | 审计日志     |
| sessions              | 旧会话       | channels              | IM 通道配置  |
| nudge_config          | Nudge 配置   |                       |              |

### 11.2 文件持久化

| 路径                     | 用途                |
| ------------------------ | ------------------- |
| data/SOUL.md             | Agent 人设灵魂档案  |
| data/USER.md             | 用户画像            |
| data/MEMORY.md           | 运行时内存块        |
| data/sessions/*.jsonl    | 会话归档 (一行一条) |
| data/super-agent.db      | SQLite 数据库       |
| data/super-agent.db.bak  | 自动备份            |

---

## 12. 全链路追踪

自动埋点: AgentRuntime · LLMProvider · SecurityManager · MemoryManager · PromptEngine · Tool · MCPClient

查看: `GET /api/traces` · SSE → Monitor (Electron) · Web Dashboard

---

## 13. 插件系统

- registry.ts (注册表) · hooks.ts (事件分发) · loader.ts (动态加载) · types.ts (接口)
- 适配器: ChannelAdapter · MemoryAdapter · ToolAdapter

---

## 14. 环境变量

### 核心

| 变量           | 默认                    | 说明         |
| -------------- | ----------------------- | ------------ |
| PORT           | 3001                    | API 端口     |
| LLM_PROVIDER   | openai                  | LLM 提供商   |
| LLM_MODEL      | gpt-4o-mini             | 默认模型     |
| LLM_API_KEY    | -                       | API 密钥     |
| JWT_SECRET     | -                       | JWT 密钥     |
| IM_GATEWAY_URL | http://localhost:8642   | 网关地址     |
| FRONTEND_URL   | http://localhost:3000   | CORS         |

### 可选

DASHSCOPE_API_KEY · ALIBABA_CLOUD_* · SSH_SANDBOX_* · FEISHU_* · WECOM_* · DINGTALK_*

### Feature Flags

| Flag                       | 默认  | 控制       |
| -------------------------- | ----- | ---------- |
| SUPER_AGENT_SYSOPS_ENABLED | false | 系统操作   |
| SUPER_AGENT_OPS_TOOLS      | false | 运维工具   |
| SUPER_AGENT_DEV_TOOLS      | false | 开发工具   |
| SUPER_AGENT_DESKTOP_TOOLS  | false | 桌面控制   |
| SUPER_AGENT_COMPUTER_USE   | false | 计算机使用 |

---

## 15. 开发指南

```bash
pnpm install        # 安装依赖
pnpm dev            # 启动全部 (core + api + web)
pnpm dev:api        # API :3001
pnpm dev:web        # Web :3000
pnpm dev:monitor    # 监控面板
pnpm dev:gateway    # IM 网关 :8642
pnpm build          # 构建
pnpm test           # 测试
pnpm clean          # 清理
```

新模块清单：core/src 创建模块 → index.ts 导出 → routes/ API → context.ts 初始化 → web/app/ 页面 → sidebar 导航 → 测试 → 更新 Wiki

---

## 16. 依赖关系图

```
  web(:3000) ──fetch──→ api(:3001) ──import──→ core(SDK)
                            ↑                     │
  im-gateway(:8642) ─POST───┘          ┌──────────┼──────────┐
                                       ▼          ▼          ▼
  monitor(Electron) ──SSE──→ api    sql.js     openai     MCP/外部
```

外部集成: LLM (OpenAI/Anthropic/Ollama/国产) · MCP 市场 · 技能源 (SkillHub/GitHub/ClawHub) · IM 8 平台 · 云服务 (阿里云 NLS + DashScope)

---

> **本文档随项目迭代持续更新** · 专项规格书见 `docs/` 目录
