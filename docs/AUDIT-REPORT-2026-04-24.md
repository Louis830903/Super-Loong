# Super Agent 全面代码审核报告

> **审核日期**：2026-04-24
> **审核范围**：`super-agent/` monorepo 全部源码 (`packages/core`, `packages/api`, `packages/web`, `services/*`)
> **审核方法**：逐文件源码审查，按严重度分级 (P0/P1/P2/P3)，基于实际文件行号定位
> **审核维度**：功能实现完整性 · 模块耦合 · 前后端契约对齐 · 安全风险 · 并发/时序 · 可维护性

---

## 执行摘要

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整度 | ★★★★☆ | Agent 对话/视频协作/记忆/进化为核心链路已打通 |
| 模块耦合 | ★★★★☆ | core 零反向依赖 api/web，严格分层；但 sqlite.ts 为 2972 行上帝文件 |
| 前后端契约 | ★★★☆☆ | VIDEO_AGENT_IDS 已对齐；但 api-types.ts 手工同步、事件类型未纳入 PlatformEventType |
| 安全性 | ★★☆☆☆ | 8 条 P0 安全漏洞阻断上线 (见下) |
| 可维护性 | ★★★☆☆ | 千行组件、中文混合命名、多处 as any 绕过类型系统 |

### 关键发现：8 条 P0 必须立即修复

| # | 严重度 | 问题 | 定位 |
|---|--------|------|------|
| 1 | **P0** | `.env` 含生产 Moonshot API Key 明文 (`sk-UVAp...`) | `super-agent/.env` |
| 2 | **P0** | 加密 key 硬编码默认值 `"super-agent-default-encryption-key-v1"` | `core/llm/provider-store.ts:34`, `core/tools/config-store.ts:20` |
| 3 | **P0** | `code-exec` 工具直接 `spawn` 无沙箱隔离 | `core/tools/code-exec.ts:28` |
| 4 | **P0** | `GET /api/agents` 全量返回 `agent.state` 含 `apiKey` 明文 | `api/routes/agents.ts:122,150,159,199,272` |
| 5 | **P0** | `crypto.randomUUID()` 4 处调用未 `import { randomUUID } from "node:crypto"` | `api/ws/index.ts:121`, `api/auth/index.ts:105`, `api/middleware/index.ts:17`, `api/routes/channels.ts` |
| 6 | **P0** | `PUT /api/models/providers/:id` 无 RBAC 鉴权 | `api/routes/models.ts:52-124` |
| 7 | **P0** | `GET /ws` 端点无鉴权 + `clients` Map 无连接上限 | `api/ws/index.ts:120-186` |
| 8 | **P0** | `Atomics.wait` 同步阻塞事件循环 20-300ms | `core/persistence/sqlite.ts:1138` |

---

## 1. P0 问题 — 生产故障与安全漏洞

### [SEC-P0-01] `.env` 文件泄露生产 Moonshot API Key 明文

- **文件**：`super-agent/.env`
- **行号**：14, 16
- **代码片段**：
  ```
  LLM_API_KEY=sk-UVApAlInXxKClUTCLnjwFVQGLKeiRZsF1cbd1mdAgh7YdWb8
  MOONSHOT_API_KEY=sk-UVApAlInXxKClUTCLnjwFVQGLKeiRZsF1cbd1mdAgh7YdWb8
  ```
- **风险分析**：真实生产密钥以明文提交至仓库根 `.env`。由于 `.env` 通常不在 `.gitignore`（从 git 状态可判断已未被忽略），该密钥随 git 历史永久传播。任何克隆过仓库的机器均可读取。
- **修复**：
  1. **立即轮换**该 API Key（在 Moonshot 控制台吊销并重发）
  2. 确认 `.env` 已被 `.gitignore` 排除（检查 `.gitignore` 含 `*.env` 或 `.env`）
  3. 若已提交历史，使用 `git filter-repo` 清除（评估影响后）
  4. `.env.example` 仅保留 `MOONSHOT_API_KEY=` 空占位

### [SEC-P0-02] 加密 Key 硬编码默认值

- **文件**：
  - `packages/core/src/llm/provider-store.ts:32-35`
  - `packages/core/src/tools/config-store.ts:18-21`
- **代码片段**：
  ```ts
  const SA_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY;
  const ENCRYPTION_KEY = createHash("sha256")
    .update(SA_KEY_FROM_ENV ?? "super-agent-default-encryption-key-v1")
    .digest();
  ```
