# Super Agent — 仓库全景 Wiki

> 模块化通用 AI Agent 平台：持久记忆 · 自我进化 · 多智能体协作 · 知识库 · 视频生成 · IM 网关
>
> 版本 v0.1.0 | pnpm monorepo | TypeScript + Python 混合架构

---

## 一、仓库结构总览

```
super-agent/                          # pnpm monorepo 根目录
├── packages/
│   ├── core/                         # @super-agent/core  核心 SDK
│   ├── api/                          # @super-agent/api   Fastify 5 HTTP 服务
│   ├── web/                          # @super-agent/web   Next.js 16 前端
│   ├── web-types/                    # @super-agent/web-types  前端共享类型
│   ├── monitor/                      # @super-agent/monitor  系统监控面板
│   └── research/                     # @super-agent/research  研究实验模块
├── services/
│   ├── im-gateway/                   # Python FastAPI IM 多通道网关
│   ├── kb-parser/                    # 知识库文档解析器
│   └── video-forge/                  # Python 视频生成引擎
├── scripts/                          # 初始化 & 辅助脚本
├── data/                             # 本地开发数据目录
├── runtime/                          # 运行时生成文件
├── pnpm-workspace.yaml               # workspace 配置
└── package.json                      # monorepo 根级 (scripts: dev/build/test)
```

---

## 二、Core 核心 SDK (`packages/core/`)

**包名**: `@super-agent/core` | **构建工具**: tsup | **入口**: `src/index.ts` (558 行，导出 350+ 符号)

### 2.1 Agent 运行时 (`agent/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `runtime.ts` | ~1950 | **核心推理循环**：`processMessage()` 对话流程、`executeTool()` 工具执行（三级沙箱路由）、多模态 content 处理 |
| `manager.ts` | ~290 | **多 Agent 注册管理**：创建/列出/查找 Agent 实例、全局工具注册、skillLoader 注入 |
| `reflection.ts` | ~290 | Agent 自我反思与改进提示词生成 |
| `sanitize.ts` | ~65 | **安全脱敏**：零信任 apiKey 保护，序列化前掩码敏感字段 |

### 2.2 内置专家 Agent (`builtin-agents/`)

- **211 个领域专家 Agent**，分布在 16 个行业目录中
- 从 `agency-agents-zh` 上游仓库导入，使用 `agency-agents-importer` 工具转换
- 分类涵盖：学术、设计、工程、金融、游戏开发、人力资源、法律、市场营销、付费媒体、产品、项目管理、销售、空间计算、供应链、客服支持、测试
- `loader.ts` / `catalog.ts` 提供统一加载和查询入口

### 2.3 LLM Provider (`llm/`)

| 文件 | 职责 |
|------|------|
| `provider.ts` | **核心 Provider 抽象**：OpenAI/Ollama/Anthropic 多后端统一接口，Fallback 降级链 |
| `provider-store.ts` | Provider 配置持久化到 SQLite |
| `model-catalog.ts` | 国产模型全量目录（DeepSeek/千问/豆包/智谱等），含上下文长度与多模态能力标注 |
| `fallback.ts` | Provider 不可用时自动降级逻辑 |
| `factory.ts` | Provider 实例工厂（API Key 解密 + 客户端创建） |
| `token-counter.ts` | Token 计数（tiktoken 兜底近似） |

### 2.4 记忆系统 (`memory/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `manager.ts` | ~1800 | **三层 Letta 记忆架构** (Core/Recall/Archival) + SQLite 持久化 + FTS5 全文搜索 |
| `markdown-memory.ts` | ~280 | Markdown 文件记忆（MEMORY.md / USER.md / SOUL.md 读写合并） |
| `knowledge-graph.ts` | ~480 | **知识图谱**：RDF 三元组存储、子图查询、实体消歧 |
| `hrr.ts` | ~240 | **HRR 向量符号架构**：相位向量绑定/解绑、语义检索 |
| `relation-extractor.ts` | ~220 | LLM 驱动的关系抽取（实体→三元组） |
| `inference-rules.ts` | ~180 | 传递闭包推理（`parentOf` → `ancestorOf` 等） |
| `entity-resolver.ts` | ~90 | 实体别名解析与消歧 |
| `plugin-loader.ts` | ~70 | 记忆插件发现加载 |
| `provider.ts` | ~230 | 嵌入 Provider 编排（Qwen Embedding 2048 维 / 本地 fallback） |

