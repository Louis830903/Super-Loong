# 系统审视问题完善 Spec v1

> 审查日期：2026-04-23
> 基于五维度全面系统审视报告（前后端对齐 / 功能孤岛 / 实现完整性 / A2A 协议 / 记忆提示词）
> 涵盖 10 项改进建议（I-1 ~ I-10）+ 1 项遗留优化（retryWithBackoff）

---

## 一、问题全景

### 1.1 来源

- **审计维度**：前后端对齐、功能孤岛、实现完整性、A2A 协议、记忆+提示词
- **审计结论**：整体架构完善（17 后端路由 + 14 前端页面），核心断点集中在 A2A 入方向链路、2 个运维占位符、8 个功能孤岛模块
- **关联计划**：
  - `A2A审核问题修复计划` — Batch 1/2 已完成，Batch 3 剩余 Task 3.3（retryWithBackoff）
  - `FIX-PLAN-2026-04-15.md` — 56 项修复（Phase A~F），侧重安全+正确性，与本 Spec 互补不重叠

### 1.2 问题清单总览

| 批次 | 级别 | 编号 | 描述 | 核心文件 | 预估工时 |
|------|------|------|------|---------|---------|
| 1 | **P0** | I-1 | A2A onSendMessage 占位符：入方向完全不可用 | `api/src/index.ts` L144-146 | 3h |
| 2 | **P1** | I-2 | HeartbeatRunner 未接入全局调度 | `api/src/context.ts` L269-273 | 1.5h |
| 2 | **P1** | I-3 | 渠道重启逻辑不完整 | `api/src/routes/channels.ts` L217-223 | 1.5h |
| 2 | **P1** | R-1 | 重试逻辑重复（遗留 Task 3.3） | `a2a-client.ts` + `a2a-push.ts` | 1h |
| 3 | **P2** | I-7 | A2A onStreamMessage 未实现 | `api/src/index.ts` + `server.ts` | 2h |
| 3 | **P2** | I-8 | AgentCard 硬编码 | `api/src/index.ts` L120-135 | 1h |
| 3 | **P2** | I-6 | 前端类型未与 core 共享 | `web/src/` 多文件 | 2h |
| 3 | **P2** | I-4 | 4 个 Evolution 高级模块孤岛 | `api/src/routes/evolution.ts` | 3h |
| 3 | **P2** | I-5 | 知识图谱无 REST 端点 | `api/src/routes/` 新建 | 2h |
| 4 | **P3** | I-9 | MessageRouter 功能闲置 | `core/src/routing/router.ts` | 0.5h |
| 4 | **P3** | I-10 | A2A 无前端管理 UI | `web/src/app/` 新建 | 4h |

**总计：11 项，预估 ~21.5h**

### 1.3 与已有计划的关系

```
FIX-PLAN-2026-04-15.md (56项)     本 Spec (11项)          A2A审核修复计划 (22项)
├── Phase A: 安全修复(13)          ├── Batch 1: P0(1)      ├── Batch 1: ✅ 已完成
├── Phase B: 正确性(20)            ├── Batch 2: P1(3)      ├── Batch 2: ✅ 已完成
├── Phase C: 性能(6)               ├── Batch 3: P2(5)      └── Batch 3: ⚠️ 剩余 Task 3.3
├── Phase D: 清理(10)              └── Batch 4: P3(2)          → 合并入本 Spec R-1
├── Phase E: Schema(4)
└── Phase F: 类型(3)
     ↕ 互补不重叠                    ↕ 包含遗留项
```

**去重说明**：
- FIX-PLAN B-18（Channel 持久化）与本 Spec I-3（渠道重启）**互补**：B-18 解决持久化存储，I-3 解决重启时从持久化恢复连接。I-3 依赖 B-18 先完成。
- FIX-PLAN B-19（IM 网关异常隔离）与 I-3 **独立**：B-19 是 Python 网关层，I-3 是 Node API 层。
- 本 Spec R-1 = A2A 审核计划 Task 3.3，合并后原计划该项可标记为已迁移。

---

## 二、Batch 1：P0 核心断点修复（1 项）

### Task 1.1 — 实现 A2A onSendMessage 业务逻辑（I-1）[已审查修订 S1/S2]

**问题**：`packages/api/src/index.ts` L144-146 的 `onSendMessage` 回调是 TODO 占位符，远端 Agent 通过 A2A 协议发来的消息只能原样回显，不调用 AgentRuntime.chat() 处理。整个 A2A 入方向形同虚设。

**根因**：A2A 协议端点注册时仅提供了骨架回调，未完成与 AgentRuntime 的集成。

**修复方案**：

#### 1.1.0 前置：MessageRouter 暴露 defaultAgentId getter

- **文件**：`packages/core/src/routing/router.ts`
- **新增**：
```typescript
/** 获取默认 Agent ID（由 index.ts 启动时设置） */
getDefaultAgentId(): string | null {
  return this.defaultAgentId;
}
```

#### 1.1.1 实现 onSendMessage 回调（复用已有 Runtime）

- **文件**：`packages/api/src/index.ts` L144-147
- **改动**：

```typescript
onSendMessage: async (req) => {
  // 1. 从请求中提取文本内容
  const textParts = req.message.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");

  if (!textParts.trim()) {
    return {
      type: "message",
      message: { role: "agent", parts: [{ type: "text", text: "Empty message received." }] },
    };
  }

  // 2. 通过 router 获取默认 Agent 的已有 Runtime 实例（避免重复创建）
  const defaultAgentId = ctx.router.getDefaultAgentId();
  const runtime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
  if (!runtime) {
    throw new Error("No default agent configured for A2A message handling");
  }

  // 3. 构建隔离会话 ID（A2A 请求不复用用户会话）
  const sessionId = `a2a-${crypto.randomUUID()}`;

  // 4. 调用已有 Runtime 的 chat() 方法
  // chat() 返回 { sessionId, response, toolCalls, attachments }
  const result = await runtime.chat(textParts, sessionId);

  // 5. 包装为 A2A Message 格式返回
  return {
    type: "message",
    message: {
      role: "agent",
      parts: [{ type: "text", text: result.response || "" }],
    },
  };
},
```