- **风险分析**：若部署方未显式设 `SA_ENCRYPTION_KEY`，全部 provider apiKey 用**公开常量**派生密钥加密。攻击者获取 `.db` 文件即可一键解密。
- **现状评估**：`.env.example` 中**未列出** `SA_ENCRYPTION_KEY`，用户无从知晓需设置。启动时虽有 `logger.warn` 提示（provider-store.ts:38-47），但不会阻止启动。
- **修复**：
  1. 强制校验：若 `!SA_KEY_FROM_ENV` → `process.exit(1)`，拒绝启动
  2. `.env.example` 添加 `SA_ENCRYPTION_KEY=`（标注"必填，≥32字符"）
  3. 提供 `super-agent key-gen` CLI 子命令自动生成

### [SEC-P0-03] 代码执行工具无沙箱隔离

- **文件**：`packages/core/src/tools/code-exec.ts:22-65`
- **代码片段**：
  ```ts
  async function executeCode(cmd: string, args: string[], timeout = 30000) {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout });
    // ...
  }
  ```
- **风险分析**：`run_python`、`run_javascript`、`run_shell` 三个工具直接 `child_process.spawn`，共享宿主文件系统与网络。
- **攻击链**：LLM 被 prompt-injection 诱导调用 `run_shell: cat ~/.ssh/id_rsa` 或 `run_python: open("/etc/passwd").read()`。
- **现有的安全层**：`agent/runtime.ts:1174` 有 `securityManager.checkPermission(name, this.id)` 权限检查和 `sandboxLevel` 分层（none/process/container/docker/ssh），但 `code-exec.ts` 自身不感知这个 sandbox 体系。
- **修复**：
  1. **短期**：默认关闭 3 个执行工具（需用户显式在 UI 开启）
  2. **中期**：Docker 沙箱 (`docker run --network=none --read-only --rm`)
  3. **长期**：Firecracker microVM 或 gVisor

### [SEC-P0-04] Agent API 全量返回 `apiKey` 明文

- **文件**：`packages/api/src/routes/agents.ts`
- **行号**：122, 150, 159, 199, 272
- **代码片段**：
  ```ts
  return { agents, total };  // line 122: agent.state 含 config.llmProvider.apiKey
  return reply.status(201).send({ agent: agent.state });  // line 150
  return { agent: agent.state };  // line 159, 199
  return reply.status(201).send({ agent: forked.state });  // line 272
  ```
- **风险分析**：`agent.state` 是 `AgentRuntime.get state()` 的返回值（`agent/runtime.ts:190-199`），`config.llmProvider` 含完整 `apiKey`。同一仓库 `routes/models.ts:15-18` 定义了 `maskApiKey()` 函数且已在 model 路由中使用，但 agents 路由**从未调用**。
- **对比矛盾**：`models.ts:42-43` 返回 `maskedKey` → 前后端安全策略割裂
- **修复**：
  1. 抽取 `sanitizeAgentForClient(agent)` 工具函数，对所有 `apiKey` 做 `maskApiKey()`
  2. 添加单元测试：序列化后 `JSON.stringify` 不能包含完整 `sk-` 前缀

### [SEC-P0-05] `crypto.randomUUID()` 未导入 — Node 18 启动即崩

- **文件**（4 处）：
  - `packages/api/src/ws/index.ts:121` — `const clientId = crypto.randomUUID();`
  - `packages/api/src/auth/index.ts:105` — `const key = \`sk-${crypto.randomUUID().replace(/-/g, "")}\`;`
  - `packages/api/src/middleware/index.ts:17` — `crypto.randomUUID();`
  - `packages/api/src/routes/channels.ts`（推测类似用法）
- **代码分析**：`packages/api/src/index.ts` 第 17 行有 `import crypto from "node:crypto";`。但各独立模块文件不共享这个 import 声明。Node 18 LTS 全局 `crypto` 默认为 undefined（Node 20+ 才稳定暴露）。
- **风险**：Node 18 冷启动时 `ReferenceError: crypto is not defined`，**进程直接崩溃**。
- **修复**：每个文件顶部加 `import { randomUUID } from "node:crypto";`，所有 `crypto.randomUUID()` 改为 `randomUUID()`

### [SEC-P0-06] `PUT /api/models/providers/:id` 无 RBAC 鉴权

