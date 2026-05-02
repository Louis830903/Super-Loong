# Super Agent 审核问题修复 Spec

> **依据**: [AUDIT-REPORT-2026-04-24.md](./AUDIT-REPORT-2026-04-24.md)
> **日期**: 2026-04-24（v2 修订于 2026-04-24）
> **范围**: `super-agent/` monorepo 33 条问题全量修复方案
> **原则**: 根本修复，不绕过，不留 TODO；每步可验证

---

## 零、v2 修订说明（对 v1 审查问题的整改）

本文档在 v1 基础上根据源码复核结果修正以下 **13 项**落地隐患，执行者必须以 v2 为准：

| 编号 | 修正类别 | 位置 | 修正要点 |
|------|---------|------|---------|
| E1 | 逻辑错误 | SEC-P0-04 | apiKey 脱敏必须同步修改 `mergeLLMProviderConfig` 加"脱敏哨兵"，否则前端回写会污染 DB |
| E2 | 逻辑错误 | SEC-P0-02 | 强制新 Key 前必须提供 `SA_ENCRYPTION_KEY_LEGACY` 过渡方案，否则旧凭证全部解密失败 |
| E3 | 逻辑错误 | SEC-P0-07 | `/ws` 鉴权须同步改造前端 `useWebSocket.ts`，且默认订阅策略按角色区分 |
| E4 | 逻辑错误 | CORE-P0-08 | `saveDatabase` 必须先改为 `async`，且所有调用点同步改造 |
| E5 | 逻辑错误 | CORE-P1-01 | session lock 正确方案是链式 Promise mutex，原片段仍有 race |
| E6 | 漏修 | SEC-P0-05 | `crypto.randomUUID` 实际有 **13 处**（v1 只列 3 处+1 待查） |
| M1 | 功能孤岛 | SEC-P0-04 | 删除 `models.ts:15-18` 本地 `maskApiKey`，统一用 core 导出 |
| M2 | 功能孤岛 | SEC-P0-03 | 新开关须复用 `securityManager.sandboxLevel`，不新造二值开关 |
| I1 | 低耦合缺陷 | CTR-P1-01 | `packages/core/package.json` 的 `exports` 字段必须声明 `./web-safe-types` 子路径 |
| I2 | 低耦合缺陷 | 跨条目 | `.env.example` 修改点统一放入本文档 **第十章最终完整版** |
| B1 | 破坏性 | CORE-P1-05 | QwenEmbedding 降级不抛错，改分表存储（`embedding_type` 字段） |
| B2 | 破坏性 | SEC-P0-03 | 代码执行默认关闭但内部 `trust_level=system` Agent 走白名单保留 |
| B3 | 破坏性 | CORE-P1-02 | `sqlite.ts` 拆分改为 3 阶段渐进，不再一次拆完 |
| V1 | 依赖缺失 | API-P1-01 | `@fastify/rate-limit` 未安装，需在 D8 执行前置 `pnpm add` |

---

## 一、修复总览

| 等级 | 数量 | 投入 | 周期 |
|------|------|------|------|
| P0 | 8 | ~3.5 人日 | D1-D3 |
| P1 | 15 | ~9 人日 | D4-D11 |
| P2 | 6 | ~4 人日 | D12-D18 |
| P3 | 4 | ~2 人日 | 持续 |

### 修复依赖图（v2）

```
D0(前置): pnpm add @fastify/rate-limit
         + 规划 SA_ENCRYPTION_KEY_LEGACY 兼容期

D1: SEC-P0-01(Key轮换) ──┬── D2: SEC-P0-04(sanitize+哨兵+删重复) ── D3: CTR-P1-03
                         │
D1: SEC-P0-05(13处crypto导入) ─┤
                         │
D2: SEC-P0-06(providers RBAC) ─┐
D2: SEC-P0-07(/ws鉴权+前端WS配套) ─┤
                                 ├── D4: API-P1-01(/test限速)
D3: SEC-P0-02(加密key+LEGACY迁移) ─┤
D3: SEC-P0-03(代码沙箱+sandboxLevel融合) ─┤
D3: CORE-P0-08(saveDatabase改async全链路) ─┘
```

### 前置步骤（D0，本次修订新增）

执行 D1 之前必须完成：

1. 安装新增依赖（对应 V1）：
   ```bash
   pnpm --filter @super-agent/api add @fastify/rate-limit
   ```
2. 盘点当前生产/测试环境使用的加密密钥（对应 E2）：
   - 若当前仅使用默认值 `super-agent-default-encryption-key-v1`，记入 `.env`: `SA_ENCRYPTION_KEY_LEGACY=super-agent-default-encryption-key-v1`
   - 若用户已设置过自定义 `SA_ENCRYPTION_KEY`，记录其旧值用于 LEGACY 过渡
3. 备份数据库 `super-agent/data/super-agent.db` 到 `super-agent.db.bak.pre-v2-fix`

---

## 二、P0 修复 — 第 1 天（安全止损）

### [SEC-P0-01] `.env` 泄露生产 Moonshot API Key 明文

**现状**:
```
super-agent/.env:14  LLM_API_KEY=sk-UVApAlInXxKClUTCLnjwFVQGLKeiRZsF1cbd1mdAgh7YdWb8
super-agent/.env:16  MOONSHOT_API_KEY=sk-UVApAlInXxKClUTCLnjwFVQGLKeiRZsF1cbd1mdAgh7YdWb8
super-agent/.env:19  JWT_SECRET=change-this-to-a-random-string
```

**修复步骤**:

**Step 1**: 在 Moonshot 控制台吊销当前 Key，生成新 Key

**Step 2**: 删除 `.env` 中的真实密钥，替换为占位符
```env
# super-agent/.env (修改后)
LLM_API_KEY=your-moonshot-key-here
MOONSHOT_API_KEY=your-moonshot-key-here
JWT_SECRET=your-32-char-random-string-here
```

**Step 3**: 确认 `.gitignore` 已包含 `.env`（已验证第 10 行已含）
```
super-agent/.gitignore:10  .env
```

**Step 4**: 查历史是否已提交（`git log --all -- .env`），若已提交：
- 方案 A（推荐）: `git filter-repo --path .env --invert-paths` 重写历史
- 方案 B: 若仓库未 push 到公共远端，仅需今后注意

**Step 5**: 在 `.env.example` 添加安全提示
```env
# 在 .env.example 顶部添加：
# ⚠️  安全提示：本文件是模板，请复制为 .env 并填入真实值。
#     .env 已被 .gitignore 排除，确保不要将含密钥的 .env 提交到 Git！
```

**验证**:
1. `grep -r "sk-UVAp" super-agent/` 返回空
2. `.env.example` 中 `MOONSHOT_API_KEY=` 为空占位
3. `.gitignore` 含 `.env` 行

---

### [SEC-P0-05] `crypto.randomUUID()` **13 处**未导入 — Node 18 启动崩溃

**现状**（源码全量扫描结果）:

| 序 | 文件 | 行号 | 调用片段 |
|---|------|------|---------|
| 1 | `packages/api/src/ws/index.ts` | 121 | `const clientId = crypto.randomUUID();` |
| 2 | `packages/api/src/auth/index.ts` | 105 | `` `sk-${crypto.randomUUID().replace(/-/g,"")}` `` |
| 3 | `packages/api/src/middleware/index.ts` | 17 | `crypto.randomUUID()` |
| 4 | `packages/api/src/routes/channels.ts` | 60 | `` `ch_${crypto.randomUUID().slice(0,8)}` `` |
| 5 | `packages/api/src/routes/video.ts` | 138 | `` `vj-${crypto.randomUUID().slice(0,12)}` `` |
| 6 | `packages/api/src/routes/chat.ts` | 125 | `` `conv-${crypto.randomUUID()}` `` |
| 7 | `packages/api/src/routes/chat.ts` | 335 | `` `conv-${crypto.randomUUID()}` `` |
| 8 | `packages/api/src/routes/video-provider-templates.ts` | 101 | `` `tpl_${crypto.randomUUID().slice(0,8)}` `` |
| 9 | `packages/core/src/memory/knowledge-graph.ts` | 76 | `` `rel_${crypto.randomUUID()...}` `` |
| 10 | `packages/core/src/memory/knowledge-graph.ts` | 102 | 同上 |
| 11 | `packages/core/src/memory/manager.ts` | 758 | `` `mem_${crypto.randomUUID()...}` `` |
| 12 | `packages/core/src/media/store.ts` | 111 | `const baseId = crypto.randomUUID();` |
| 13 | `packages/api/src/index.ts` | 183, 212 | `` `a2a-${crypto.randomUUID()}` `` ← 此文件已 `import crypto`，可保留或改统一风格 |

注: Web 端 `web/src/app/chat/page.tsx:419` 为浏览器端 Web Crypto API，**无需修改**。

**修复方案** — 对 12 处 Node 端调用统一改为具名导入 `randomUUID`：

**统一 import 模板**（在每个文件顶部 import 区域添加）：
```typescript
import { randomUUID } from "node:crypto";
```