**关键设计决策**：
- **复用已有 Runtime**（通过 `agentManager.getAgent()`），而非每次请求新建——避免重复初始化 MarkdownMemory、PromptEngine、ContextCompressor 等重量级组件
- **通过 `ctx.router.getDefaultAgentId()`** 获取默认 Agent ID，这是系统启动时在 index.ts L283/L288 设置的
- **隔离会话 ID**（`a2a-` 前缀）确保不污染用户对话历史

#### 1.1.2 导入必要依赖

- **文件**：`packages/api/src/index.ts` 顶部导入区
- **新增**：`import crypto from "node:crypto";`（如尚未导入）

**验收标准**：
1. 远端 Agent 通过 `POST /a2a` 发送 `SendMessage` 请求后，收到由 AgentRuntime 生成的实际回复（非回显）
2. 会话使用 `a2a-` 前缀的隔离 ID，不污染用户对话历史
3. 现有 18 个 A2A 测试用例仍然全部通过

**依赖**：需先完成 1.1.0（router getter）。

---

## 三、Batch 2：P1 运维级修复（3 项）

### Task 2.1 — HeartbeatRunner 构造 + 接入全局调度（I-2）[已审查修订 S3]

**问题**：`packages/api/src/context.ts` L269-273 的心跳回调是占位符 `return "[Heartbeat] executed"`。HeartbeatRunner 在 `core/src/cron/heartbeat.ts` 有完整实现（335 行），但 `runtime.ts` L182 即使 `heartbeatConfig.enabled = true` 也赋值 `undefined`（"待外部注入 CronScheduler 后构造"），外部也未补充构造步骤。

**根因**：HeartbeatRunner 设计依赖外部注入 CronScheduler，但这个注入步骤从未实现。

**修复方案（两步）**：

#### Step A：在 index.ts 默认 Agent 创建后，构造 HeartbeatRunner 实例

- **文件**：`packages/api/src/index.ts`（在 L298 "默认路由已确定" 之后）
- **新增**：

```typescript
// 为默认 Agent 构造 HeartbeatRunner（如果心跳配置启用）
const defaultAgentId = ctx.router.getDefaultAgentId();
const defaultRuntime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
if (defaultRuntime) {
  // 注意：heartbeatConfig 在 AgentRuntimeOptions 中，AgentConfig 无 heartbeat 字段
  // 需要从原始 AgentRuntimeOptions 或配置文件获取，此处用 configStore 读取
  const hbConfig = ctx.configStore?.get<{ enabled?: boolean }>('heartbeat') ?? { enabled: false };
  if (hbConfig?.enabled) {
    const runner = new HeartbeatRunner(
      { ...DEFAULT_HEARTBEAT_CONFIG, ...hbConfig },
      ctx.cronScheduler,
    );
    // 注入执行回调：调用 Agent 的 chat 方法
    runner.setExecuteFn(async (msg, ctxMd, isolated, model) => {
      const sid = isolated ? `hb-${Date.now()}` : undefined;
      return await defaultRuntime.chat(msg, sid);
    });
    // 注入投递回调（按需实现，默认无操作）
    runner.setDeliverFn(async (target, content) => {
      app.log.info({ target, contentLen: content.length }, "Heartbeat alert");
    });
    // 存储到 Runtime（需要 Runtime 暴露 public setter）
    (defaultRuntime as any).heartbeatRunner = runner;
    runner.start();
    app.log.info({ agentId: defaultAgentId }, "HeartbeatRunner constructed and started");
  }
}
```

#### Step B：修改 context.ts 心跳回调委托

- **文件**：`packages/api/src/context.ts` L269-274
- **改动**：

```typescript
cronScheduler.setHeartbeatCallback(async (job) => {
  const agentId = job.meta?.agentId || router.getDefaultAgentId();
  if (!agentId) return "[Heartbeat] skipped — no agent";

  const agent = agentManager.getAgent(agentId);
  if (!(agent as any)?.heartbeatRunner) return "[Heartbeat] skipped — no runner";

  const result = await (agent as any).heartbeatRunner.runOnce();
  return result ?? "[Heartbeat] OK";
});
```

**注意**：`heartbeatRunner` 在 Runtime 中是可选字段。为避免修改 Runtime 类的 public API，暂通过 `(agent as any)` 访问。后续可在 Runtime 中正式暴露 `public heartbeatRunner?: HeartbeatRunner` 字段。

**前提条件**：需先完成 Task 1.1.0（router.getDefaultAgentId getter）

**验收标准**：
1. 配置 `heartbeat.enabled = true` 后，CronScheduler 触发心跳时实际调用 HeartbeatRunner.runOnce()
2. 心跳结果按配置投递到目标（或静默吞掉 HEARTBEAT_OK）
3. 无 Agent 绑定时优雅降级而非崩溃

---

### Task 2.2 — 渠道重启逻辑完善（I-3）[已审查修订 S4/S5]

**问题**：`packages/api/src/routes/channels.ts` L217-223 的 `POST /api/gateway/restart/:platform` 端点：
1. 执行 disconnect 后直接返回，缺少从持久化配置重新连接的步骤
2. `proxyPOST` 在 disconnect 失败时会调用 `reply.status().send()`，导致后续 `return` 双重响应（Fastify 抛 "Already replied"）

**根因**：restart 路由的设计意图是"断开 + 重连"，但重连部分只留了 TODO。

**修复方案**：

- **文件**：`packages/api/src/routes/channels.ts` L217-223
- **改动**（直接调用 fetch 替代 proxyPOST，避免 reply 竞争）：

```typescript
app.post<{ Params: { platform: string } }>("/api/gateway/restart/:platform", async (request, reply) => {
  const { platform } = request.params;
  app.log.info({ action: "gateway_restart", platform }, "Restarting channel");

  // 1. 断开现有连接（直接 fetch，不通过 proxyPOST 避免 reply 竞争）
  try {
    await fetch(`${IM_GATEWAY_URL}/channels/${platform}/disconnect`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err: any) {
    app.log.warn({ platform, error: err.message }, "Disconnect failed during restart, continuing");
  }

  // 2. 从持久化 Map 获取连接配置（B-18 已实现 SQLite 持久化 + 启动时 loadFromDB）
  const channelConfig = channels.get(platform);
  if (!channelConfig?.config || Object.keys(channelConfig.config).length === 0) {
    return reply.status(400).send({
      error: `No saved configuration for platform "${platform}". Cannot restart without config.`,
    });
  }

  // 3. 使用持久化配置重新连接
  try {
    const connectRes = await fetch(`${IM_GATEWAY_URL}/channels/${platform}/connect`, {
      method: "POST",
      headers: gatewayHeaders(),
      body: JSON.stringify({ credentials: channelConfig.config }),
      signal: AbortSignal.timeout(10000),
    });
    const connectData: any = await connectRes.json();
    return reply.send({ status: "restarted", platform, connection: connectData });
  } catch (err: any) {
    app.log.error({ platform, error: err.message }, "Reconnect failed during restart");
    return reply.status(502).send({
      error: `Restart failed: disconnect OK but reconnect failed — ${err.message}`,
    });
  }
});
```

