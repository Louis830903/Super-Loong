/**
 * v3 Task 6 — Models & Providers 路由 zod schema
 *
 * @why 模型配置是平台核心流程，前端高频消费，必须强类型保障。
 *
 * 端点：
 *   GET    /api/models/catalog         — 内置模型目录
 *   GET    /api/models/providers       — 已配置 Provider 列表（含脱敏 key）
 *   PUT    /api/models/providers/{id}  — 更新 Provider 配置
 *   DELETE /api/models/providers/{id}/key — 清空 API Key
 *   POST   /api/models/providers/{id}/test — 测试连接
 */

import { z } from "zod";
import { registry } from "./registry-singleton.js";
import { apiSuccessEnvelope } from "./envelope.js";

// ─── 基础 Schema ────────────────────────────────────────────

/** @why 单个模型定义，被 ProviderCatalog/ProviderConfig 复用 */
export const ModelDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  fixedTemperature: z.number().optional(),
  deprecated: z.boolean().optional(),
  deprecationDate: z.string().optional(),
  free: z.boolean().optional(),
});
registry.register("ModelDef", ModelDefSchema);

/** @why 内置模型目录条目，用于 GET /api/models/catalog 响应 */
export const ProviderCatalogSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().url().optional(),
  baseUrl: z.string(),
  models: z.array(ModelDefSchema),
});
registry.register("ProviderCatalog", ProviderCatalogSchema);

/** @why 已配置 Provider 运行时状态（含脱敏 key），用于前端渲染 */
export const ProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().optional(),
  baseUrl: z.string(),
  defaultBaseUrl: z.string(),
  isEnabled: z.boolean(),
  selectedModel: z.string(),
  keyStatus: z.enum(["configured", "missing"]),
  maskedKey: z.string(),
  models: z.array(ModelDefSchema),
});
registry.register("ProviderConfig", ProviderConfigSchema);

// ─── PUT Body ───────────────────────────────────────────────

/** @why PUT /api/models/providers/{id} 请求体，字段全 optional 支持局部更新 */
export const UpdateProviderBodySchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  isEnabled: z.boolean().optional(),
  selectedModel: z.string().optional(),
});
registry.register("UpdateProviderBody", UpdateProviderBodySchema);

// ─── POST test Body ─────────────────────────────────────────

/** @why POST /api/models/providers/{id}/test 请求体，支持临时覆盖 key/baseUrl */
export const TestProviderBodySchema = z.object({
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});
registry.register("TestProviderBody", TestProviderBodySchema);

// ─── Response 类型 ──────────────────────────────────────────

const CatalogEnvelopeData = z.object({ providers: z.array(ProviderCatalogSchema) });
const ProvidersEnvelopeData = z.object({ providers: z.array(ProviderConfigSchema) });
const ProviderUpdatedData = z.object({
  provider: z.object({
    id: z.string(),
    isEnabled: z.boolean(),
    selectedModel: z.string(),
    keyStatus: z.enum(["configured", "missing"]),
    maskedKey: z.string(),
    baseUrl: z.string(),
  }),
});
const TestResultData = z.object({
  success: z.boolean(),
  model: z.string(),
  response: z.string(),
  usage: z.record(z.unknown()).optional(),
});

// ─── 注册路径 ───────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/models/catalog",
  summary: "获取内置模型目录",
  responses: {
    200: { description: "模型目录", content: { "application/json": { schema: apiSuccessEnvelope(CatalogEnvelopeData) } } },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/models/providers",
  summary: "获取已配置 Provider 列表",
  responses: {
    200: { description: "Provider 列表", content: { "application/json": { schema: apiSuccessEnvelope(ProvidersEnvelopeData) } } },
  },
});

registry.registerPath({
  method: "put",
  path: "/api/models/providers/{id}",
  summary: "更新 Provider 配置",
  request: { body: { content: { "application/json": { schema: UpdateProviderBodySchema } } } },
  responses: {
    200: { description: "更新成功", content: { "application/json": { schema: apiSuccessEnvelope(ProviderUpdatedData) } } },
    404: { description: "Provider 不存在" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/models/providers/{id}/key",
  summary: "清空 Provider API Key",
  responses: {
    200: { description: "清空成功", content: { "application/json": { schema: apiSuccessEnvelope(z.object({ success: z.boolean() })) } } },
    404: { description: "Provider 不存在" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/models/providers/{id}/test",
  summary: "测试 Provider 连接",
  request: { body: { content: { "application/json": { schema: TestProviderBodySchema } } } },
  responses: {
    200: { description: "测试成功", content: { "application/json": { schema: apiSuccessEnvelope(TestResultData) } } },
    502: { description: "连接失败" },
  },
});