**关键特性**：
- QwenEmbedding：通义千问 text-embedding-v4，2048 维语义向量
- FTS5 全文索引：支持中英文混合搜索
- HRR 相位向量：复合记忆的绑定/解绑操作
- 知识图谱 + 向量检索 混合召回

### 2.5 技能系统 (`skills/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `loader.ts` | ~230 | 技能热加载，chokidar 文件监听，自动重载 |
| `marketplace.ts` | ~550 | 技能市场（GitHub/SkillHub/ClawHub/Local 多源），安装/更新/卸载 |
| `parser.ts` | ~130 | 多格式技能解析（OpenClaw/Hermes/SuperAgent SKILL.md） |
| `tools.ts` | ~390 | 技能工具创建：`createSkillTools()` 生成 LLM 可调用工具 |
| `commands.ts` | ~180 | 斜杠命令扫描与激活 |
| `config-inject.ts` | ~250 | 技能配置变量注入 |
| `guard.ts` | ~600 | 安全审计引擎：内容扫描、信任评级、安装许可判定 |
| `readiness.ts` | ~310 | 技能就绪状态机：依赖检查、密钥收集、安装选项推荐 |
| `lockfile.ts` | ~280 | 版本锁定与更新检测 |
| `snapshot-cache.ts` | ~240 | 磁盘技能快照缓存，提速冷启动 |

### 2.6 MCP 协议集成 (`mcp/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `client.ts` | ~480 | **MCP 客户端**：stdio/SSE/HTTP 三种传输、认证（bearer/api-key/basic）、工具调用 |
| `registry.ts` | ~220 | MCP 服务器注册表：安装/卸载/启用/禁用/列表 |
| `marketplace.ts` | ~210 | MCP 服务器市场（GitHub 官方 + 社区源） |
| `server.ts` | ~340 | MCP 服务器端实现（Super Agent 作为 MCP Server） |
| `server-transport.ts` | ~210 | 服务端传输层抽象 |
| `event-bridge.ts` | ~230 | MCP 事件桥接 |

### 2.7 工具生态 (`tools/`)

| 模块 | 文件 | 职责 |
|------|------|------|
| **文件系统** | `filesystem.ts` | 文件读写/目录列表/搜索 |
| **代码执行** | `code-exec.ts` | Python/Node.js 沙箱执行（三级路由） |
| **终端引擎** | `terminal-engine.ts` | 终端命令执行（持久化 shell 会话） |
| **Git 工具** | `git-tools.ts` | 12 个 Git 操作 |
| **浏览器** | `browser/` | Playwright 浏览器自动化（6 文件） |
| **桌面** | `desktop/` | 桌面控制/截图/应用管理（4 文件） |
| **运维** | `ops/` | Docker/服务/网络/监控工具（5 文件） |
| **开发** | `dev/` | 包管理/测试/环境管理（3 文件） |
| **数据处理** | `data-transform.ts` | JSON/CSV/XML 转换 |
| **生产力** | `productivity.ts` | 日程/笔记/待办 |
| **图像生成** | `image-gen.ts` | AI 图像生成 |
| **语音** | `voice-tools.ts` | TTS/STT 工具 |
| **视觉** | `vision.ts` | 多模态视觉理解 |
| **Web** | `web.ts` | HTTP 请求/网页抓取 |
| **视频** | `video-forge.ts` | 视频生成编排 |
| **系统** | `system.ts` | 系统信息/进程管理 |
| **配置** | `config-store.ts` | 配置项读取写入 |
| **安全** | `shared-security.ts` | 共享安全验证 |
| **输出** | `output-processor.ts` | 工具输出格式化（图片/文件/表格渲染） |