**关键修订**：
- 使用 `channelConfig?.config`（非 `credentials`）— Map value 结构为 `{ id, config, status }`
- 使用 `gatewayHeaders()` 携带 API Key — 与其他代理端点一致
- 直接 fetch 而非 proxyPOST — 彻底避免双重响应 bug

**验收标准**：
1. `POST /api/gateway/restart/feishu` 能成功断开并重连
2. 无持久化配置时返回 400 而非 crash
3. 断开成功但重连失败时返回 502 并保留错误信息

---

### Task 2.3 — 提取公共重试函数 retryWithBackoff（R-1）

**问题**：`a2a-client.ts` L266-344 的 `rpcCall` 和 `a2a-push.ts` L170-219 的 `deliverWithRetry` 的指数退避逻辑高度重复（初始延迟、最大延迟、尝试次数、isTransient 判断、延迟计算）。

**根因**：两处独立实现了相同的重试策略，违反 DRY。

**修复方案**：

- **新建文件**：`packages/core/src/collaboration/retry.ts`

```typescript
import pino from "pino";

const logger = pino({ name: "retry" });

/** 重试配置 */
export interface RetryConfig {
  /** 最大尝试次数（含首次，默认 3） */
  maxAttempts?: number;
  /** 首次重试延迟（毫秒，默认 500） */
  initialDelayMs?: number;
  /** 最大延迟上限（毫秒，默认 8000） */
  maxDelayMs?: number;
}

const DEFAULTS: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8000,
};

/**
 * 带指数退避的通用重试函数
 * @param fn - 执行函数
 * @param config - 重试配置
 * @param isTransient - 判断错误是否可重试（默认全部可重试）
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  isTransient?: (error: unknown) => boolean,
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs } = { ...DEFAULTS, ...config };

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // 非瞬态错误不重试
      if (isTransient && !isTransient(err)) throw err;

      // 最后一次尝试不等待
      if (attempt + 1 >= maxAttempts) break;

      const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
      logger.debug({ attempt: attempt + 1, maxAttempts, delay }, "Retrying after transient error");
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
```

- **改造**：`a2a-client.ts` 的 `rpcCall` 内层循环替换为 `retryWithBackoff()` 调用
- **改造**：`a2a-push.ts` 的 `deliverWithRetry` 内层循环替换为 `retryWithBackoff()` 调用
- **导出**：在 `packages/core/src/collaboration/index.ts` 中导出 `retryWithBackoff` 和 `RetryConfig`
- **导出**：在 `packages/core/src/index.ts` 中从 collaboration 模块重新导出

**验收标准**：
1. `retryWithBackoff()` 功能与原有逻辑完全一致（延迟、次数、transient 判断）
2. 两处调用点行为不变
3. 18 个 A2A 测试全部通过

---

## 四、Batch 3：P2 功能完善（5 项）

### Task 3.1 — 实现 A2A onStreamMessage 回调（I-7）[已审查修订 S6]

**问题**：`server.ts` L62-65 定义了 `onStreamMessage` 接口，`POST /a2a/stream` 端点（L172-228）在 `onStreamMessage` 存在时注册。但 `index.ts` L139-148 注册 a2aPlugin 时**未提供 onStreamMessage**，导致 SSE 流式端点未注册。

**根因**：与 Task 1.1 同源——A2A 业务逻辑尚未接入 AgentRuntime。

**修复方案**：

- **文件**：`packages/api/src/index.ts` L139-148
- **在 a2aPlugin 注册选项中新增**：

```typescript
onStreamMessage: async (req, write) => {
  // 1. 提取文本
  const textParts = req.message.parts
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");

  // 2. 复用已有 Runtime（与 Task 1.1 相同方式）
  const defaultAgentId = ctx.router.getDefaultAgentId();
  const runtime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
  if (!runtime) {
    write(JSON.stringify({ type: "error", error: "No default agent configured" }));
    return;
  }

  const sessionId = `a2a-stream-${crypto.randomUUID()}`;

  // 3. 调用流式 chatStream()（已确认存在，返回 AsyncGenerator）
  // 签名：chatStream(userMessage: string, sessionId?: string, opts?)
  for await (const chunk of runtime.chatStream(textParts, sessionId)) {
    // 4. 每个 chunk 包装为 StreamFrame 写出
    if (chunk.type === "content") {
      write(JSON.stringify({
        type: "status",
        taskId: sessionId,
        state: "working",
        message: { role: "agent", parts: [{ type: "text", text: chunk.text || "" }] },
      }));
    }
    // tool_call / tool_result / error 等其他类型按需转发
  }
},
```