- **文件**：`packages/api/src/routes/models.ts:52-124`
- **代码片段**：路由注册为 `app.put<...>("/api/models/providers/:id", async (request, reply) => { ... })`，无 `preHandler` 属性
- **对比**：同文件无 RBAC；而 `ws/index.ts:231-235` 的 `POST /api/ws/broadcast` 和 `auth/index.ts:330-332` 的 `GET /api/auth/keys` 已正确使用 `preHandler: requirePermission("*")`
- **攻击链**：任何获取到合法 JWT 的用户都能修改 provider 的 `baseUrl` 为攻击者域，劫持所有后续 LLM 调用的 prompt/apiKey
- **修复**：
  1. 加 `preHandler: requirePermission("*")`
  2. `baseUrl` 变更写审计日志（已调用 `logConfigChange` 但需包括变更前后值）

### [SEC-P0-07] `GET /ws` 无鉴权 + 无连接上限

- **文件**：`packages/api/src/ws/index.ts:120-186`
- **代码片段**：
  ```ts
  app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
    const clientId = crypto.randomUUID();
    // ...
    clients.set(clientId, client);
    // ...
  });
  ```
- **风险**：
  1. 无鉴权：任何人 `wss://host/ws` 直接连接，收到所有平台事件（含 Agent 状态、协作进度等）
  2. `clients` Map 无上限：可发起 C10k DoS，内存持续增长直至 OOM
- **对比**：同文件的 `/ws/gateway` 端点（line 249-395）已正确实现 `Authorization: Bearer` 鉴权
- **修复**：
  1. 在 handler 开头加 JWT 校验（从 `request.headers.authorization` 提取）
  2. 引入 `MAX_WS_CLIENTS=500`，超过拒绝握手（返回 503）
  3. 每客户端禁止 `*` 通配订阅，需显式列举 topic

### [CORE-P0-08] `Atomics.wait` 同步阻塞事件循环

- **文件**：`packages/core/src/persistence/sqlite.ts:1135-1138`
- **代码片段**：
  ```ts
  const sharedBuf = new SharedArrayBuffer(4);
  const sharedArr = new Int32Array(sharedBuf);
  Atomics.wait(sharedArr, 0, 0, Math.round(jitter));
  ```
- **风险分析**：`saveDatabase()` 在重试时使用 `Atomics.wait` 进行 50-300ms 的**同步阻塞**。Node.js 主线程事件循环被冻结，期间所有 HTTP/WS 请求完全卡死。高并发场景下多写入触发连续阻塞。
- **修复**：改为真正异步 `await new Promise(r => setTimeout(r, jitter))`

---

## 2. P1 问题 — 关键功能缺陷

### 2.1 并发与存储

| ID | 文件 | 行号 | 问题 | 修复 |
|----|------|------|------|------|
| CORE-P1-01 | `agent/runtime.ts` | 398-435 | `acquireSessionLock` + `createSessionLock` 分两步，存在 race window | 用事务/互斥锁把两步合为原子 |
| CORE-P1-02 | `persistence/sqlite.ts` | — | 2972 行上帝文件，混 agent/conv/credentials/memory/FTS5/video_jobs 等 15+ 领域 | 按领域拆 `sqlite/agent-repo.ts` 等 |
| CORE-P1-03 | `llm/provider.ts` | 75-86 | Anthropic baseUrl 返回不兼容端点但不 throw | 立即 `throw new Error(...)` 并指引文档 |
| CORE-P1-04 | `collaboration/video-crew-presets.ts` | 78-81 | 默认 `model: "default"` 占位，运行时无兜底 | 构造时检测并及时抛错 |
| CORE-P1-05 | `memory/manager.ts` | — | QwenEmbedding 熔断降级到 SimpleEmbedding（2048 维假向量），污染同表召回 | 分表或拒绝写入并抛错 |

### 2.2 前后端契约双源漂移

| ID | 文件 | 问题 | 修复 |
|----|------|------|------|
| CTR-P1-01 | `web/types/api-types.ts` | 171 行手工同步 core 类型，漂移风险 | 从 `@super-agent/core` 直接导出纯类型（不含 Node 模块） |
| CTR-P1-02 | `ws/index.ts` | `event.ts` 多个 `"video:progress" as any` 绕过 PlatformEventType | 扩展 `PlatformEventType` 联合类型 |
| CTR-P1-03 | `api/` `web/` | AGENT_IDS 前后端硬编码两份 | 核心常量统一在 `core/src/contracts/`，前后端 import 消费 |
| CTR-P1-04 | `video-crew-presets.ts` | `model: "default"` 直接暴露到 Agent 构造，api/routes/video.ts 需做运行时替换 | 必须做显式校验，缺失时抛 400 |