### 2.8 多智能体协作 (`collaboration/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `orchestrator.ts` | ~2400 | **核心编排引擎**：CrewAI 任务编排 + AutoGen GroupChat 对话协商 + Handoff |
| `agent-matcher.ts` | ~620 | **Hierarchical 智能 Agent 分配**：语义匹配 + 能力评分 + 新 Agent 建议 |
| `workspace.ts` | ~330 | 多 Agent 共享工作空间管理 |
| `subagent-spawn.ts` | ~640 | 子代理生成与管理 |
| `subagent-executor.ts` | ~280 | 子代理任务执行 |
| `subagent-announce.ts` | ~250 | 子代理消息广播 |
| `subagent-prompt.ts` | ~210 | 子代理系统提示词构造 |
| `a2a-types.ts` | ~350 | **A2A 协议类型**（Google Agent-to-Agent） |
| `a2a-client.ts` | ~370 | A2A 客户端（跨进程 Agent 通信） |
| `a2a-task.ts` | ~220 | A2A 任务状态机 |
| `a2a-message.ts` | ~100 | A2A 消息构造/解析 |
| `a2a-push.ts` | ~260 | A2A 推送通知 |
| `agent-registry.ts` | ~220 | Agent 注册发现（内存 + SQLite） |
| `remote-agent-proxy.ts` | ~200 | 远程 Agent 代理 |
| `ssrf-guard.ts` | ~100 | SSRF 防护 |
| `retry.ts` | ~50 | 重试策略 |
| `video-crew-*.ts` | ~2300 | 视频制作 Crew 专用（handlers/presets/prompts/schemas/provider-presets） |

### 2.9 自我进化 (`evolution/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `engine.ts` | ~1200 | **双引擎进化**：Nudge 回顾 + 技能进化，`applyProposal()` 写 .md 文件 |
| `insights.ts` | ~310 | 对话洞察提取 |
| `knowledge-extractor.ts` | ~320 | 知识提取器 |
| `session-search.ts` | ~250 | 会话全文搜索 |
| `verification.ts` | ~260 | 进化提案验证 |

### 2.10 安全基座 (`security/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `sandbox.ts` | ~800 | **安全沙箱**：CredentialVault (AES-256)、TokenProxy、ProcessSandbox（三级：process/docker/ssh + 降级） |
| `docker-sandbox.ts` | ~210 | Docker 容器沙箱 |
| `ssh-sandbox.ts` | ~200 | SSH 远程沙箱 |
| `command-guard.ts` | ~430 | 危险命令拦截（rm -rf/sudo/curl|bash 等） |
| `approval.ts` | ~180 | 操作审批流程 |
| `code-exec-guard.ts` | ~170 | 代码执行安全守护 |
| `encryption-key.ts` | ~130 | AES-256-CBC 加密密钥管理 |
| `env-isolation.ts` | ~280 | 环境变量隔离 |
| `write-guard.ts` | ~140 | 文件写入保护 |
| `sysops-security.ts` | ~200 | SysOps 安全策略注入 |
| `shared-security.ts` | ~70 | 共享安全工具 |

### 2.11 上下文管理 (`context/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `compressor.ts` | ~550 | **上下文压缩器**：ContextCompressor 结构化摘要 + Token 预算管理 |
| `summarizer.ts` | ~320 | 对话摘要生成器 |
| `tool-result-truncation.ts` | ~220 | 工具结果截断（MAX 预算 / 单结果上限 / 聚合限制） |
| `preemptive-check.ts` | ~150 | 先发式压缩检查 |

### 2.12 提示词引擎 (`prompt/`)

| 文件 | 行数 | 职责 |
|------|------|------|
| `engine.ts` | ~790 | **10 层提示工程**（L1-L6 缓存 + L7-L10 动态）：注入防护、模型适配 |
| `guidance.ts` | ~340 | Agent 行为指导模板 |
| `injection-guard.ts` | ~250 | **提示注入防护**：检测与清洗 |
| `model-adapters.ts` | ~220 | 各模型提示词格式适配 |
| `platform-hints.ts` | ~160 | 平台上下文注入（IM 渠道场景适配） |
| `context-files.ts` | ~140 | AGENTS.md / TOOLS.md 上下文文件加载 |