**关键修订**：
- 复用已有 Runtime（与 Task 1.1 一致），而非新建
- `chatStream()` 参数为 `(userMessage, sessionId?, opts?)`，非对象参数
- chatStream 已确认存在（[runtime.ts L672-679](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/agent/runtime.ts#L672-L679)），返回 `AsyncGenerator<{ type: string; [key: string]: unknown }>`

**验收标准**：
1. `POST /a2a/stream` 端点能返回 SSE 流
2. 每个 chunk 以 `data: {...}\n\n` 格式发送
3. 流结束后发送 `{type: "done"}` 帧

---

### Task 3.2 — AgentCard 动态生成（I-8）

**问题**：`packages/api/src/index.ts` L120-135 和 L140 的 AgentCard 信息全部硬编码：
- `name: "Super Agent"`
- `skills: []`（空数组）
- `capabilities: { streaming: true }`（不反映实际能力）

远端通过 `GET /.well-known/agent-card.json` 发现的信息与实际 Agent 能力不匹配。

**修复方案**：

- **文件**：`packages/api/src/index.ts` L119-136
- **改动**：将硬编码替换为从 AgentManager 动态获取：

```typescript
await registerWellKnownRoute(app, (extended) => {
  // 通过 router 获取默认 Agent（复用 Task 1.1 相同模式）
  const defaultAgentId = ctx.router.getDefaultAgentId();
  const defaultRuntime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
  const agentName = defaultRuntime?.config?.name || "Super Agent";
  const agentDesc = defaultRuntime?.config?.description || "AI Agent Platform";

  // 从已加载技能生成 skills 列表（SkillLoader 方法为 listSkills() 非 getLoadedSkills()）
  const skills = (ctx.skillLoader?.listSkills() || []).map(s => ({
    id: s.id,
    name: s.name,
    description: s.description || "",
  }));

  const baseCard = {
    name: agentName,
    description: agentDesc,
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: `http://${HOST}:${PORT}`,
    capabilities: {
      streaming: true,
      pushNotifications: !!ctx.a2aPushDispatcher,
    },
    skills,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };

  if (extended) {
    return {
      ...baseCard,
      securitySchemes: { bearer: { type: "http" as const, scheme: "bearer" } },
    };
  }
  return baseCard;
});
```

- 同步修改 L140 的 `getAgentCard` 回调使用相同的动态逻辑（避免两处 Card 不一致）

**验收标准**：
1. `GET /.well-known/agent-card.json` 返回的 name/description 来自实际 Agent 配置
2. skills 数组包含已加载的技能列表（非空）
3. 修改 Agent 配置后，Card 信息动态更新

---

### Task 3.3 — 前端类型共享（I-6）[已审查修订 S7]

**问题**：前端各页面（collaboration/page.tsx、evolution/page.tsx 等）本地定义了 `SkillProposal`、`CollabHistoryItem`、`AttachmentItem` 等接口，未引用 `packages/core/src/types/index.ts` 中的共享类型。后端修改字段后前端不会编译报错，只会运行时静默失败。

**审查发现**：
- `packages/web/package.json` **不含** `@super-agent/core` 依赖
- core 包含 pino、better-sqlite3、zod-to-json-schema 等 Node.js 模块
- 即使 type-only import，TypeScript 解析时仍需 core 全依赖链可解析
- **直接依赖 core 会导致 Next.js 编译报错**（Node.js API 在浏览器不可用）

**修复方案（调整为手动同步方案，最低耦合）**：

#### 3.3.1 创建前端独立类型文件

- **新建文件**：`packages/web/src/types/api-types.ts`
- **方式**：手动定义与后端对齐的接口，头部注释标注来源

```typescript
/**
 * 前端 API 类型定义 — 与 @super-agent/core types/index.ts 手动同步
 * 源文件：packages/core/src/types/index.ts
 * 同步策略：后端修改类型后，通过代码审查确保此文件同步更新
 */

// Agent 相关
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  llmProvider: { type: string; model: string; /* ... */ };
  // ... 仅包含前端实际使用的字段
}

// 记忆相关
export interface MemoryEntry {
  id: string;
  type: "core" | "recall" | "archival";
  content: string;
  metadata?: Record<string, unknown>;
}

// 协作相关
export interface CollabHistoryItem { /* ... */ }

// 进化相关
export interface SkillProposal { /* ... */ }

// 安全相关
export interface SecurityPolicy { /* ... */ }
```

#### 3.3.2 前端页面逐步迁移

按优先级逐个替换本地类型定义：

1. `collaboration/page.tsx` — 移除本地 `CollabHistoryItem`，改引用 `@/types/api-types`
2. `evolution/page.tsx` — 移除本地 `SkillProposal`，改引用 `@/types/api-types`
3. `memory/page.tsx` — 移除本地 `MemoryEntry`，改引用 `@/types/api-types`
4. `security/page.tsx` — 移除本地 `SecurityPolicy`，改引用 `@/types/api-types`

#### 3.3.3 后续演进（可选）

若类型越来越多，可演进为方案 2：
- 新建 `packages/shared-types/` 纯类型包（无任何运行时依赖）
- core 和 web 都引用它
- 需要配置 monorepo 工作区和 tsconfig

**关键修订**：放弃直接依赖 `@super-agent/core`，避免 Node.js 模块污染前端构建。

**验收标准**：
1. 前端至少 4 个核心页面使用统一类型文件
2. `pnpm build` 在 web 包中通过
3. 无任何 Node.js 模块污染前端构建

---

### Task 3.4 — Evolution 高级模块 API 接入（I-4）[已审查修订 S8]

**问题**：4 个进化引擎高级模块（SessionSearchEngine、KnowledgeExtractor、InsightsEngine、VerificationPipeline）在 core 中完整实现并导出，但无 API 路由暴露，前端也无 UI 入口。

**审查发现**：4 个子模块和 KnowledgeGraph 均未在 context.ts 初始化，需要补充初始化步骤。

**修复方案（三步）**：

#### Step 0：扩展 AppContext 接口 + 初始化

- **文件**：`packages/api/src/context.ts`
- **改动**：
  1. 在 AppContext 接口新增可选字段：
  ```typescript
  sessionSearch?: SessionSearchEngine;
  knowledgeExtractor?: KnowledgeExtractor;
  insightsEngine?: InsightsEngine;
  verificationPipeline?: VerificationPipeline;
  knowledgeGraph?: KnowledgeGraph;
  ```
  2. 在 `buildContext()` 中初始化（置于 evolutionEngine 初始化之后）：
  ```typescript
  const sessionSearch = new SessionSearchEngine(sqliteBackend);
  const knowledgeExtractor = new KnowledgeExtractor();
  const insightsEngine = new InsightsEngine();
  const verificationPipeline = new VerificationPipeline();
  const knowledgeGraph = new KnowledgeGraph(sqliteBackend);
  ```
  注意：各模块构造参数需执行时确认。

#### Step 1：新增 API 端点

- **文件**：`packages/api/src/routes/evolution.ts`
- **新增端点**（在现有路由文件中追加）：

| 方法 | 路径 | 功能 | 对应模块 |
|------|------|------|----------|
| POST | `/api/evolution/search` | 会话全文搜索 | SessionSearchEngine.search() |
| POST | `/api/evolution/extract` | 知识提取 | KnowledgeExtractor.extract() |
| GET | `/api/evolution/insights` | 获取统计洞察 | InsightsEngine.generateReport() |
| POST | `/api/evolution/verify` | 运行验证管道 | VerificationPipeline.runAll() |
| GET | `/api/evolution/verify/results` | 获取验证结果 | VerificationPipeline.getResults() |

#### Step 2：端点守护

- 各端点需检查 `ctx.sessionSearch` 等是否存在，不存在时返回 `501 Not Implemented`
- 这样可以在未初始化时优雅降级，而非 crash

**验收标准**：
1. 5 个新端点均可正常调用并返回有意义的结果
2. 无 Agent 活动时，insights 返回空报告而非 crash
3. 添加 Zod Schema 验证（与 FIX-PLAN E-2 对齐）

---

### Task 3.5 — 知识图谱 REST 端点（I-5）

**问题**：KnowledgeGraph 在 core 层有完整实现（三元组存储、子图查询、路径搜索、Mermaid 导出），但仅通过 Agent 工具（`knowledge_query`/`knowledge_add`）间接调用，用户无法通过 API/UI 交互式探索。

**修复方案**：

- **新建文件**：`packages/api/src/routes/knowledge-graph.ts`
- **端点设计**：

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/knowledge/stats` | 三元组统计（调用 countTriples） |
| GET | `/api/knowledge/entities/:name` | 获取实体关系（getOutgoing + getIncoming） |
| POST | `/api/knowledge/search` | 子图查询（subgraph） |
| POST | `/api/knowledge/path` | 路径搜索（findPath） |
| GET | `/api/knowledge/export?format=mermaid\|graphml` | 导出可视化格式 |
| POST | `/api/knowledge/triples` | 手动添加三元组 |
| DELETE | `/api/knowledge/triples` | 按条件删除三元组 |