**替换规则**（每个命中点）：
```diff
- crypto.randomUUID()
+ randomUUID()
```

**逐文件清单**（需要新增 `import { randomUUID } from "node:crypto"` 的 12 个文件）:
1. `packages/api/src/ws/index.ts`
2. `packages/api/src/auth/index.ts`
3. `packages/api/src/middleware/index.ts`
4. `packages/api/src/routes/channels.ts`
5. `packages/api/src/routes/video.ts`
6. `packages/api/src/routes/chat.ts`
7. `packages/api/src/routes/video-provider-templates.ts`
8. `packages/core/src/memory/knowledge-graph.ts`
9. `packages/core/src/memory/manager.ts`
10. `packages/core/src/media/store.ts`
11. `packages/api/src/index.ts`（替换原有 `import crypto from "node:crypto"` 为具名导入，并清理 183/212 调用点）

**验证**:
```bash
# 全项目 Node 端不应再出现 crypto.randomUUID (前缀调用) — 仅保留 web 端
grep -rn "crypto\.randomUUID" super-agent/packages/api super-agent/packages/core   # 应返回空

# 每个修改过的文件都应出现具名导入
grep -rn "from \"node:crypto\"" super-agent/packages/api/src
grep -rn "from \"node:crypto\"" super-agent/packages/core/src/memory
grep -rn "from \"node:crypto\"" super-agent/packages/core/src/media
```

---

## 三、P0 修复 — 第 2 天（API 安全加固）

### [SEC-P0-04] Agent API 全量返回 `apiKey` 明文

**根因分析**:
- `packages/core/src/agent/runtime.ts:190-199` — `get state()` 返回 `config.llmProvider` 含完整 `apiKey`
- `packages/api/src/routes/agents.ts:122,150,159,199,272` — 5 处直接返回 `agent.state` 未脱敏
- `packages/api/src/routes/models.ts:15-18` 已有 `maskApiKey()` 但 agents 路由从未调用

**修复方案** — 双保险：Core 层脱敏 + API 层校验

**Step 1: Core 层添加 `sanitizeState()` 方法**

新建文件: `packages/core/src/agent/sanitize.ts`
```typescript
/**
 * Agent 状态脱敏工具 — 确保 apiKey 不泄露到前端
 *
 * 策略：
 * 1. 深拷贝 AgentState，用 maskApiKey 替换 config.llmProvider.apiKey
 * 2. 零信任原则：即使上层忘了调，此处也保证 apiKey 不出 core
 */

import type { AgentState, AgentConfig } from "../types.js";

/** 脱敏 API Key：保留前 3 后 3 字符，中间用 *** 遮蔽 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 3) + "***..." + key.slice(-3);
}

/** 对单个 AgentState 脱敏，确保 apiKey 不暴露 */
export function sanitizeAgentState(state: AgentState): AgentState {
  const config = { ...state.config } as Record<string, unknown>;
  if (config.llmProvider && typeof config.llmProvider === "object") {
    const llm = { ...config.llmProvider as Record<string, unknown> };
    if (typeof llm.apiKey === "string" && llm.apiKey) {
      llm.apiKey = maskApiKey(llm.apiKey);
    }
    config.llmProvider = llm;
  }
  return {
    ...state,
    config: config as AgentState["config"],
  };
}

/** 对 AgentState 数组批量脱敏 */
export function sanitizeAgentStates(states: AgentState[]): AgentState[] {
  return states.map(sanitizeAgentState);
}
```

**Step 2: agents.ts 路由层调用脱敏 + API 响应层防护**

修改 `packages/api/src/routes/agents.ts`：

```typescript
// 在 import 区域添加（约第 20 行）：
import { sanitizeAgentState, sanitizeAgentStates } from "@super-agent/core/agent/sanitize";

// 或在 core/src/index.ts 统一导出后从 @super-agent/core 导入：
// import { sanitizeAgentState, sanitizeAgentStates } from "@super-agent/core";
```

5 处返回值修改:

1. **Line 122** — `GET /api/agents` 列表:
```typescript
// 旧:
return { agents, total, limit: parsedLimit, offset: parsedOffset };
// 新:
return { agents: sanitizeAgentStates(agents), total, limit: parsedLimit, offset: parsedOffset };
```

2. **Line 150** — `POST /api/agents` 创建:
```typescript
// 旧:
return reply.status(201).send({ agent: agent.state });
// 新:
return reply.status(201).send({ agent: sanitizeAgentState(agent.state) });
```

3. **Line 159** — `GET /api/agents/:id` 详情:
```typescript
// 旧:
return { agent: agent.state };
// 新:
return { agent: sanitizeAgentState(agent.state) };
```

4. **Line 199** — `PUT /api/agents/:id` 更新:
```typescript
// 旧:
return { agent: agent.state };
// 新:
return { agent: sanitizeAgentState(agent.state) };
```

5. **Line 272** — `POST /api/agents/:id/fork`:
```typescript
// 旧:
return reply.status(201).send({ agent: forked.state });
// 新:
return reply.status(201).send({ agent: sanitizeAgentState(forked.state) });
```

**注意**: `agent.state` 用于**审计日志** (`logConfigChange`) 的内部调用仍用 `agent.state` 原文（审计日志需要完整信息），仅 API 响应走 `sanitizeAgentState`。

**Step 3: core/src/index.ts 导出**

确保 `packages/core/src/index.ts` 导出 sanitize 模块：
```typescript
export { sanitizeAgentState, sanitizeAgentStates, maskApiKey } from "./agent/sanitize";
```

**Step 4（v2 新增 · 对应 E1 脱敏哨兵）: 防止前端回写脱敏后的 apiKey 污染 DB**

**根因**: 前端 GET 收到脱敏值 `sk-***...bWb8`，编辑其他字段后整体 PUT 回传。
`packages/api/src/routes/agents.ts:56` 当前逻辑 `(typeof llm.apiKey === "string" && llm.apiKey) || record?.apiKey` 会把脱敏串当作合法值覆盖 DB。

**修复** — 在 `mergeLLMProviderConfig` 中加脱敏哨兵：

```typescript
// packages/api/src/routes/agents.ts 顶部 import 新增：
import { maskApiKey } from "@super-agent/core";

/** 判断给定字符串是否为脱敏形态（sk-***... 或等价形态） */
function isMaskedApiKey(value: string, originalMasked?: string): boolean {
  if (!value) return false;
  // 规则 1：命中通用脱敏 pattern
  if (/\*\*\*\.\.\./.test(value)) return true;
  // 规则 2：精确等于当前 record 的脱敏回显（兜底）
  if (originalMasked && value === originalMasked) return true;
  return false;
}

// 修改 mergeLLMProviderConfig 第 56 行附近：
const recordKeyMasked = record?.apiKey ? maskApiKey(record.apiKey) : undefined;
const incomingApiKey =
  typeof llm.apiKey === "string" && llm.apiKey && !isMaskedApiKey(llm.apiKey, recordKeyMasked)
    ? llm.apiKey
    : undefined;

const merged: Record<string, unknown> = {
  ...
  apiKey: incomingApiKey || record?.apiKey || undefined,
  ...
};
```

**同步修改** `packages/api/src/routes/models.ts` 的 `PUT /api/models/providers/:id`：

```typescript
// 原 body.apiKey 直接写入 providerStore 的逻辑，增加同样判断：
if (typeof body.apiKey === "string" && body.apiKey && !isMaskedApiKey(body.apiKey, recordKeyMasked)) {
  // 真实的新 apiKey，写入
} else {
  // 脱敏串或未提供：保持原值
}
```

**Step 5（v2 新增 · 对应 M1 消除重复 maskApiKey）**

`packages/api/src/routes/models.ts:15-18` 已有本地 `maskApiKey` 实现，与 core 新增的重复。

**操作**:
1. 删除 `models.ts` 第 15-18 行的本地 `function maskApiKey(...)` 定义
2. 在顶部 import 区改为：
   ```typescript
   import { maskApiKey } from "@super-agent/core";
   ```
3. 验证所有旧引用都已指向 core 版本：
   ```bash
   grep -rn "function maskApiKey" super-agent/packages/   # 应只出现在 core/src/agent/sanitize.ts
   grep -rn "maskApiKey" super-agent/packages/api/         # 应全部是 import 或调用，没有本地定义
   ```

**验证**:
```bash
# 单元测试：sanitizeAgentState 后 JSON.stringify 不含 sk- 前缀完整 key
# 集成测试：GET /api/agents 返回值中 apiKey 字段以 sk-*** 结尾
curl -s http://localhost:3001/api/agents | jq '.agents[0].config.llmProvider.apiKey'
# 应输出: "sk-***...bWb8" 而非 "sk-UVApAlInXxKCl..."

# E1 回归测试：PUT 回传脱敏后的 apiKey 不应覆盖 DB
# 1. GET 某 agent -> 拿到 "sk-***...bWb8"
# 2. 仅改 name，带回完整 config 发 PUT
# 3. 再 GET，验证 apiKey 依然是原始真实 key（用 LLM 调用成功证明）
```

