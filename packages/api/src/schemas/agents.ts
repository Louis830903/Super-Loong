/**
 * v3 Task 6 — Agents CRUD 路由 zod schema
 *
 * @why Agent 管理是平台核心，前端频繁消费列表/详情/CRUD，强类型可消除手写 interface 漂移。
 *
 * 端点：
 *   GET    /api/agents              — 列出所有 Agent（支持筛选/分页）
 *   POST   /api/agents              — 创建 Agent
 *   GET    /api/agents/{id}         — Agent 详情
 *   PUT    /api/agents/{id}         — 更新 Agent
 *   DELETE /api/agents/{id}         — 删除 Agent
 *   POST   /api/agents/{id}/fork    — Fork 内置 Agent
 *   GET    /api/agents/{id}/forks   — 查询 Fork 列表
 */

import { z } from "zod";
import { registry } from "./registry-singleton.js";
import { apiSuccessEnvelope } from "./envelope.js";

// ─── Agent 实体 Schema ──────────────────────────────────────

/** @why Agent 元信息（来源、图标、部门），前端列表/详情页渲染 */
export const AgentMetadataSchema = z.object({
  isBuiltin: z.boolean().optional(),
  department: z.string().optional(),
  forkedFrom: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
}).passthrough();
registry.register("AgentMetadata", AgentMetadataSchema);

/** @why Agent 绑定的 LLM 配置，嵌套在 AgentState 内 */
export const AgentLLMProviderSchema = z.object({
  type: z.string(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  providerId: z.string().optional(),
  supportsReasoning: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
}).passthrough();
registry.register("AgentLLMProvider", AgentLLMProviderSchema);

/** @why Agent 完整状态实体，列表/详情/CRUD 接口共用 */
export const AgentStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  llmProvider: AgentLLMProviderSchema.optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  memoryEnabled: z.boolean().optional(),
  maxToolIterations: z.number().optional(),
  metadata: AgentMetadataSchema.optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
});
registry.register("AgentState", AgentStateSchema);

// ─── Query params ───────────────────────────────────────────

/** @why GET /api/agents 查询参数，支持按类型/部门/分页筛选 */
export const AgentListQuerySchema = z.object({
  type: z.enum(["builtin", "custom", "all"]).optional(),
  department: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

// ─── Response Data ──────────────────────────────────────────

const AgentListData = z.object({
  agents: z.array(AgentStateSchema),
  total: z.number(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
const AgentDetailData = z.object({ agent: AgentStateSchema });
const AgentForksData = z.object({ forks: z.array(AgentStateSchema), count: z.number() });

// ─── 注册路径 ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/agents",
  summary: "列出所有 Agent（支持 type/department/分页）",
  responses: {
    200: { description: "Agent 列表", content: { "application/json": { schema: apiSuccessEnvelope(AgentListData) } } },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/agents",
  summary: "创建新 Agent",
  responses: {
    200: { description: "创建成功", content: { "application/json": { schema: apiSuccessEnvelope(AgentDetailData) } } },
    400: { description: "配置校验失败" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}",
  summary: "获取 Agent 详情",
  responses: {
    200: { description: "Agent 详情", content: { "application/json": { schema: apiSuccessEnvelope(AgentDetailData) } } },
    404: { description: "Agent 不存在" },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/agents/{id}",
  summary: "更新 Agent",
  responses: {
    200: { description: "更新成功", content: { "application/json": { schema: apiSuccessEnvelope(AgentDetailData) } } },
    404: { description: "Agent 不存在" },
    403: { description: "内置 Agent 不可修改" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/agents/{id}",
  summary: "删除 Agent",
  responses: {
    200: { description: "删除成功", content: { "application/json": { schema: apiSuccessEnvelope(z.object({ success: z.boolean() })) } } },
    404: { description: "Agent 不存在" },
    403: { description: "内置 Agent 不可删除" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/{id}/fork",
  summary: "Fork 内置 Agent 为自定义副本",
  responses: {
    200: { description: "Fork 成功", content: { "application/json": { schema: apiSuccessEnvelope(AgentDetailData) } } },
    404: { description: "源 Agent 不存在" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/agents/{id}/forks",
  summary: "查询 Agent 的 Fork 列表",
  responses: {
    200: { description: "Fork 列表", content: { "application/json": { schema: apiSuccessEnvelope(AgentForksData) } } },
    404: { description: "Agent 不存在" },
  },
});