- **注册**：在 `packages/api/src/index.ts` 的插件注册区域添加路由注册

**验收标准**：
1. 7 个端点均可正常调用
2. Mermaid 格式导出可直接渲染为图形
3. 查询空图时返回空结果而非报错

---

## 五、Batch 4：P3 清理与增强（2 项）

### Task 4.1 — MessageRouter 评估与处置（I-9）

**问题**：MessageRouter 在 `context.ts` 中创建并存入 AppContext，但仅用于 `setDefaultAgent()`，核心的 `route()` 方法未被任何路由调用。

**分析**：

MessageRouter 的设计意图是将入站消息（来自 IM 渠道）路由到正确的 Agent，支持三级匹配：
1. 精准匹配（channelId + chatId）
2. 信道级匹配（channelId）
3. 默认 Agent 兜底

**决策**：**保留并接入**，而非移除。

**修复方案**：

- 在 IM 网关消息入站处理链路中接入 `router.resolve()` 调用
- 具体位置：`packages/api/src/routes/channels.ts` 或 `chat.ts` 中处理入站消息的逻辑
- 当渠道消息到达时，先通过 MessageRouter 确定目标 Agent，再调用对应 Runtime

**验收标准**：
1. 不同渠道可绑定不同 Agent
2. 无绑定时降级到默认 Agent
3. 现有渠道功能不受影响

---

### Task 4.2 — A2A 前端管理页面（I-10）

**问题**：A2A 协议后端有完整实现（well-known、JSON-RPC、SSE、Push、Registry），但前端无任何 A2A 相关管理页面，运维完全不可见。

**修复方案**：

- **新建目录**：`packages/web/src/app/a2a/`
- **新建文件**：`packages/web/src/app/a2a/page.tsx`

**页面功能模块**：

| 模块 | 功能 | 数据源 |
|------|------|--------|
| Agent 注册表 | 展示已注册的远端 Agent（name、url、capabilities） | GET /api/collab/remote-agents |
| Task 列表 | 展示 A2A Task 状态（submitted/working/completed/failed） | GET /api/collab/tasks |
| Push 订阅管理 | 查看/取消 Push Notification 订阅 | GET/DELETE /api/collab/push-subscriptions |
| Agent Card 预览 | 展示本机 Agent Card 信息 | GET /.well-known/agent-card.json |
| 手动测试面板 | 向远端 Agent 发送测试消息 | POST /api/collab/send-to-remote |

**UI 布局**：使用与其他页面一致的 Tabs 布局，包含"注册表"、"任务"、"订阅"、"调试"四个 Tab。

**验收标准**：
1. `/a2a` 路由可正常访问
2. 各 Tab 正确加载并展示数据
3. 与现有 UI 风格一致

---

## 六、执行策略

### 批次顺序与验证节点

```
Batch 1: P0 核心断点 (1项, ~3h)
  Task 1.1: A2A onSendMessage 实现
    ↓
  ✓ 验证：A2A 端到端测试 + 回归
    ↓
Batch 2: P1 运维修复 (3项, ~4h)
  Task 2.1: HeartbeatRunner 接入
  Task 2.2: 渠道重启完善
  Task 2.3: retryWithBackoff 提取
    ↓
  ✓ 验证：心跳触发测试 + 渠道重启测试 + A2A 回归
    ↓
Batch 3: P2 功能完善 (5项, ~10h)
  Task 3.1: A2A onStreamMessage
  Task 3.2: AgentCard 动态化
  Task 3.3: 前端类型共享
  Task 3.4: Evolution 模块 API
  Task 3.5: 知识图谱 REST API
    ↓
  ✓ 验证：pnpm build 全量 + 新端点测试
    ↓
Batch 4: P3 增强 (2项, ~4.5h)
  Task 4.1: MessageRouter 接入
  Task 4.2: A2A 前端 UI
    ↓
  ✓ 验证：全量回归 + UI 检查
```

### 风险矩阵

| 编号 | 风险 | 影响 | 缓解措施 |
|------|------|------|---------|
| R1 | Task 1.1 AgentRuntime 构造参数不匹配 | 阻断 Batch 1 | 执行前先 read_file 确认 Runtime 构造函数签名 |
| R2 | Task 2.1 AgentManager 无 getRuntime() 方法 | 阻断 Task 2.1 | 需先评估 Manager 是否维护 Runtime 池 |
| R3 | Task 3.1 Runtime 不支持 chatStream() | 阻断 Task 3.1 | 先检查 LLMProvider.stream() 是否已接通 |
| R4 | Task 3.3 monorepo 类型引用循环 | 影响 web 构建 | 仅引入 type-only import，不引入运行时代码 |
| R5 | Task 2.2 依赖 FIX-PLAN B-18 | 功能受限 | 可先从内存 Map 读取，B-18 完成后自动增强 |