### 2.3 API 层

| ID | 文件 | 行号 | 问题 | 修复 |
|----|------|------|------|------|
| API-P1-01 | `routes/models.ts` | 140-194 | `/providers/:id/test` 无速率限制，可当 API Key 扫描代理 | 加 `@fastify/rate-limit` (10/min) |
| API-P1-02 | `routes/video.ts` | 182-189 | WRITER Agent model="default" 未校验 | 显式抛 `400 Bad Request` |
| API-P1-03 | `routes/**` | — | 多处 `reply.send(err.message)` 泄露内部栈 | 统一走 `errorHandler` |

### 2.4 前端层

| ID | 文件 | 问题 |
|----|------|------|
| WEB-P1-01 | `app/media/page.tsx` | 下载用 `<a href>` 不带 Authorization header |
| WEB-P1-02 | `app/collaboration/page.tsx` | EventSource 无法携带自定义 Header（JWT token 丢失） |
| WEB-P1-03 | `app/chat/page.tsx` | TTS `URL.revokeObjectURL` 仅在 `onended` 释放 |
| WEB-P1-04 | 多处 | `apiFetch` 封装未统一，chat/dashboard/media 用不同 fetch 方式 |

---

## 3. P2 问题 — 可维护性

| ID | 文件 | 问题 |
|----|------|------|
| CORE-P2-01 | `agent/runtime.ts:1339-1357` | `updateConfig` 整段替换 vs `chatStream` 的 `llmOverride` 字段合并语义不一致 |
| CORE-P2-02 | `agent/voice.ts` | nonce 用 `Math.random()` 应改为 `randomBytes` |
| CORE-P2-03 | `agent/fallback.ts` | fallback 链无环检测，恶意配置导致无限递归 |
| API-P2-01 | `routes/video.ts` | snake_case + camelCase 混用 |
| API-P2-02 | `routes/video.ts` | 中文文件名 `Content-Disposition` 未用 RFC 5987 |
| API-P2-03 | `routes/**` | 多处 `as any` 绕过 Zod |
| CROSS-P2-01 | `services/video-forge-supervisor.ts` | `path.resolve(cwd, "../../services/video-forge")` 硬编码 |
| CROSS-P2-02 | `core/` dev watcher | 不产 dist，api/web 通过 dist 引用时拿旧产物 |
| CROSS-P2-03 | `.env.example` | 缺 8+ 关键变量：`SA_ENCRYPTION_KEY`、`JWT_SECRET`、`FRONTEND_URL`、`NEXT_PUBLIC_API_URL`、`VIDEO_CONCURRENCY_MAX` 等 |
| CROSS-P2-04 | `.env.example:5` | `PORT=3000` 但默认实际为 `3001`，误导用户 |

---

## 4. P3 问题 — 风格与优化

- 各包 ESLint + Prettier 配置重复，统一到 root `.eslintrc`
- `GET /api/models/providers` 每次请求调用 `getModelCatalog()` 加数据库查询，缺缓存层
- `buildToolDefinitions()` 工具裁剪逻辑硬编码 `mcp_`、`sysops` 前缀，缺可配置扩展
- 多页面使用原生 `confirm()/alert()`，与自定义 Modal 组件混用
- 无 i18n 基础：中英混合硬编码

---

## 5. 亮点（应保持）

1. ✅ `packages/core` 零反向依赖 api/web，分层纪律良好
2. ✅ api 层所有持久化通过 core 封装，不存在直接写 DB
3. ✅ `VIDEO_AGENT_IDS` 前后端 6 个 `video-crew-*` ID 一致
4. ✅ Zod Schema 广泛用于请求体校验
5. ✅ auth/index.ts 启动时校验 JWT_SECRET 弱密码（KNOWN_WEAK_SECRETS），生产环境拒绝默认值
6. ✅ `/ws/gateway` 正确实现 `Authorization: Bearer` 鉴权（可作为 `/ws` 修复参照）
7. ✅ `agent/runtime.ts` 有 session lock 机制、消息 sanitize、chat 错误回滚

---

## 6. 完整问题清单