### 2.13 持久化层 (`persistence/sqlite/`)

**数据库**: sql.js (WASM SQLite)，25 个 store 文件，~13 张核心表

| Store | 表 | 职责 |
|-------|-----|------|
| `client.ts` | — | 数据库连接管理 + 防抖保存 |
| `session-store.ts` | `sessions` | 会话记录 CRUD |
| `session-repo.ts` | `sessions` | 会话仓库模式层 |
| `provider-store.ts` | `providers` | LLM Provider 配置存储 |
| `mcp-store.ts` | `mcp_servers` | MCP Server 配置 CRUD |
| `cron-store.ts` | `cron_jobs` | 定时任务持久化 |
| `flag-store.ts` | `feature_flags` | Feature Flag 存储 |
| `config-store.ts` | `config` | 通用键值配置 |
| `a2a-store.ts` | `a2a_tasks` | A2A 任务持久化 |
| `token-store.ts` | `api_tokens` | API 令牌管理 |
| `memory-store.ts` | `memories` | Core/Recall/Archival 记忆 |
| `knowledge-store.ts` | `knowledge_graph` | 知识图谱三元组 |
| `collab-store.ts` | `collaboration` | 协作任务状态 |
| `skill-store.ts` | `skills` | 已安装技能记录 |
| `evolution-store.ts` | `evolution` | 进化提案/历史 |
| `voice-store.ts` | `voice_configs` | 语音配置 |
| `embeddings-store.ts` | `embeddings` | 嵌入向量缓存 |
| `kb-store.ts` | `knowledge_base` | 知识库文档元数据 |
| `file-store.ts` | `file_cache` | 文件缓存/附件 |
| `jsonl-writer.ts` | — | JSONL 会话转录写入 |

其他文件：`migrate.ts`（Schema 迁移）、`dedup.ts`（去重）、`fts.ts`（FTS5）、`backup.ts`（备份）、`wal.ts`（WAL 模式）

### 2.14 知识库 (`knowledgebase/`)

| 目录/文件 | 职责 |
|-----------|------|
| `chunker/` | 文档分块策略（固定大小/语义/递归） |
| `parser/` | 10 种文件格式解析（PDF/Word/PPT/Excel/Markdown/HTML/EPUB 等） |
| `ingestion/` | 文档摄入流水线 |
| `retrieval/` | 混合检索（向量 + BM25 + 关键词） |
| `storage/` | 文档与向量存储 |
| `tools/` | 知识库操作工具 |

### 2.15 其他模块

| 模块 | 文件 | 职责 |
|------|------|------|
| **媒体** | `media/` (7 文件) | 媒体文件加载、MIME 检测、安全校验、本地存储 |
| **语音** | `voice/` (3 文件) | STT/TTS 接口 + 阿里云 AliyunVoiceProvider |
| **定时任务** | `cron/` (3 文件) | Cron 调度器 + 自然语言→Cron 表达式（LLM）+ 心跳检测 |
| **追踪** | `tracing/` (5 文件) | OpenTelemetry 全链路追踪 + 性能打点 |
| **路由** | `routing/` (2 文件) | MessageRouter 消息路由分发 |
| **平台** | `platform/` (2 文件) | 平台适配器 |
| **插件** | `plugins/` (7 文件) | 插件系统：registry/loader/hooks/adapters |
| **运行时** | `runtime/` (4 文件) | 运行时工具 |
| **CLI** | `cli/` (1 文件) | 命令行入口 |
| **类型** | `types/index.ts` (~450 行) | 全量类型定义 + Zod Schemas |
| **工具** | `utils/content-helpers.ts` | 多模态 content 安全访问 |

---

## 三、API 服务 (`packages/api/`)