---

## 七、审查修订记录

| # | 修订内容 | 原因 |
|---|---------|------|
| — | 初始版本 v1 | 基于 2026-04-23 系统审视报告制定 |
| S1 | **Task 1.1 重写**：移除 `new AgentRuntime()` 构造，改用 `agentManager.getAgent()` 复用已有实例 | `AgentRuntimeOptions.config: AgentConfig` 不接受外部 LLMProvider；每次新建 Runtime 性能浪费（初始化 MarkdownMemory/PromptEngine/Compressor） |
| S2 | **Task 1.1 重写**：移除不存在的 `getDefaultAgent()`，改用 `ctx.router` 的 `defaultAgentId` + `agentManager.getAgent()` | AgentManager 无 getDefaultAgent/getDefaultAgentId 方法；默认 Agent 由 index.ts L283/L288 通过 router.setDefaultAgent() 管理 |
| S3 | **Task 2.1 补充前置步骤**：先在 context.ts 构造 HeartbeatRunner 实例 | runtime.ts L182 即使 enabled=true 也赋值 undefined（"待外部注入 CronScheduler 后构造"） |
| S4 | **Task 2.2 修正字段名**：`channelConfig?.credentials` → `channelConfig?.config` | channels Map value 为 `{ id, config, status }`，无 credentials 顶层字段 |
| S5 | **Task 2.2 标注双重响应 bug**：proxyPOST 在 disconnect 失败时会发送 reply，导致后续 return 双重响应 | proxyPOST 错误分支调用 reply.status().send()，handler return 再次触发 Fastify 响应 |
| S6 | **Task 3.1 修正 chatStream 签名**：`chatStream(text, sessionId, opts)` 而非 `chatStream(text, {conversationId, platform})` | 实际签名 chatStream(userMessage: string, sessionId?: string, opts?) |
| S7 | **Task 3.3 方案调整**：不直接依赖 @super-agent/core（Node.js 包），改用手动同步类型文件或独立 shared-types 包 | core 包含 pino/sqlite3 等 Node.js 依赖，直接引入会导致 Next.js 编译报错 |
| S8 | **Task 3.4/3.5 补充初始化步骤**：需在 context.ts 创建 SessionSearchEngine 等实例并扩展 AppContext 接口 | 4 个 Evolution 子模块和 KnowledgeGraph 当前未在 context.ts 初始化 |
| S9 | **Task 3.2 修复**：`ctx.agentManager.getDefaultAgent()` → `ctx.router.getDefaultAgentId()` + `agentManager.getAgent()` | getDefaultAgent() 不存在（与 S2 同源，Task 3.2 遗漏修订） |
| S10 | **Task 3.2 修复**：`getLoadedSkills()` → `listSkills()` | SkillLoader 方法名为 listSkills()（L140-142），无 getLoadedSkills |
| S11 | **Task 1.1 修正返回值处理**：`runtime.chat()` 返回 `{ sessionId, response, toolCalls, attachments }` 非字符串 | typeof response === "string" 永远为 false，应使用 result.response |
| S12 | **Task 1.1 修正 chat() options**：移除不存在的 `{ platform: "a2a" }` | chat() 第三参数为 `{ onStream?, onToolCall?, onToolResult? }`，无 platform 字段 |
| S13 | **Task 2.1 修正 heartbeat 配置获取**：`runtime.config.heartbeat` 不存在 | AgentConfig 无 heartbeat 字段；heartbeatConfig 在 AgentRuntimeOptions 中传入后未公开存储 |

---

## 七-A、审查报告全文

> 审查日期：2026-04-23，审查方式：源码逐行验证

### 发现总览

| 编号 | 严重性 | 影响任务 | 发现 | 修订建议 |
|------|--------|---------|------|----------|
| S1 | **致命** | Task 1.1 | AgentRuntime 构造参数完全错误 | 复用已有 Runtime 而非新建 |
| S2 | **致命** | Task 1.1 | `getDefaultAgent()` 不存在 | 通过 router.defaultAgentId 获取 |
| S3 | **严重** | Task 2.1 | HeartbeatRunner 实例未被构造 | 补充构造步骤 |
| S4 | **严重** | Task 2.2 | channels Map 无 credentials 字段 | 改用 config 字段 |
| S5 | **中等** | Task 2.2 | proxyPOST 双重响应（disconnect 失败时） | Spec 方案已正确规避 |
| S6 | **中等** | Task 3.1 | chatStream() 参数签名不匹配 | 修正为 (msg, sessionId, opts) |
| S7 | **中等** | Task 3.3 | core 包含 Node.js 依赖无法直接引入前端 | 独立 types 文件或 shared 包 |
| S8 | **低** | Task 3.4/3.5 | Evolution 子模块未在 context 初始化 | 补充初始化代码 |

---

### S1+S2（致命）：Task 1.1 构造方式与获取默认 Agent 方式错误

**Spec 原文**：
```typescript
const defaultAgent = ctx.agentManager.getDefaultAgent(); // ❌ 方法不存在
const runtime = new AgentRuntime({                        // ❌ 构造参数错误
  agent: defaultAgent,
  memoryManager: ctx.memoryManager,
  llmProvider: ctx.llmProvider,   // ❌ ctx 无此字段，且 Runtime 不接受外部 Provider
  ...
});
```