---

### [SEC-P0-06] `PUT /api/models/providers/:id` 无 RBAC 鉴权

**现状**:
- `packages/api/src/routes/models.ts:52-124` —路由注册无 `preHandler`
- 同项目 `/api/ws/broadcast` 和 `/api/auth/keys` 已正确使用 `preHandler: requirePermission("*")`

**修复方案**:

修改 `packages/api/src/routes/models.ts`:

```typescript
// 在 import 区域添加：
import { requirePermission } from "../auth/index.js";

// 第 52 行路由注册改为（添加 preHandler）：
app.put<{ Params: { id: string }; Body: { ... } }>(
  "/api/models/providers/:id",
  { preHandler: requirePermission("*") },  // ← 新增 RBAC
  async (request, reply) => {
    // ... 原有逻辑不变
  }
);
```

同时检查同文件其他需要 RBAC 的端点：

**补充加固1** — `DELETE /api/models/providers/:id/key` (line 127):
```typescript
app.delete<{ Params: { id: string } }>(
  "/api/models/providers/:id/key",
  { preHandler: requirePermission("*") },  // ← 新增
  async (request, reply) => { ... }
);
```

**补充加固2** — 审计日志增强（line 71-76）:
```typescript
// 在 logConfigChange 调用中增加变更前后 baseUrl 记录（当前只记录了变更后）
logConfigChange("config.provider.upsert", {
  providerId: id,
  selectedModel: body.selectedModel,
  baseUrl: body.baseUrl,
  previousBaseUrl: record?.baseUrl,  // 新增：变更前 baseUrl 用于审计
  isEnabled: body.isEnabled,
  keyChanged: body.apiKey !== undefined,
});
```

**验证**:
```bash
# 无 token 请求应返回 401
curl -s -o /dev/null -w "%{http_code}" -X PUT http://localhost:3001/api/models/providers/openai \
  -H "Content-Type: application/json" -d '{"apiKey":"test"}'
# 期望: 401

# 有效 token 请求应返回 200
curl -s -o /dev/null -w "%{http_code}" -X PUT http://localhost:3001/api/models/providers/openai \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <valid-jwt>" \
  -d '{"isEnabled":true}'
# 期望: 200
```

---

### [SEC-P0-07] `GET /ws` 无鉴权 + 无连接上限

**现状**:
- `packages/api/src/ws/index.ts:120-186` — `/ws` 端点无任何鉴权
- `clients` Map 无大小上限（line 93）
- 同文件 `/ws/gateway` (line 249-395) 已正确实现 Bearer token 鉴权 — 可作为参考

**修复方案** — 复用 `/ws/gateway` 的鉴权模式：

**Step 1**: 添加 JWT 鉴权

修改 `packages/api/src/ws/index.ts` 第 120 行 handler：