| # | ID | 严重度 | 模块 | 文件:行号 | 描述 |
|---|-----|--------|------|-----------|------|
| 1 | SEC-P0-01 | P0 | cross | `.env:14,16` | 生产 Moonshot API Key 明文 |
| 2 | SEC-P0-02 | P0 | core | `provider-store.ts:34` `config-store.ts:20` | 加密 key 硬编码默认值 |
| 3 | SEC-P0-03 | P0 | core | `code-exec.ts:28` | spawn 无沙箱 |
| 4 | SEC-P0-04 | P0 | api | `agents.ts:122,150,159,199,272` | agent.state 含 apiKey 明文 |
| 5 | SEC-P0-05 | P0 | api | `ws/index.ts:121` `auth/index.ts:105` `middleware/index.ts:17` | crypto.randomUUID 未导入 |
| 6 | SEC-P0-06 | P0 | api | `models.ts:52-124` | PUT providers 无 RBAC |
| 7 | SEC-P0-07 | P0 | api | `ws/index.ts:120-186` | /ws 无鉴权+无连接上限 |
| 8 | CORE-P0-08 | P0 | core | `sqlite.ts:1138` | Atomics.wait 阻塞事件循环 |
| 9 | CORE-P1-01 | P1 | core | `runtime.ts:398-435` | session lock 非原子 |
| 10 | CORE-P1-02 | P1 | core | `sqlite.ts` | 2972 行上帝文件 |
| 11 | CORE-P1-03 | P1 | core | `provider.ts:75-86` | Anthropic 静默失败 |
| 12 | CORE-P1-04 | P1 | core | `video-crew-presets.ts:78-81` | model="default" 无兜底 |
| 13 | CORE-P1-05 | P1 | core | `memory/manager.ts` | QwenEmbedding 降级污染 |
| 14 | CTR-P1-01 | P1 | web | `types/api-types.ts` | 手工 171 行同步 core |
| 15 | CTR-P1-02 | P1 | cross | `ws/index.ts` + core `events/` | PlatformEventType 未含视频事件 |
| 16 | CTR-P1-03 | P1 | cross | `api/` `web/` | AGENT_IDS 双写 |
| 17 | API-P1-01 | P1 | api | `models.ts:140-194` | /test 无速率限制 |
| 18 | API-P1-02 | P1 | api | `video.ts:182-189` | model="default" 未校验 |
| 19 | API-P1-03 | P1 | api | `routes/**` | err.message 直出 |
| 20 | WEB-P1-01 | P1 | web | `media/page.tsx` | <a href> 无 Authorization |
| 21 | WEB-P1-02 | P1 | web | `collaboration/page.tsx` | EventSource 无 Authorization |
| 22 | WEB-P1-03 | P1 | web | `chat/page.tsx` | TTS blob 内存泄漏 |
| 23 | WEB-P1-04 | P1 | web | 多处 | apiFetch 未统一 |
| 24 | CORE-P2-01 | P2 | core | `runtime.ts:1339-1357` | updateConfig vs llmOverride 不一致 |
| 25 | CORE-P2-02 | P2 | core | `voice.ts` | Math.random nonce |
| 26 | CORE-P2-03 | P2 | core | `fallback.ts` | 无环检测 |
| 27 | API-P2-01 | P2 | api | `video.ts` | snake_case + camelCase 混用 |
| 28 | API-P2-02 | P2 | api | `video.ts` | 中文文件名未 RFC 5987 |
| 29 | API-P2-03 | P2 | api | `routes/**` | as any 绕过 Zod |
| 30 | CROSS-P2-01 | P2 | cross | `video-forge-supervisor.ts` | path 硬编码 |
| 31 | CROSS-P2-02 | P2 | cross | `core/` dev watcher | 不产 dist |
| 32 | CROSS-P2-03 | P2 | cross | `.env.example` | 缺 8+ 变量 |
| 33 | CROSS-P2-04 | P2 | cross | `.env.example:5` | PORT=3000 误导 |

---

## 7. 修复优先级建议

### 本周必做 (P0 全量 · 2-3 人日)
1. **D1**：轮换泄露 Key + `.env` 进 `.gitignore` → 修复 `crypto` import
2. **D2**：sanitizeAgent + `/ws` 鉴权 + PUT providers RBAC
3. **D3**：`SA_ENCRYPTION_KEY` 强制校验 + `Atomics.wait` 改 async

### 两周内 (P1 · 6-8 人日)
4. session lock 原子化 + sqlite.ts 拆分
5. `web/types/api-types.ts` → `@super-agent/core/types` 直接导出
6. 前端鉴权链路 (media/collaboration/chat)
7. 契约统一 (`PlatformEventType` + `AGENT_IDS`)

### 持续 (P2/P3)
- 每次 sprint 挑 3-5 条 P2，逐步消化

---

**报告终**