**包名**: `@super-agent/api` | **框架**: Fastify 5 | **端口**: 3001

### 3.1 核心文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | ~600 | Fastify 服务入口：CORS/WebSocket/路由注册/启动 |
| `context.ts` | ~620 | **AppContext 工厂**：初始化全部模块（Agent/Skills/Memory/MCP/Collaboration/Evolution 等） |

### 3.2 22 个 API 路由

| 路由 | 端点前缀 | 职责 |
|------|----------|------|
| `chat.ts` | `/api/chat` | SSE 流式对话 + 多模态消息 |
| `agents.ts` | `/api/agents` | Agent CRUD + 状态管理 |
| `settings.ts` | `/api/settings` | Feature Flag 开关 + **OpenClaw 数据迁移** |
| `models.ts` | `/api/models` | Provider/模型列表 + 测试连接 |
| `skills.ts` | `/api/skills` | 技能安装/卸载/就绪检查 |
| `mcp.ts` | `/api/mcp` | MCP Server 管理 + 市场 |
| `memory.ts` | `/api/memory` | 记忆 CRUD + 搜索 |
| `evolution.ts` | `/api/evolution` | 进化引擎控制 |
| `collaboration.ts` | `/api/collaboration` | 多 Agent 协作编排 |
| `cron.ts` | `/api/cron` | 定时任务 CRUD |
| `security.ts` | `/api/security` | 安全策略/沙箱状态 |
| `channels.ts` | `/api/channels` | IM 渠道配置（飞书/企微/钉钉） |
| `knowledge-base.ts` | `/api/knowledge` | 知识库文档管理 |
| `knowledge-graph.ts` | `/api/knowledge-graph` | 知识图谱查询 |
| `media.ts` | `/api/media` | 媒体文件上传/下载 |
| `video.ts` | `/api/video` | 视频生成任务 |
| `voice.ts` | `/api/voice` | TTS/STT 服务 |
| `services.ts` | `/api/services` | 第三方服务配置（浏览器/语音等） |
| `files.ts` | `/api/files` | 文件操作 |
| `traces.ts` | `/api/traces` | 追踪日志查询 |
| `a2a-admin.ts` | `/api/a2a` | A2A Agent 管理 |
| `video-provider-templates.ts` | `/api/video/templates` | 视频模板配置 |

### 3.3 服务层 (`services/`)

| 文件 | 职责 |
|------|------|
| `openclaw-migration.ts` | **OpenClaw → Super Agent 数据迁移**（SOUL/MEMORY/USER/Skills/MCP/每日记忆） |
| `kb-parser-supervisor.ts` | 知识库解析器进程守护 |
| `video-forge-supervisor.ts` | 视频生成引擎进程守护 |

### 3.4 中间件与 WebSocket

| 目录/文件 | 职责 |
|-----------|------|
| `auth/` | 权限验证中间件（`requirePermission`） |
| `middleware/` | 日志/错误处理 |
| `ws/` | WebSocket 实时通信 |
| `a2a/` | A2A 协议端点 |
| `shared/` | 共享工具 |

---

## 四、Web 前端 (`packages/web/`)

**包名**: `@super-agent/web` | **框架**: Next.js 16 (App Router) + React 19 + Tailwind CSS 4 | **端口**: 3000

### 4.1 页面路由 (21 页)