```typescript
app.get("/ws", { websocket: true }, (socket: WebSocket, request) => {
  // ── P0-FIX: JWT 鉴权 ──
  // 从 URL query 或 Authorization header 提取 token
  const url = new URL(request.url ?? "/", `http://${request.headers.host || "localhost"}`);
  const tokenFromQuery = url.searchParams.get("token");
  const authHeader = request.headers["authorization"] || "";
  const tokenFromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const token = tokenFromQuery || tokenFromHeader;

  if (!token) {
    app.log.warn("WebSocket connection rejected: no token");
    send(socket, { type: "error", error: "Unauthorized: missing authentication token" });
    socket.close(4001, "Unauthorized");
    return;
  }

  // JWT 验证（使用 Fastify 实例上注册的 jwt 插件）
  try {
    const decoded = (app as any).jwt.verify(token);
    if (!decoded) {
      socket.close(4001, "Unauthorized");
      return;
    }
  } catch {
    app.log.warn("WebSocket connection rejected: invalid JWT");
    send(socket, { type: "error", error: "Unauthorized: invalid token" });
    socket.close(4001, "Unauthorized");
    return;
  }

  // ── P0-FIX: 连接上限检查 ──
  const MAX_WS_CLIENTS = parseInt(process.env.MAX_WS_CLIENTS ?? "500", 10);
  if (clients.size >= MAX_WS_CLIENTS) {
    app.log.warn({ total: clients.size, max: MAX_WS_CLIENTS }, "WebSocket connection refused: max clients reached");
    send(socket, { type: "error", error: "Service temporarily unavailable: too many connections" });
    socket.close(1013, "Too many connections");
    return;
  }

  // 原有逻辑继续...
  const clientId = randomUUID();  // 注意：此处已改为具名导入
  const client: WsClient = { ... };
  clients.set(clientId, client);
  // ...
});
```

**Step 2**: 默认 topic 限制 + 按角色区分（v2 修订 · 对应 E3 避免破坏前端）

**问题**: v1 直接把默认 `topics` 改为空 Set 会导致前端静默断流。此处改为"按 JWT role 决定默认订阅"：

```typescript
// 第 125 行修改:
// 旧:
topics: new Set(["*"]),
// 新:
const roleFromJwt = (decoded as { role?: string } | null)?.role ?? "viewer";
// admin/operator 保留 "*" 保证 dashboard 兼容，viewer/agent 需显式 subscribe
topics: new Set<string>(
  roleFromJwt === "admin" || roleFromJwt === "operator" ? ["*"] : []
),
```

**Step 3（v2 新增 · 对应 E3 前端配套改造）**

当前前端代码未随 `/ws` 鉴权同步更新，必须一起修改否则 dashboard 全面失联。

**涉及文件**:

| 文件 | 行号 | 当前状态 | 修改 |
|------|------|---------|------|
| `packages/web/src/hooks/useWebSocket.ts` | 113-114 | `new WebSocket(\`${WS_BASE}/ws\`)` 未带 token | 必须携带 token |
| `packages/web/src/app/dashboard/traces-panel.tsx` | 73 | `new EventSource(\`${API_BASE}/api/traces/live\`)` | 见 WEB-P1-02（需带 Authorization） |
| `packages/web/src/app/collaboration/page.tsx` | 411-412 | `new EventSource(url)` | 见 WEB-P1-02 |

**修改 `useWebSocket.ts`**:

```typescript
// 旧（line 113-114）:
const ws = new WebSocket(`${WS_BASE}/ws`);

// 新:
function getAuthToken(): string {
  // 与 apiFetch 统一从同一来源取 token（cookie / localStorage 二选一，依现有实现）
  if (typeof window === "undefined") return "";
  return localStorage.getItem("sa_token") || "";
}

const token = getAuthToken();
if (!token) {
  // 未登录不建立连接，避免 4001 刷日志
  console.warn("[useWebSocket] no auth token, skip connect");
  return;
}
const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
```

**关闭码处理**:

```typescript
// onclose 中增加 4001 识别：
ws.onclose = (evt) => {
  if (evt.code === 4001) {
    // token 失效，触发登录态刷新或跳登录页
    window.dispatchEvent(new CustomEvent("sa:auth-expired"));
    return;
  }
  // 其他走原有重连逻辑...
};
```

**显式订阅**（配合后端 viewer/agent 默认空 topic）:

```typescript
ws.onopen = () => {
  // 保持原有 onOpen 调用
  // 对 viewer/agent 角色，显式 subscribe 当前页面关心的主题
  ws.send(JSON.stringify({ type: "subscribe", topics: ["agent:*", "session:*"] }));
};
```

**Step 4**: 添加 `.env.example` 新变量（见第十章汇总）

**验证**:
```bash
# 无 token 连接应被拒绝
wscat -c ws://localhost:3001/ws  # 应立即被关闭，code=4001

# 有效 token 连接应成功
wscat -c "ws://localhost:3001/ws?token=<valid-jwt>"  # 应收到 { type: "connected", ... }
```

---

## 四、P0 修复 — 第 3 天（核心安全与稳定性）

### [SEC-P0-02] 加密 Key 硬编码默认值

**现状**（2 处）:

`packages/core/src/llm/provider-store.ts:32-35`:
```ts
const SA_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY;
const ENCRYPTION_KEY = createHash("sha256")
  .update(SA_KEY_FROM_ENV ?? "super-agent-default-encryption-key-v1")
  .digest();
```

`packages/core/src/tools/config-store.ts:18-21`:
```ts
const SA_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY;
const ENCRYPTION_KEY = createHash("sha256")
  .update(SA_KEY_FROM_ENV ?? "super-agent-default-encryption-key-v1")
  .digest();
```

**修复方案** — 强制校验 + 共享提取 + **LEGACY 过渡期**（v2 修订 · 对应 E2）:

**核心原则**:
- 旧 DB 中的凭证已用旧 key 加密，不能一次性切换到新 key，否则整个 providerStore 解密全部失败
- 引入 `SA_ENCRYPTION_KEY_LEGACY` 承载旧 key（默认值或用户自定义的旧 key）
- 解密时先试新 key，失败 fallback 到 legacy，成功后**自动用新 key 重写** → 完成一次 `scheduleSave()` 后 LEGACY 可删除

**Step 1**: 提取公共加密 key 管理模块（含 LEGACY 支持）

新建 `packages/core/src/security/encryption-key.ts`:
```typescript
/**
 * 加密密钥管理 — 统一管理 AES-256-CBC 加密密钥的派生、校验与迁移
 *
 * 策略：
 * - 从 SA_ENCRYPTION_KEY 环境变量派生 SHA-256 新密钥（强制 ≥32 字符）
 * - 同时读取 SA_ENCRYPTION_KEY_LEGACY（可选），用于过渡期解密旧数据
 * - 提供 decryptWithFallback 实现"先新后旧，自动重加密"
 */

import { createHash } from "crypto";

const SA_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY;
const SA_LEGACY_KEY_FROM_ENV = process.env.SA_ENCRYPTION_KEY_LEGACY;

/** 是否为安全密钥（≥32 字符 + 非已知默认值） */
function isWeakKey(key: string): boolean {
  if (key.length < 32) return true;
  if (key === "super-agent-default-encryption-key-v1") return true;
  return false;
}

/**
 * 获取当前加密密钥（用于新写入）。
 * 若 SA_ENCRYPTION_KEY 未设置或为弱密钥，抛出错误阻止启动。
 */
export function getEncryptionKey(): Buffer {
  if (!SA_KEY_FROM_ENV) {
    throw new Error(
      "[SECURITY] SA_ENCRYPTION_KEY 环境变量未设置！\n" +
      "  此密钥用于加密数据库中存储的 LLM API Key。\n" +
      "  生成强密钥: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"\n" +
      "  然后将输出写入 .env: SA_ENCRYPTION_KEY=<生成的密钥>"
    );
  }
  if (isWeakKey(SA_KEY_FROM_ENV)) {
    throw new Error(
      "[SECURITY] SA_ENCRYPTION_KEY 使用了弱密钥！请使用 ≥32 字符的随机密钥替换之。"
    );
  }
  return createHash("sha256").update(SA_KEY_FROM_ENV).digest();
}

/** 获取 LEGACY 旧密钥（可选，用于解密历史数据）。未设置则返回 undefined。 */
export function getLegacyEncryptionKey(): Buffer | undefined {
  if (!SA_LEGACY_KEY_FROM_ENV) return undefined;
  return createHash("sha256").update(SA_LEGACY_KEY_FROM_ENV).digest();
}

/**
 * 使用新 key 解密，失败时 fallback 到 legacy key。
 * @param decryptFn 实际执行解密的函数（由 provider-store / config-store 各自实现 AES 流程）
 * @returns { plaintext, usedLegacy } usedLegacy=true 时调用方应立即用新 key 重加密写回
 */
export function decryptWithFallback<T>(
  decryptFn: (key: Buffer) => T,
): { plaintext: T; usedLegacy: boolean } {
  try {
    return { plaintext: decryptFn(getEncryptionKey()), usedLegacy: false };
  } catch (err) {
    const legacy = getLegacyEncryptionKey();
    if (!legacy) throw err;
    return { plaintext: decryptFn(legacy), usedLegacy: true };
  }
}
```

**Step 2**: 修改 `provider-store.ts` — 使用 fallback + 自动重加密

```typescript
// 旧 decrypt 函数单一 key：
function decrypt(ciphertext: string): string { ... uses ENCRYPTION_KEY ... }

// 新：
import { getEncryptionKey, decryptWithFallback } from "../security/encryption-key.js";

function decryptRaw(ciphertext: string, key: Buffer): string {
  // 原有 AES-256-CBC 解密流程，key 改为参数
  const iv = Buffer.from(ciphertext.slice(0, 32), "hex");
  const data = Buffer.from(ciphertext.slice(32), "hex");
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function decrypt(ciphertext: string): { plain: string; needRewrite: boolean } {
  const { plaintext, usedLegacy } = decryptWithFallback((key) => decryptRaw(ciphertext, key));
  return { plain: plaintext, needRewrite: usedLegacy };
}

// providerStore.get / list 的加载逻辑：
const { plain, needRewrite } = decrypt(record.encryptedApiKey);
if (needRewrite) {
  // 用新 key 重新加密并更新 DB（仅一次）
  record.encryptedApiKey = encrypt(plain);  // encrypt 用 getEncryptionKey()
  saveProviderRecord(record);
  logger.info({ providerId: record.id }, "[migration] re-encrypted with new SA_ENCRYPTION_KEY");
}
```

**Step 3**: 修改 `config-store.ts` — 同样应用 fallback 模式（代码模板同上）

**Step 4**: 完成重加密后清理 LEGACY

在 `.env.example` 注释明确说明：
```env
# 仅在升级期短暂使用：填入之前的旧 SA_ENCRYPTION_KEY
# 完成首次启动（日志出现 [migration] re-encrypted 且 providerStore 全部重写后），可删除此行
# SA_ENCRYPTION_KEY_LEGACY=
```

**Step 5**: 更新 `.env.example` 见第十章汇总

**验证**:
```bash
# 未设置 SA_ENCRYPTION_KEY 时启动应崩溃并打印错误信息（而非 warning 后继续）
SA_ENCRYPTION_KEY="" pnpm dev  # 应 crash: "SA_ENCRYPTION_KEY 环境变量未设置！"

# 设置后正常启动
SA_ENCRYPTION_KEY=... pnpm dev  # 应正常启动
```

---

### [SEC-P0-03] 代码执行工具无沙箱隔离

**现状**:
- `packages/core/src/tools/code-exec.ts:28` — `spawn(cmd, args, ...)` 直接以宿主进程权限运行
- `agent/runtime.ts:1174` 有 `sandboxLevel` 分层但 `code-exec.ts` 不感知

**修复方案** — 三级推进（v2 修订 · 对应 M2/B2 融合现有 sandboxLevel + 白名单保留系统级 Agent）：

**核心原则**:
- **复用** `packages/core/src/agent/runtime.ts:1174` 已有的 `securityManager.sandboxLevel`（none/process/docker），不新造二值开关
- 环境变量 `SUPER_AGENT_CODE_EXEC_ENABLED` 仅作为**初始化 sandboxLevel 的一个来源**
- `trust_level=system` 的内置 Agent（ResearchCrew / DataAnalyst 等）走白名单，不受开关影响，避免破坏开箱即用体验

**短期（立即，本次 Spec）** — 默认关闭用户级 + 保留系统级 Agent：

修改 `packages/core/src/tools/code-exec.ts`:

```typescript
// 在文件顶部 import 区域添加：
import { getSecurityManager } from "../agent/security-manager.js";  // 具体路径依现有结构

/**
 * 代码执行安全控制（v2 · 复用 sandboxLevel 体系）
 *
 * 判定流程：
 *   1. 查询 securityManager 当前 agent 的 sandboxLevel
 *      - "none"   → 禁止
 *      - "process"→ 宿主进程 spawn（现有行为）
 *      - "docker" → 进入容器（Phase 2 实现）
 *   2. 若 sandboxLevel === "none" 且 agent.trustLevel === "system"
 *      → 白名单通过（内置可信 Agent 仍可调用）
 *   3. 环境变量 SUPER_AGENT_CODE_EXEC_ENABLED=true 等价于把用户级默认
 *      sandboxLevel 从 "none" 提升到 "process"（由 securityManager 读取）
 */

interface ExecGuardContext {
  agentId?: string;
  trustLevel?: "system" | "user";  // 由调用方（runtime）传入
}

async function executeCode(
  cmd: string, args: string[], ctx: ExecGuardContext = {}, timeout = 30000,
): Promise<ToolResult> {
  const sm = getSecurityManager();
  const level = sm.getSandboxLevel(ctx.agentId);

  // 白名单：系统级 Agent 始终允许（ResearchCrew / DataAnalyst / VideoCrew 等）
  const isSystemTrust = ctx.trustLevel === "system";

  if (level === "none" && !isSystemTrust) {
    return {
      success: false,
      output: "",
      error:
        "代码执行已禁用（sandboxLevel=none）。\n" +
        "- 管理员可在运行时通过 securityManager.setSandboxLevel(\"process\") 开启；\n" +
        "- 或设置 SUPER_AGENT_CODE_EXEC_ENABLED=true 后重启（默认升级为 process 级）。\n" +
        "- 仅限可信环境使用。",
    };
  }

  if (level === "docker") {
    // Phase 2：docker 沙箱执行（占位）
    return runInDockerSandbox(cmd, args, timeout);
  }

  // process 级或白名单：走原有 spawn 逻辑
  return runInProcess(cmd, args, timeout);
}
```

**修改 `runtime.ts` 工具调用位置** — 传递 `trustLevel` 给 `executeCode`:

```typescript
// 在 agent 执行 run_python/run_javascript/run_shell 工具时：
const trustLevel = this.config.trustLevel ?? (this.config.isBuiltin ? "system" : "user");
await executeCode(cmd, args, { agentId: this.id, trustLevel }, timeout);
```

**扩展 securityManager 初始化**（对齐 SUPER_AGENT_CODE_EXEC_ENABLED）:

```typescript
// packages/core/src/agent/security-manager.ts（或现有位置）
function resolveDefaultSandboxLevel(): "none" | "process" | "docker" {
  if (process.env.SUPER_AGENT_SANDBOX_LEVEL) {
    return process.env.SUPER_AGENT_SANDBOX_LEVEL as "none" | "process" | "docker";
  }
  // 兼容旧开关：true → process；未设置 → none
  if (process.env.SUPER_AGENT_CODE_EXEC_ENABLED === "true") return "process";
  return "none";
}
```

在 3 个 tool 的 description 中添加安全提示:
```typescript
// run_python / run_javascript / run_shell 的 description 末尾添加:
// + "\n⚠️ 安全提示：此工具受 securityManager.sandboxLevel 控制，用户自定义 Agent 默认 \"none\"。
//    管理员可设置 SUPER_AGENT_CODE_EXEC_ENABLED=true 或 SUPER_AGENT_SANDBOX_LEVEL=process 开启。
//    内置系统级 Agent 不受此限制。"
```

**中期（Phase 2）** — Docker 沙箱:

在 `packages/core/src/tools/` 下新增 `sandbox-docker.ts`:
```typescript
// 使用 docker run --network=none --read-only --rm 执行代码
// 挂载临时 volume 用于文件写入
// 内存限制 --memory=256m，CPU 限制 --cpus=1
```

**长期（Phase 3）** — Firecracker microVM 或 gVisor:

作为可选赛道，根据生产需求评估。

`.env.example` 见第十章汇总（新增 `SUPER_AGENT_CODE_EXEC_ENABLED`、`SUPER_AGENT_SANDBOX_LEVEL` 两项）。

**验证**:
```bash
# 默认状态 + 用户自定义 Agent：调用 run_shell 应返回"已禁用"错误
# 默认状态 + 系统级 Agent（如 ResearchCrew）：run_shell 应正常执行（白名单）
# SUPER_AGENT_CODE_EXEC_ENABLED=true：所有 Agent 正常执行
# SUPER_AGENT_SANDBOX_LEVEL=docker：走 docker 分支（Phase 2 后可用）
```

---

### [CORE-P0-08] `Atomics.wait` 同步阻塞事件循环

**现状**:
- `packages/core/src/persistence/sqlite.ts:1089` — `export function saveDatabase(): void` **同步函数**
- `packages/core/src/persistence/sqlite.ts:1135-1138` — 用 `Atomics.wait` 阻塞主线程

```ts
const sharedBuf = new SharedArrayBuffer(4);
const sharedArr = new Int32Array(sharedBuf);
Atomics.wait(sharedArr, 0, 0, Math.round(jitter));
```

**修复方案** — 改为真实异步（v2 修订 · 对应 E4 类型不兼容）:

**前置事实**: `saveDatabase` 当前签名是 `(): void`，内部循环里不能直接 `await`。必须先把函数本体改为 async，**并同步更新所有调用点**。

**Step 1**: 改签名 `saveDatabase`（`sqlite.ts:1089`）

```typescript
// 旧:
export function saveDatabase(): void {

// 新:
export async function saveDatabase(): Promise<void> {
```

**Step 2**: 替换 Atomics.wait 段落

```typescript
// 旧代码（line 1133-1138）：
const jitter = INITIAL_RETRY_MS + Math.random() * (MAX_RETRY_MS - INITIAL_RETRY_MS);
logger.warn({ attempt, jitter: Math.round(jitter) }, "saveDatabase retry after I/O error");
const sharedBuf = new SharedArrayBuffer(4);
const sharedArr = new Int32Array(sharedBuf);
Atomics.wait(sharedArr, 0, 0, Math.round(jitter));

// 新代码：
const jitter = INITIAL_RETRY_MS + Math.random() * (MAX_RETRY_MS - INITIAL_RETRY_MS);
logger.warn({ attempt, jitter: Math.round(jitter) }, "saveDatabase retry after I/O error");
// 改为真正异步延时，不阻塞事件循环
await new Promise<void>((resolve) => setTimeout(resolve, Math.round(jitter)));
```

**Step 3**: 提供同步兜底变体 `saveDatabaseSync`（用于 `beforeExit` 钩子）

```typescript
/**
 * 同步保存（仅用于进程退出钩子，不做重试）。
 * 退出时不能 await，只能一次性尝试写入。
 */
export function saveDatabaseSync(): void {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(_dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(_dbPath, buffer);
  } catch (err) {
    logger.error({ err }, "[saveDatabaseSync] write failed during exit hook");
  }
}
```

**Step 4**: 更新所有调用点（必须一并修改，否则 async void 调用会吞异常）

逐一检查：

```bash
grep -rn "saveDatabase()" super-agent/packages/ --include="*.ts"
```

**常见调用点改造模板**:

| 调用位置 | 改造方式 |
|---------|---------|
| `scheduleSave` 的 setTimeout 回调 | `setTimeout(() => { saveDatabase().catch(err => logger.error({err}, "scheduleSave failed")); }, delayMs)` |
| runtime 内 `persistState` 等函数 | 把外层函数也改为 async，前面加 `await` |
| `process.on("beforeExit")` | 改为 `saveDatabaseSync()`（不能 await） |
| `process.on("SIGTERM")` | `await saveDatabase()` 若处于 async handler；否则用 `saveDatabaseSync()` |
| CLI 脚本（`scripts/**`） | 顶层 `await` 或包 `void (async () => { await saveDatabase(); })()` |

**Step 5**: 更新 `packages/core/src/index.ts` 导出

```typescript
// 若对外暴露，同时导出同步变体
export { saveDatabase, saveDatabaseSync, scheduleSave } from "./persistence/sqlite.js";
```

**验证**:
```bash
# 类型检查必过
pnpm --filter @super-agent/core tsc --noEmit

# 全局扫描确认没有"同步调用 saveDatabase 但丢失 await"的写法
grep -rn "saveDatabase()" super-agent/packages/ --include="*.ts" | grep -v "await\|\.catch\|saveDatabaseSync"
# 应为空（除了定义处）

# 压测：saveDatabase 重试期间 HTTP 请求应正常响应（不被阻塞）
wrk -t4 -c50 -d30s http://localhost:3001/health &
# 同时触发 DB 写入重试（人工 chmod -w 数据库文件触发 I/O 失败）
```

---

## 五、P1 修复 — 第 4-7 天（核心功能加固）

### 5.1 并发与存储（~3 人日）

#### [CORE-P1-01] Session Lock 非原子操作

**文件**: `packages/core/src/agent/runtime.ts:398-435`
**问题**: `acquireSessionLock()` + `createSessionLock()` 分两步，中间存在 race window
**修复方案**（v2 修订 · 对应 E5）: **链式 Promise mutex** — 唯一能避免 race 的正确模式

**根因**: 简单的 `get` + `set` 两步操作，无论怎么改都存在"两个请求同 tick 都看见 undefined，都进入创建分支，后写覆盖先写"的竞态。唯一稳健的方案是**把同一 sessionId 的所有请求串成 Promise 链**，无条件排队。

```typescript
/**
 * Session 级互斥锁 — 链式 Promise mutex
 *
 * 原理:
 *   每个 sessionId 映射到一个 "tail Promise"
 *   新请求: prev = tail ?? resolve;  next = new Promise;  tail = prev.then(() => next)
 *   然后 await prev，拿到 release 函数
 *   无论多少个并发请求，都被串成一条链依次执行，无 race
 *
 * 清理:
 *   release 时若当前 tail 仍指向自己则 delete，防止内存泄漏
 */
private _sessionLocks = new Map<string, Promise<void>>();

async acquireSessionLock(sessionId: string): Promise<() => void> {
  const prev = this._sessionLocks.get(sessionId) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  // 原子：在同步同一个 tick 内把 tail 替换为"prev 完成后接着 next"
  // 后续请求读到的就是这个组合 Promise，排在 next 之后
  const newTail = prev.then(() => next);
  this._sessionLocks.set(sessionId, newTail);

  // 可选超时保护：防止前一把锁泄漏导致永远排队
  const TIMEOUT_MS = 60_000;
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error(`session lock wait timeout: ${sessionId}`)), TIMEOUT_MS),
  );
  await Promise.race([prev, timeoutPromise]);

  return () => {
    release();
    // 仅当自己仍是 tail 时才 delete（否则会误删后续请求的锁）
    if (this._sessionLocks.get(sessionId) === newTail) {
      this._sessionLocks.delete(sessionId);
    }
  };
}
```

**调用方改造**（原两步 acquire + create 改为一次 acquire）:

```typescript
// 旧:
// const existing = this.acquireSessionLock(sessionId);
// if (!existing) this.createSessionLock(sessionId);
// ... 业务 ...
// this.releaseSessionLock(sessionId);

// 新:
const release = await this.acquireSessionLock(sessionId);
try {
  // ... 业务逻辑 ...
} finally {
  release();
}
```

**验证**:
```typescript
// 单元测试：对同一 sessionId 并发 10 个请求，每个 sleep 50ms
// 期望：总耗时 ≈ 10 × 50ms = 500ms（串行），而非 50ms（并发）
// 期望：每个请求看到的状态是前一个请求的完整输出（无交叉写入）
```

#### [CORE-P1-02] sqlite.ts 2972 行上帝文件

**文件**: `packages/core/src/persistence/sqlite.ts`
**问题**: 混 agent/conv/credentials/memory/FTS5/video_jobs 等 15+ 领域
**修复方案（v2 修订 · 对应 B3 降级为渐进式 3 阶段）**：
**一次性拆分风险过高（事务边界错乱、回归面太大），本项从 P1 紧急窗口移出，改为跨 sprint 渐进推进**。

**阶段 A**（D6-D7，P1 窗口内）— 仅抽 connection：
```
packages/core/src/persistence/
├── sqlite.ts                  # 保留（暂不删）
└── sqlite/
    └── connection.ts          # 新建：init / getDb / saveDatabase / saveDatabaseSync / scheduleSave / 事务工具
```
老 `sqlite.ts` 顶部 re-export `connection.ts`，保持外部 import 路径不变。

**阶段 B**（后续 sprint，每周一个领域）— 逐个抽 repo：
```
packages/core/src/persistence/sqlite/
├── connection.ts
├── agent-repo.ts          # Week 2: Agent CRUD
├── conversation-repo.ts   # Week 3: 对话记录
├── credential-repo.ts     # Week 4: 加密凭证
├── memory-repo.ts         # Week 5: 记忆 + FTS5
├── video-job-repo.ts      # Week 6: 视频任务
└── index.ts               # 统一导出
```
每抽一个领域，老 `sqlite.ts` 内对应函数保留为 deprecated shim（`/** @deprecated use xxx-repo */ export * from "./sqlite/xxx-repo.js"`），给外部调用者过渡期。

**阶段 C**（所有领域抽完 + 两周稳定期）— 删除老 sqlite.ts

**拆分约束**:
1. 各 repo 文件接收 `Database` 实例作为构造函数参数（依赖注入），不直接 import 全局 `getDb()`
2. 跨 repo 事务必须由 `connection.ts` 的 `runInTransaction(fn)` 统一管理，不得在 repo 内直接 `BEGIN`
3. 每抽一个领域，必须同时补对应领域的单元测试（覆盖率 ≥70%）

**回滚方案**: 若任一阶段触发生产 bug，revert 对应 commit；因 shim 保留，外部调用方无需同步回滚。

#### [CORE-P1-03] Anthropic provider 静默返回不兼容端点

**文件**: `packages/core/src/llm/provider.ts:75-86`
**问题**: 构造 Anthropic provider 时返回 warning 但不 throw，运行时才暴露
**修复**:

```typescript
// 旧: 仅 warn
logger.warn("Anthropic baseUrl 与 OpenAI 格式不兼容...");

// 新: 直接 throw，阻止创建不兼容 provider
throw new Error(
  "Anthropic provider 不支持 OpenAI 兼容的 baseUrl 配置。" +
  "请使用 Anthropic 原生 SDK（ANTHROPIC_API_KEY）或选择 OpenAI 兼容 provider。"
);
```

#### [CORE-P1-04] `model: "default"` 无兜底校验

**文件**: `packages/core/src/collaboration/video-crew-presets.ts:78-81`
**问题**: `llmProvider.model = "default"` 为占位符，运行时无替换则失败
**修复**:

```typescript
// 在 crew 构造入口处（api/routes/video.ts 或 core/runtime 启动时）
// 添加 model 校验：
function validateModelConfig(model: string): void {
  if (!model || model === "default") {
    throw new Error(
      `视频工作室 Agent 未配置有效模型（当前为 "${model}"）。` +
      "请在设置页为 LLM Provider 选择模型后再启动视频任务。"
    );
  }
}
```

#### [CORE-P1-05] QwenEmbedding 降级污染同表

**文件**: `packages/core/src/memory/manager.ts`
**问题**: QwenEmbedding 熔断降级到 SimpleEmbedding（2048 维假向量），与真实 1536 维向量混存同表
**修复方案（v2 修订 · 对应 B1 不抛错改为分表）**:

**原因**: v1 的"直接抛错"会让 DASHSCOPE 抖动时整个记忆系统瘫痪，破坏用户体验。正确方案是**分表存储，读时统一归并**。

**Step 1**: 数据库 schema 新增字段

```sql
-- 在 memory_entries 表上加 embedding_type 字段（迁移脚本）
ALTER TABLE memory_entries ADD COLUMN embedding_type TEXT NOT NULL DEFAULT 'qwen';
-- 同时加 embedding_dim 记录维度
ALTER TABLE memory_entries ADD COLUMN embedding_dim INTEGER NOT NULL DEFAULT 1536;

-- 未来切换 provider 时按此字段筛选
CREATE INDEX idx_memory_embedding_type ON memory_entries(embedding_type);
```

**Step 2**: 写入时按 embedding provider 打标签

```typescript
// packages/core/src/memory/manager.ts
async writeMemory(entry: MemoryEntry): Promise<void> {
  let embedding: number[];
  let embeddingType: "qwen" | "simple" | "openai" = "qwen";
  let embeddingDim = 1536;

  try {
    embedding = await qwenEmbedding.embed(entry.text);
    embeddingDim = embedding.length;
  } catch (err) {
    logger.warn({ err }, "[memory] QwenEmbedding failed, fallback to SimpleEmbedding");
    embedding = simpleEmbedding.embed(entry.text);   // 2048 维
    embeddingType = "simple";
    embeddingDim = embedding.length;
    // 告警 + 指标上报，方便运维排查
    metrics.increment("memory.embedding.fallback", { to: "simple" });
  }

  await memoryRepo.insert({
    ...entry,
    embedding: Buffer.from(new Float32Array(embedding).buffer),
    embeddingType,
    embeddingDim,
  });
}
```

**Step 3**: 检索时按 provider 隔离，避免混算余弦距离

```typescript
// 查询只拉与当前 provider 相同 type 的向量
async searchMemory(queryText: string, topK = 10): Promise<MemoryEntry[]> {
  let currentType: "qwen" | "simple" | "openai";
  let queryEmbedding: number[];

  try {
    queryEmbedding = await qwenEmbedding.embed(queryText);
    currentType = "qwen";
  } catch {
    queryEmbedding = simpleEmbedding.embed(queryText);
    currentType = "simple";
  }

  // 关键：仅对比同一 embedding_type 的条目
  const candidates = await memoryRepo.listByType(currentType);
  return cosineTopK(queryEmbedding, candidates, topK);
}
```

**Step 4**: 提供后台任务重算旧向量（可选）

当 Qwen 恢复后，可启动后台 job 将 `embedding_type='simple'` 的条目重新用 Qwen embed 并更新为 `'qwen'`。

**验证**:
```bash
# Qwen 正常时：新写入的 memory 记录 embedding_type='qwen', embedding_dim=1536
# Qwen 宕机时：新写入的 memory 记录 embedding_type='simple', embedding_dim=2048
# 检索：两种记录不会互相干扰，搜索结果来自同一类型
```

---

### 5.2 前后端契约双源漂移（~2 人日）

#### [CTR-P1-01] api-types.ts 手工 171 行同步

**文件**: `packages/web/src/types/api-types.ts`
**问题**: 前端手动维护与 `@super-agent/core` 的类型同步，每次 core 改类型都需人工对齐
**修复方案**（v2 修订 · 对应 I1 必须声明 exports 子路径）:

**Step 1**: 在 `packages/core/src/types/` 下新增 `web-safe-types.ts`

```typescript
/**
 * Web-Safe Type Exports — 仅包含纯类型，无 Node.js 模块依赖
 *
 * 前端通过 `import type { ... } from "@super-agent/core/web-safe-types"`
 * 直接消费，消除手工同步。
 */
export type {
  SkillProposal,
  EvolutionStats,
  Snapshot,
  NudgeConfig,
  AttachmentItem,
  TaskOutputItem,
  CollabMessageItem,
  CollabHistoryItem,
  MemoryEntry,
  Credential,
  AuditEntry,
  SecurityPolicy,
  ApprovalItem,
  AgentState,
  // ... 及其他前端需要的类型
} from "./index.js";
```

**Step 2（v2 新增 · 对应 I1）**: 必须声明 core 包的 `exports` 子路径

修改 `packages/core/package.json`:

```jsonc
{
  "name": "@super-agent/core",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    // ↓ 新增 web-safe-types 子路径
    "./web-safe-types": {
      "types": "./dist/types/web-safe-types.d.ts",
      "import": "./dist/types/web-safe-types.js"
    }
  },
  "files": ["dist"]
}
```

**tsup 构建配置同步** `packages/core/tsup.config.ts`：

```typescript
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/types/web-safe-types.ts",   // ← 新增入口
  ],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  ...
});
```

**Step 3**: 前端替换为直接导入

```typescript
// 旧: web/src/types/api-types.ts — 171 行手工定义
// 新: 各消费文件直接 import:
import type { AgentState, SkillProposal, ... } from "@super-agent/core/web-safe-types";
```

**Step 4**: 逐步删除 `web/src/types/api-types.ts`（先标记 deprecated，确认无遗漏后删除）

**验证**:
```bash
# 前端构建不报 ERR_PACKAGE_PATH_NOT_EXPORTED
pnpm --filter @super-agent/web build
# tsc 类型检查通过
pnpm --filter @super-agent/web tsc --noEmit
```

#### [CTR-P1-02] PlatformEventType 未含视频事件

**文件**: `packages/api/src/ws/index.ts` + `packages/core/src/events/`
**问题**: 视频事件用 `as any` 绕过类型检查
**修复**:

```typescript
// 在 core/src/events/index.ts 中扩展 PlatformEventType：
export type PlatformEventType =
  | "agent:start"
  | "agent:stop"
  | "agent:updated"
  | "session:start"
  | "session:end"
  | "message:received"
  | "message:sent"
  // 视频事件（新增）
  | "video:progress"
  | "video:completed"
  | "video:failed"
  | "video:stage_changed"
  // 协作事件
  | "collab:task_start"
  | "collab:task_end"
  | "collab:complete";
```

然后删除 `ws/index.ts` 中的 `as any` 类型断言。

#### [CTR-P1-03] AGENT_IDS 前后端硬编码两份

**问题**: `video-crew-presets.ts` 和前端代码各自维护 `VIDEO_AGENT_IDS`
**修复**:

在 `packages/core/src/contracts/agent-ids.ts` 统一定义:
```typescript
/** 视频工作室 6 个 Agent ID 常量 — 前后端唯一来源 */
export const VIDEO_AGENT_IDS = {
  WRITER:    "video-crew-writer",
  DESIGNER:  "video-crew-designer",
  STORYBOARD:"video-crew-storyboard",
  VOICE:     "video-crew-voice",
  VIDEO:     "video-crew-video",
  EDITOR:    "video-crew-editor",
} as const;

export type VideoAgentId = typeof VIDEO_AGENT_IDS[keyof typeof VIDEO_AGENT_IDS];
```

后端 `video-crew-presets.ts` 和前端 `collaboration/page.tsx` 均从此处 import。

#### [CTR-P1-04] `model: "default"` 运行时未校验

已在 CORE-P1-04 中处理，此条为 API 层校验。

---

### 5.3 API 层（~1.5 人日）

#### [API-P1-01] `/providers/:id/test` 无速率限制

**文件**: `packages/api/src/routes/models.ts:140-194`
**前置（v2 新增 · 对应 V1）**: 项目尚未安装 `@fastify/rate-limit`，执行前必须先安装：

```bash
# 必须在 D0 或本条执行前运行
pnpm --filter @super-agent/api add @fastify/rate-limit
```

**修复**:

```typescript
// 方案：引入 @fastify/rate-limit
import rateLimit from "@fastify/rate-limit";

// 注册（在 modelRoutes 函数开头）：
await app.register(rateLimit, {
  max: 10,
  timeWindow: "1 minute",
  keyGenerator: (request) => {
    return (request.headers["x-forwarded-for"] as string) ||
           request.ip ||
           "unknown";
  },
});

// 在 /test 路由上应用限速：
app.post("/api/models/providers/:id/test", {
  config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  preHandler: requirePermission("*"),
}, async (request, reply) => { ... });
```

**验证**:
```bash
# package.json 已含依赖
grep "@fastify/rate-limit" super-agent/packages/api/package.json

# 连续 6 次 POST /test 第 6 次应返回 429
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "req$i: %{http_code}\n" \
    -X POST http://localhost:3001/api/models/providers/openai/test \
    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{}'
done
# 期望前 5 次 200，第 6 次 429
```

#### [API-P1-02] video.ts model="default" 未校验

**文件**: `packages/api/src/routes/video.ts:182-189`
**修复** — 在 crew 启动前添加校验:

```typescript
// 在启动视频 crew 前：
for (const [agentId, config] of Object.entries(crewConfig.agents)) {
  if (!config.llmProvider?.model || config.llmProvider.model === "default") {
    return reply.status(400).send({
      error: `Agent "${agentId}" 未配置有效模型，请在设置页选择模型后重试。`,
      agentId,
    });
  }
}
```

#### [API-P1-03] err.message 直出泄露内部栈

**文件**: 多处 `routes/**`
**修复** — 统一走全局 errorHandler:

```typescript
// 方案：在各路由 catch 块中用 reply.status(500).send({ error: "Internal server error" })
// 替代 reply.send(err.message)，详细错误仅打入日志
app.log.error({ err, route: request.url }, "Unhandled error");
return reply.status(500).send({ error: "Internal server error" });
```

---

### 5.4 前端层（~1.5 人日）

#### [WEB-P1-01] media 下载无 Authorization header

**文件**: `packages/web/src/app/media/page.tsx`
**问题**: `<a href>` 下载不携带 JWT token
**修复**:

```typescript
// 方案：改为 fetch + Blob 下载，携带 Authorization header
async function downloadMedia(url: string, filename: string) {
  const token = getCookie("token"); // 或从 context/store 获取
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(blobUrl);
}
```

#### [WEB-P1-02] EventSource 无法携带自定义 Header

**文件**: `packages/web/src/app/collaboration/page.tsx`
**问题**: EventSource API 不支持自定义 Header
**修复** — 使用 fetch + ReadableStream 替代 EventSource:

```typescript
// 方案：用 fetch + SSE parser 替代原生 EventSource
async function* streamSSE(url: string, token: string) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // SSE 解析循环...
}
```

#### [WEB-P1-03] TTS blob URL 内存泄漏

**文件**: `packages/web/src/app/chat/page.tsx`
**问题**: `URL.revokeObjectURL` 仅在 `onended` 释放，若中途切换对话则泄漏
**修复**:

```typescript
// 在 useEffect cleanup 中释放：
useEffect(() => {
  const audio = new Audio(blobUrl);
  audio.play();
  return () => {
    audio.pause();
    audio.src = "";
    URL.revokeObjectURL(blobUrl);
  };
}, [blobUrl]);
```

#### [WEB-P1-04] apiFetch 封装未统一

**问题**: chat/dashboard/media 用不同 fetch 包装方式
**修复** — 统一为 `lib/api-client.ts`:

```typescript
// packages/web/src/lib/api-client.ts
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  return res.json();
}
```

---

## 六、P2 修复 — 第 12-18 天（可维护性提升）

| ID | 文件/行号 | 修复方案 |
|----|-----------|---------|
| CORE-P2-01 | `runtime.ts:1339-1357` | `updateConfig` 整段替换改为深度 merge，与 `llmOverride` 语义对齐 |
| CORE-P2-02 | `agent/voice.ts` | `Math.random()` 替换为 `crypto.randomBytes(16).toString("hex")` |
| CORE-P2-03 | `agent/fallback.ts` | 添加 fallback 链环检测：用 Set 跟踪已访问 provider，重复时抛错 |
| API-P2-01 | `routes/video.ts` | 统一为 camelCase（`selected_model` → `selectedModel` 等） |
| API-P2-02 | `routes/video.ts` | HTTP `Content-Disposition` 中文文件名用 RFC 5987 `filename*=UTF-8''...` |
| API-P2-03 | `routes/**` | 消灭 `as any` 绕过 Zod 的写法，用 `z.preprocess` / `.transform()` 替代 |
| CROSS-P2-01 | `video-forge-supervisor.ts` | `path.resolve(cwd, "../../services/video-forge")` → 优先用 `VIDEO_FORGE_URL` 环境变量 |
| CROSS-P2-02 | `core/` dev watcher | tsup 添加 `onSuccess` hook 自动输出 dist，或在 monorepo root `turbo.json` 配置依赖顺序 |
| CROSS-P2-03 | `.env.example` | 补充缺漏变量：`SA_ENCRYPTION_KEY`、`JWT_SECRET`、`FRONTEND_URL`、`NEXT_PUBLIC_API_URL`、`MAX_WS_CLIENTS`、`SUPER_AGENT_CODE_EXEC_ENABLED`、`VIDEO_CONCURRENCY_MAX`、`API_KEY` |
| CROSS-P2-04 | `.env.example:5` | `PORT=3000` → `PORT=3001`（对齐实际默认值） |

---

## 七、P3 修复 — 持续优化（灰度推进）

1. **ESLint/Prettier 统一**: 各包删除独立 `.eslintrc`，根目录一份共享配置
2. **Provider 列表缓存**: `GET /api/models/providers` 加 60s TTL 缓存减少 DB 查询
3. **工具前缀可配置**: `buildToolDefinitions()` 中用 `TOOL_PREFIX_WHITELIST` 环境变量替代 `mcp_`/`sysops` 硬编码
4. **Modal 统一**: 全局替换 `confirm()/alert()` 为自定义 Modal 组件
5. **i18n 基础**: 提取所有用户面向字符串到 `i18n/zh-CN.json`

---

## 八、验证清单

### P0 修复后（D1-D3）

- [ ] `grep -r "sk-UVAp" super-agent/` 返回空
- [ ] `grep -r "crypto\.randomUUID" packages/api/src/ packages/core/src/` 返回空（SEC-P0-05，13 处全量）
- [ ] `GET /api/agents` 返回值 `config.llmProvider.apiKey` 以 `sk-***` 结尾（非完整 key）
- [ ] **E1 回归**：PUT 回传脱敏后的 apiKey 字符串 → 再次 GET 仍是原始真实 key（未被污染）
- [ ] **M1 检查**：`grep "function maskApiKey" super-agent/packages/` 仅命中 `core/src/agent/sanitize.ts`
- [ ] `PUT /api/models/providers/:id` 无 token → 401
- [ ] `GET /ws` 无 token → WebSocket 立即关闭 (code 4001)
- [ ] **E3 检查**：前端 `useWebSocket.ts` 连接时带 `?token=`；dashboard 实时数据正常显示
- [ ] `SA_ENCRYPTION_KEY` 未设置 → 进程拒绝启动
- [ ] **E2 迁移验证**：设置新 `SA_ENCRYPTION_KEY` + `SA_ENCRYPTION_KEY_LEGACY=旧值` 启动，日志出现 `[migration] re-encrypted`，provider 凭证可正常解密使用
- [ ] **B2 白名单**：默认未开启代码执行时，内置 ResearchCrew/DataAnalyst 调用 `run_shell` 仍能工作
- [ ] **M2 融合**：`securityManager.getSandboxLevel()` 和 `SUPER_AGENT_CODE_EXEC_ENABLED` 联动生效
- [ ] **E4 类型检查**：`pnpm --filter @super-agent/core tsc --noEmit` 通过；`saveDatabase()` 调用点全部 `await` 或 `.catch`
- [ ] `saveDatabase()` 重试期间 HTTP 请求正常响应（压测不卡顿）

### P1 修复后（D4-D11）

- [ ] **E5 验证**：Session lock 对同一 sessionId 并发 10 请求总耗时 ≈ 串行耗时，无交叉写入
- [ ] **B3 阶段 A**：`packages/core/src/persistence/sqlite/connection.ts` 已创建，老 `sqlite.ts` re-export 通过
- [ ] Anthropic provider 构造时抛错（非静默）
- [ ] `model: "default"` 在视频 crew 启动时被拦截返回 400
- [ ] **B1 分表**：`memory_entries` 表有 `embedding_type` 字段；Qwen 宕机时新记录 `embedding_type='simple'`，检索不混算
- [ ] `web/types/api-types.ts` 已删除或标记 deprecated
- [ ] **I1 exports**：`packages/core/package.json` 含 `./web-safe-types` 子路径；前端 `pnpm build` 不报 `ERR_PACKAGE_PATH_NOT_EXPORTED`
- [ ] `PlatformEventType` 含 `video:*` 联合类型
- [ ] `VIDEO_AGENT_IDS` 仅定义在 `core/src/contracts/agent-ids.ts` 一处
- [ ] **V1 依赖**：`grep @fastify/rate-limit super-agent/packages/api/package.json` 命中
- [ ] `/providers/:id/test` 超过 5 次/分钟 → 429
- [ ] 前端 `apiFetch` 统一使用 `lib/api-client.ts`

### 环境模板（第十章）

- [ ] **I2**：`.env.example` 包含所有新增变量（`SA_ENCRYPTION_KEY_LEGACY`/`MAX_WS_CLIENTS`/`SUPER_AGENT_SANDBOX_LEVEL` 等）

---

## 九、执行顺序总表

| 天 | 修复项 | 关键动作 |
|----|--------|---------|
| **D0** | 前置 | `pnpm add @fastify/rate-limit`；规划 `SA_ENCRYPTION_KEY_LEGACY`；备份 DB |
| **D1** | SEC-P0-01, SEC-P0-05 | Key 轮换 + `.gitignore` 确认 + **13 处** `crypto.randomUUID` 导入修复 |
| **D2** | SEC-P0-04, SEC-P0-06, SEC-P0-07 | sanitizeAgentState + **脱敏哨兵(E1)** + 删 models.ts 本地 maskApiKey(M1) + providers RBAC + /ws JWT 鉴权 + **按角色默认订阅(E3)** + **前端 useWebSocket 配套改造(E3)** |
| **D3** | SEC-P0-02, SEC-P0-03, CORE-P0-08 | 加密 key 强制校验 + **LEGACY 迁移(E2)** + 代码执行复用 **sandboxLevel(M2)** + **系统级 Agent 白名单(B2)** + **saveDatabase 改 async 全链路(E4)** |
| **D4-5** | CORE-P1-01~05 | **链式 Promise mutex(E5)** + sqlite **阶段 A 抽 connection(B3)** + Anthropic throw + model 校验 + **QwenEmbedding 分表存储(B1)** |
| **D6-7** | CTR-P1-01~04 | 类型导出 + **core/package.json exports 子路径(I1)** + PlatformEventType + AGENT_IDS 统一 + model 校验 |
| **D8-9** | API-P1-01~03 | rate-limit + error handler 统一 |
| **D10-11** | WEB-P1-01~04 | auth header + SSE 替代 + blob 泄漏 + apiFetch 统一 |
| **D12-18** | P2 × 10 | 各项可维护性提升 |
| **后续 sprint** | CORE-P1-02 阶段 B/C | 每周抽一个领域 repo，两周稳定期后删老 sqlite.ts |
| **持续** | P3 × 5 | 风格/优化/国际化 |

---

## 十、`.env.example` 最终完整版（v2 新增 · 对应 I2）

> 执行完所有 P0 + P1 后，`.env.example` 应达到以下最终态。所有散落在各条目的新增变量在此汇总一次：

```env
# ================================ Super Agent .env 模板 ================================
# 复制本文件为 .env 并按注释填入真实值
# .env 已在 .gitignore，切勿提交含真实密钥的文件

# ==================== 运行时基础 ====================
NODE_ENV=development
PORT=3001                                    # CROSS-P2-04 对齐实际默认
LOG_LEVEL=info

# ==================== 加密（必填）====================
# 主密钥 — 用于 AES-256-CBC 加密 providerStore / toolConfigStore 中的凭证
# 生成方法: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
SA_ENCRYPTION_KEY=

# 迁移期临时变量 — 首次升级后可删除（对应 E2 迁移方案）
# 若从 v1 及之前升级，填入之前使用过的 SA_ENCRYPTION_KEY（或默认值 super-agent-default-encryption-key-v1）
# 首次启动完成重加密后（日志出现 [migration] re-encrypted），即可删除本行
# SA_ENCRYPTION_KEY_LEGACY=

# ==================== JWT / 鉴权 ====================
# JWT 签名密钥（必填，≥32 字符随机串）
JWT_SECRET=
# 默认管理员 API Key（可选，由 `POST /api/auth/keys` 创建后可删）
# API_KEY=

# ==================== LLM 默认配置 ====================
# 仅作为首次引导用 fallback，用户可在设置页覆盖
LLM_API_KEY=your-moonshot-key-here
LLM_BASE_URL=https://api.moonshot.cn/v1
LLM_MODEL=kimi-k2-0905-preview
MOONSHOT_API_KEY=your-moonshot-key-here
# DASHSCOPE_API_KEY= # 可选：用于 QwenEmbedding

# ==================== WebSocket ====================
# WebSocket 并发连接上限（SEC-P0-07）
MAX_WS_CLIENTS=500

# ==================== 安全沙箱（SEC-P0-03）====================
# 代码执行沙箱等级（none/process/docker），默认 none 禁止用户级 Agent 执行
# 系统级 Agent（isBuiltin=true / trust_level=system）不受此限制
# SUPER_AGENT_SANDBOX_LEVEL=none

# 快捷开关（等价于 SUPER_AGENT_SANDBOX_LEVEL=process）
# SUPER_AGENT_CODE_EXEC_ENABLED=true

# ==================== 视频 ====================
# VIDEO_FORGE_URL=http://localhost:7018        # CROSS-P2-01：避免硬编码相对路径
# VIDEO_CONCURRENCY_MAX=2

# ==================== 前端 ====================
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001
```

**验证**:
```bash
# 所有 P0/P1 新增变量都在本模板中可见（一次性核对）
grep -E "^(SA_ENCRYPTION_KEY|SA_ENCRYPTION_KEY_LEGACY|JWT_SECRET|MAX_WS_CLIENTS|SUPER_AGENT_SANDBOX_LEVEL|SUPER_AGENT_CODE_EXEC_ENABLED|FRONTEND_URL|NEXT_PUBLIC_API_URL|PORT)=" super-agent/.env.example | wc -l
# 期望: ≥ 9
```

---

**Spec 终（v2）**