**实际源码**：
- `AgentRuntimeOptions` 需要 `config: AgentConfig`，LLMProvider 由 Runtime 内部从 `config.llmProvider` 创建（[runtime.ts L116](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/agent/runtime.ts#L116)）
- `AgentManager` 无 `getDefaultAgent()` 方法，公共方法只有 `getAgent(id)`/`listAgents()`/`createAgent()`
- 默认 Agent ID 存储在 `ctx.router.defaultAgentId`，通过 [index.ts L283/L288](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/api/src/index.ts#L283-L288) 设置
- 每次 A2A 请求新建 Runtime 会初始化 MarkdownMemory、PromptEngine、ContextCompressor 等重量级组件，**性能不可接受**

**修订方案**：
```typescript
onSendMessage: async (req) => {
  // 通过 router 获取默认 Agent 的 Runtime（已缓存在 AgentManager.agents Map 中）
  const defaultAgentId = ctx.router.getDefaultAgentId();
  const runtime = defaultAgentId ? ctx.agentManager.getAgent(defaultAgentId) : undefined;
  if (!runtime) {
    throw new Error("No default agent configured for A2A");
  }
  // 提取文本、构建隔离会话 ID
  const textParts = req.message.parts.filter(p => p.type === "text").map(p => p.text).join("\n");
  const sessionId = `a2a-${crypto.randomUUID()}`;
  // 使用已有 Runtime 的 chat 方法
  // chat() 返回 { sessionId, response, toolCalls, attachments }，options 不含 platform
  const result = await runtime.chat(textParts, sessionId);
  return { type: "message", message: { role: "agent", parts: [{ type: "text", text: result.response }] } };
},
```

**前提**：需确认 `MessageRouter` 是否暴露 `getDefaultAgentId()` 公共方法（源码显示 `defaultAgentId` 是 private 字段，需新增 getter）。

---

### S3（严重）：Task 2.1 HeartbeatRunner 未被构造

**Spec 假设**：`runtime.heartbeatRunner` 已存在，只需在 context.ts 回调中调用 `runOnce()`。

**实际源码** [runtime.ts L180-182](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/agent/runtime.ts#L180-L182)：
```typescript
if (options.heartbeatConfig?.enabled) {
  // CronScheduler 由外部注入，此处仅存储配置，start() 由外部调用
  this.heartbeatRunner = undefined; // ← 永远是 undefined！
}
```

**问题**：HeartbeatRunner 类已完整实现（335 行），但构造函数需要 `CronScheduler` 实例。Runtime 构造时没有 scheduler，所以留了 undefined。外部也没有补充构造步骤。

**修订方案**：Task 2.1 需拆分为两步：
1. **Step A**：在 context.ts 中，默认 Agent 创建后，为其构造 HeartbeatRunner 并注入 execute/deliver 回调
2. **Step B**：将 cronScheduler 的全局心跳回调委托给 HeartbeatRunner

```typescript
// Step A: 构造 HeartbeatRunner（在默认 agent 创建后）
const defaultRuntime = agentManager.getAgent(defaultAgentId);
if (defaultRuntime && defaultRuntime.config.heartbeat?.enabled) {
  const runner = new HeartbeatRunner(
    { ...DEFAULT_HEARTBEAT_CONFIG, ...defaultRuntime.config.heartbeat },
    cronScheduler,
  );
  runner.setExecuteFn(async (msg, ctx, isolated, model) => {
    return await defaultRuntime.chat(msg, isolated ? `hb-${Date.now()}` : undefined);
  });
  defaultRuntime.heartbeatRunner = runner; // 需要 runtime 暴露 setter
  runner.start();
}

// Step B: 全局心跳回调
cronScheduler.setHeartbeatCallback(async (job) => {
  const agentId = job.meta?.agentId || defaultAgentId;
  const agent = agentManager.getAgent(agentId);
  if (!agent?.heartbeatRunner) return "[Heartbeat] skipped";
  return (await agent.heartbeatRunner.runOnce()) ?? "[Heartbeat] OK";
});
```

---

### S4（严重）：Task 2.2 credentials 字段不存在

**Spec 假设**：`channelConfig?.credentials` 用于获取连接凭证。

**实际源码** [channels.ts L17](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/api/src/routes/channels.ts#L17)：
```typescript
const channels = new Map<string, { id: string; config: Record<string, unknown>; status: string }>();
```

凭证信息存储在 `channelConfig.config` 中（不是顶层 `credentials`）。连接时通过 `body?.config?.extra || body?.config || {}` 传入。

**修订**：将 `channelConfig?.credentials` 改为 `channelConfig?.config || {}`。

---

### S6（中等）：Task 3.1 chatStream 参数签名不匹配

**Spec 写法**：`runtime.chatStream(textParts, { conversationId: sessionId, platform: "a2a" })`

**实际签名** [runtime.ts L672-679](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/agent/runtime.ts#L672-L679)：
```typescript
async *chatStream(
  userMessage: string,
  sessionId?: string,
  opts?: { llmOverride?: Record<string, unknown>; signal?: AbortSignal; images?: ... }
)
```

**修订**：改为 `runtime.chatStream(textParts, sessionId)`。`platform` 不是 chatStream 参数，是 Runtime 构造时的选项。对于 A2A 流式请求，platform 信息可通过 Runtime 的 setPlatform() 或构造选项设置。

---

### S7（中等）：Task 3.3 前端类型共享方案不可行

**Spec 假设**：前端可以 `import type { ... } from "@super-agent/core"`。

**实际情况**：
- `packages/web/package.json` 不含 `@super-agent/core` 依赖
- core 包 import 了 pino、better-sqlite3、zod-to-json-schema 等 Node.js 模块
- 即使 type-only import，TypeScript 解析时仍需要 core 的全部依赖链可解析
- Next.js 编译时可能因 Node.js 模块报错

**修订方案（三选一）**：
1. **手动同步**（最低耦合）：在 `packages/web/src/types/api-types.ts` 中手动维护与后端对齐的接口定义，通过代码审查保持同步
2. **共享类型包**：新建 `packages/shared-types/` 纯类型包，无任何运行时依赖，core 和 web 都引用它
3. **脚本生成**：添加 `pnpm gen:types` 脚本，从 core 类型自动生成纯接口文件到 web

推荐方案 2（共享类型包），兼顾类型安全和低耦合。

---

### 耦合度分析

```
Task 1.1 (onSendMessage)  ←─── 共享 A2A→Runtime 桥接逻辑 ───→  Task 3.1 (onStreamMessage)
         │                                                              │
         └── 依赖 router.getDefaultAgentId() ──→ 需新增 getter          │
                                                                        │
Task 2.1 (HeartbeatRunner) ←── 前置：构造 Runner 实例 ──────────────── 独立
         │
         └── 需要 runtime 暴露 heartbeatRunner setter

Task 2.2 (渠道重启) ←── 依赖 FIX-PLAN B-18 (channels 持久化) ────── 可降级

Task 3.3 (类型共享) ←── 需新建 shared-types 包 ─────────────────── 独立

Task 3.4/3.5 (Evolution/KG API) ←── 需扩展 AppContext ──────────── 独立

Task 4.1/4.2 (Router/A2A UI) ──────────────────────────────────── 独立
```

**耦合度评估**：
- **高耦合**：Task 1.1 ↔ Task 3.1（应合并为一个"A2A→Runtime 桥接"子任务）
- **中耦合**：Task 2.1 需要修改 Runtime 类暴露 setter（跨包改动）
- **低耦合**：其余任务可独立执行，互不影响

---

### 回归风险评估

| 任务 | 修改范围 | 影响的现有功能 | 风险等级 |
|------|---------|---------------|----------|
| 1.1 | index.ts 回调 | 无（新增逻辑，原 TODO 无功能） | 🟢 低 |
| 2.1 | context.ts + runtime.ts | CronScheduler 行为链 | 🟡 中 |
| 2.2 | channels.ts 单一端点 | restart 端点（原就是 TODO） | 🟢 低 |
| 2.3 | a2a-client.ts + a2a-push.ts | 重试行为（等价替换） | 🟢 低 |
| 3.1 | index.ts + server.ts | 无（新增可选回调） | 🟢 低 |
| 3.2 | index.ts AgentCard | well-known 端点返回内容 | 🟡 中 |
| 3.3 | web 多文件类型替换 | 前端编译 | 🟡 中 |
| 3.4/3.5 | context.ts + 新路由 | AppContext 接口扩展 | 🟡 中 |
| 4.1 | channels.ts 消息路由 | 消息分发逻辑 | 🟡 中 |
| 4.2 | 纯新建文件 | 无 | 🟢 低 |

**总结**：无高风险项。中风险项集中在 Batch 2（Task 2.1）和 Batch 3（Task 3.3/3.4），需要在实施时逐步验证。

---

### 第二轮审查补充发现（S9-S13）

#### S9（严重）：Task 3.2 仍使用 getDefaultAgent()

S2 修订了 Task 1.1 中的 `getDefaultAgent()` 调用，但 **Task 3.2（AgentCard 动态生成）同样使用了此不存在方法**，属于遗漏。

**修订**：改用 `ctx.router.getDefaultAgentId()` + `ctx.agentManager.getAgent(id)` 模式（与 Task 1.1 一致）。

#### S10（中等）：Task 3.2 getLoadedSkills() 方法名错误

`SkillLoader` 的方法为 `listSkills(): Skill[]`（[loader.ts L140-142](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/skills/loader.ts#L140-L142)），无 `getLoadedSkills()` 方法。

**修订**：`ctx.skillLoader?.getLoadedSkills()` → `ctx.skillLoader?.listSkills()`。

#### S11（中等）：Task 1.1 chat() 返回值处理错误

`runtime.chat()` 返回 `Promise<{ sessionId: string; response: string; toolCalls: string[]; attachments: Attachment[] }>`（[runtime.ts L441-449](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/agent/runtime.ts#L441-L449)），不是字符串。Spec 中 `typeof response === "string"` 永远为 false。

**修订**：改为 `const result = await runtime.chat(...)` 后使用 `result.response`。

#### S12（中等）：Task 1.1 审查报告 chat() options 错误

七-A 节审查报告中的修订方案仍写了 `{ platform: "a2a" }` 作为 chat() 第三参数，但 chat() options 实际为 `{ onStream?, onToolCall?, onToolResult? }`，无 `platform` 字段。

**修订**：移除错误的 options 参数。platform 信息应在 Runtime 构造时通过 `options.platform` 设置。

#### S13（中等）：Task 2.1 heartbeat 配置获取路径错误

`defaultRuntime.config.heartbeat` 不存在 — `AgentConfig` 的字段为 id/name/description/role/goal/backstory/systemPrompt/llmProvider/tools/skills/channels/memoryEnabled/maxToolIterations/metadata（[types/index.ts L12-27](file:///d:/Ruanjian%20Kaifa/qoder/Super%20Lv/super-agent/packages/core/src/types/index.ts#L12-L27)）。心跳配置通过 `AgentRuntimeOptions.heartbeatConfig` 传入，Runtime 构造后未公开存储。

**修订**：改从 `configStore` 或启动配置文件获取心跳配置，而非 `runtime.config.heartbeat`。

---

## 八、附录

### 附录 A：与 FIX-PLAN-2026-04-15.md 交叉引用

| 本 Spec 任务 | FIX-PLAN 相关项 | 关系 |
|-------------|----------------|------|
| I-3 渠道重启 | B-18 Channel 持久化 | **依赖**：I-3 从持久化读取凭证，B-18 负责写入 |
| I-3 渠道重启 | B-19 IM 网关异常隔离 | **独立**：不同层（Node API vs Python Gateway） |
| I-6 类型共享 | B-1/B-2/B-3 字段对齐 | **互补**：B-1~3 修复具体字段值，I-6 建立类型共享机制 |
| I-4 Evolution API | E-2 Evolution Zod | **配合**：I-4 新增端点时直接使用 Zod Schema |
| R-1 retryWithBackoff | A2A 计划 Task 3.3 | **等价**：迁移至本 Spec，原计划标记已迁移 |

### 附录 B：文件变更清单

| 操作 | 文件路径 |
|------|---------|
| 修改 | `packages/api/src/index.ts` |
| 修改 | `packages/api/src/context.ts` |
| 修改 | `packages/api/src/routes/channels.ts` |
| 修改 | `packages/api/src/routes/evolution.ts` |
| 修改 | `packages/core/src/collaboration/a2a-client.ts` |
| 修改 | `packages/core/src/collaboration/a2a-push.ts` |
| 修改 | `packages/web/src/app/collaboration/page.tsx` |
| 修改 | `packages/web/src/app/evolution/page.tsx` |
| 修改 | `packages/web/src/app/memory/page.tsx` |
| 修改 | `packages/web/src/app/security/page.tsx` |
| 新建 | `packages/core/src/collaboration/retry.ts` |
| 新建 | `packages/api/src/routes/knowledge-graph.ts` |
| 新建 | `packages/web/src/types/shared.ts` |
| 新建 | `packages/web/src/app/a2a/page.tsx` |