| 路由 | 页面 | 职责 |
|------|------|------|
| `/` | `page.tsx` | 首页（重定向到 /dashboard） |
| `/dashboard` | `dashboard/page.tsx` | 系统仪表盘 |
| `/chat` | `chat/page.tsx` | SSE 流式对话界面 |
| `/agents` | `agents/page.tsx` | Agent 管理与配置 |
| `/skills` | `skills/page.tsx` | 技能市场/已安装列表 |
| `/mcp` | `mcp/page.tsx` | MCP Server 管理 |
| `/memory` | `memory/page.tsx` | 记忆查看/搜索 |
| `/knowledge` | `knowledge/page.tsx` | 知识库管理 |
| `/settings` | `settings/page.tsx` | 系统设置（Provider/服务/Feature Flag/**数据迁移**） |
| `/evolution` | `evolution/page.tsx` | 进化引擎面板 |
| `/collaboration` | `collaboration/page.tsx` | 多 Agent 协作 |
| `/cron` | `cron/page.tsx` | 定时任务管理 |
| `/security` | `security/page.tsx` | 安全监控面板 |
| `/channels` | `channels/page.tsx` | IM 渠道配置 |
| `/media` | `media/page.tsx` | 媒体库 |
| `/video-studio` | `video-studio/page.tsx` | 视频工作室 |
| `/a2a` | `a2a/page.tsx` | A2A Agent 发现 |

### 4.2 核心组件

| 位置 | 组件 | 职责 |
|------|------|------|
| `components/layout/` | Sidebar | 侧边栏导航（lucide 图标，折叠/展开） |
| `components/settings/` | MigrationCard | OpenClaw 数据迁移卡片（自动检测 + 预览 + 执行） |
| `components/ui/` | 通用组件 | 复用的 UI 基础组件 |

---

## 五、服务层 (`services/`)

### 5.1 IM 网关 (`im-gateway/`)

**技术栈**: Python 3.11+ / FastAPI / uvicorn | **端口**: 8642

| 文件 | 行数 | 职责 |
|------|------|------|
| `server.py` | ~1100 | **主服务入口**：FastAPI 路由、Webhook 接收、生命周期管理 |
| `bridge.py` | ~870 | **核心桥接**：消息格式转换、HTTP 回调 Super Agent API、文件上传 |
| `structured_logger.py` | ~220 | 结构化 JSON 日志 |
| `config_manager.py` | ~250 | 多渠道配置管理 |
| `health_monitor.py` | ~240 | 健康检查与告警 |
| `health_policy.py` | ~110 | 健康策略判定 |
| `reconnect.py` | ~330 | 重连策略（指数退避） |
| `gateway_state.py` | ~230 | 网关状态持久化（防重启丢失 Session） |

**Core 模块** (`core/`):

| 文件 | 职责 |
|------|------|
| `session_manager.py` | 会话生命周期（create/flush/expire） |
| `message_pipeline.py` | 四级消息管道（接收→解析→处理→发送） |
| `agent_router.py` | 消息路由到 Agent |
| `attachment_processor.py` | 附件下载/转存 |
| `contracts.py` | 接口契约定义 |
| `types.py` | 全量类型定义 |
| `dedup.py` | 消息去重 |
| `http_client.py` | HTTP 客户端封装 |
| `registry.py` | 渠道注册 |
| `token_manager.py` | Token 管理 |
| `config_schema.py` | 配置 Schema |
| `config_persistence.py` | 配置持久化 |

**渠道**: 飞书、企业微信、钉钉（插件式热插拔架构）

### 5.2 知识库解析器 (`kb-parser/`)

**技术栈**: Python | 10+ 文件格式解析（PDF/Word/PPT/Excel/Markdown/HTML/EPUB/CSV/JSON/纯文本）

### 5.3 视频生成引擎 (`video-forge/`)

**技术栈**: Python / FastAPI | 端口: 8720

- `app/main.py` — API 服务
- `workflows/` — 视频生成工作流
- `templates/` — 视频模板
- `config.yaml` — 引擎配置

---

## 六、数据流向

```
用户浏览器 (:3000 Next.js)
      │
      ├── HTTP REST ──→ API 服务 (:3001 Fastify)
      │                      │
      │                      ├── Core SDK (@super-agent/core)
      │                      │      ├── AgentRuntime    (推理循环)
      │                      │      ├── MemoryManager   (Letta 三层记忆)
      │                      │      ├── SkillLoader     (技能热加载)
      │                      │      ├── MCPRegistry     (MCP 工具注入)
      │                      │      ├── SecurityManager (沙箱隔离)
      │                      │      ├── PromptEngine    (10层提示词)
      │                      │      └── SQLite DB       (sql.js WASM)
      │                      │
      │                      ├── 子服务管理 (服务层)
      │                      │      ├── kb-parser   →  知识库解析
      │                      │      └── video-forge →  视频生成
      │                      │
      │                      └── WebSocket (:3001)  ←→  实时推送
      │
      └── 外部渠道 (飞书/企微/钉钉)
             │
             └── Webhook → IM 网关 (:8642) → HTTP → API 服务
```

---

## 七、关键技术依赖

### Core
- **openai** `^4.80` — OpenAI / 兼容 API 客户端
- **zod** `^3.24` — 运行时类型校验
- **pino** `^9.6` — 结构化日志
- **sql.js** `^1.14` — WASM SQLite 驱动
- **cron-parser** — Cron 表达式解析
- **chokidar** — 文件系统监听（技能热加载）
- **gray-matter** — Markdown frontmatter 解析
- **json5** `^2.2.3` — JSON5 配置文件解析（OpenClaw 迁移）
- **tiktoken** — Token 计数
- **eventemitter3** — 事件总线
- **playwright** — 浏览器自动化

### API
- **fastify** `^5.3` — 高性能 HTTP 框架
- **@fastify/websocket** — WebSocket 支持
- **@fastify/cors** — 跨域支持

### Web
- **next** `^16.2` — React 全栈框架
- **react** `^19.2` — UI 库
- **tailwindcss** `^4` — 原子化 CSS
- **lucide-react** — 图标库

### IM 网关
- **fastapi** + **uvicorn** — Python 异步 HTTP
- **httpx** — 异步 HTTP 客户端

---

## 八、开发工作流

```bash
# 安装依赖
pnpm install

# 初始化（首次运行）
pnpm setup

# 并行启动所有开发服务
pnpm dev            # core + api + web 并行

# 单独启动
pnpm dev:api        # 仅 API (:3001)
pnpm dev:web        # 仅 Web (:3000)
pnpm dev:gateway    # 仅 IM 网关 (:8642, Python)

# 构建
pnpm build

# 测试
pnpm test           # vitest (core/api) + pytest (im-gateway)

# 代码检查
pnpm lint
```

---

## 九、最新功能 (v0.1.0+)

1. **OpenClaw 数据迁移** — 从设置页一键迁移 6 类数据（SOUL/MEMORY/USER/Skills/MCP/每日记忆），含预览+去重合并+覆盖选项
2. **A2A 协议** — Google Agent-to-Agent 跨进程通信，支持 Agent 发现/任务委托/推送通知
3. **Hierarchical Agent 分配** — `AgentMatcher` 智能匹配合适的专家 Agent 处理任务
4. **知识图谱** — RDF 三元组存储 + 传递闭包推理
5. **FTS5 全文搜索** — 对话与记忆的中英文混合搜索
6. **三级沙箱** — process → Docker → SSH 自动降级
7. **代码执行守护** — 危险命令实时拦截 (rm -rf/sudo/curl|bash)
8. **上下文压缩** — Token 预算管理 + 先发式压缩策略
9. **技能就绪检查** — 安装前校验依赖/密钥/信任等级
10. **HRR 向量记忆** — 相位向量绑定/解绑，复合记忆操作

---

## 十、架构决策记录

| 决策 | 理由 |
|------|------|
| sql.js WASM SQLite | 零安装、零配置、跨平台 |
| pnpm monorepo | 高效磁盘空间、严格依赖隔离 |
| Fastify (非 Express) | 性能优先（2x+ 吞吐量） |
| Letta 三层记忆 | 业界最佳实践的 Agent 记忆架构 |
| Preview-then-Commit | 数据迁移等危险操作先预览再执行 |
| 三级沙箱降级 | process → Docker → SSH，最大限度保证可用性 |
| openclaw- 前缀 | MCP Server 导入使用前缀避免 ID 冲突 |
| JSON5 格式 | OpenClaw 配置文件使用 JSON5（支持注释/尾逗号） |

---

> 最后更新：2026-05-03 | Super Agent v0.1.0
