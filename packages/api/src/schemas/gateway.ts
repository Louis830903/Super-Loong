/**
 * v3 Task 6 — IM Gateway 代理端点 zod schema（B-3' 试点）
 *
 * @why channels CRUD（/api/channels/*）前端零消费，真正前端在用的是
 *       /api/gateway/* 这一批代理端点（gateway 转发到 Python IM 网关）。
 *       为了让 schema 化产生真实价值（端到端类型同源 + 消除前端手写类型），
 *       优先把这一批代理端点的响应壳 schema 化。
 *
 * 数据来源：以 packages/web/src/app/channels/page.tsx 中已经在生产运行的
 *           ChannelSchema / ChannelStatus / GatewayHealth 手写 interface 为
 *           权威结构反射回 zod —— 前端能跑说明结构正确。
 *
 * 命名策略：所有 component 加 Gateway 前缀，避免与 channels.ts 里的
 *           ChannelEntity / ChannelConfig 冲突。
 */

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry-singleton.js";
import { apiSuccessEnvelope, ApiErrorEnvelopeSchema } from "./envelope.js";

extendZodWithOpenApi(z);

// ── Schema 驱动表单字段（/api/gateway/channels/schemas 响应里的 fields[i]）──

export const GatewayChannelFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "secret", "number", "boolean", "select", "url"]),
  required: z.boolean(),
  default: z.unknown(),
  placeholder: z.string(),
  help_text: z.string(),
  options: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })),
  group: z.string(),
  order: z.number(),
}).openapi("GatewayChannelField", {
  description: "Schema 驱动表单字段定义（前端据此自动渲染表单）",
});

// ── 渠道配置 Schema（/api/gateway/channels/schemas 响应数组元素）─────────

export const GatewayChannelSchemaSchema = z.object({
  channel_id: z.string().openapi({ example: "feishu" }),
  channel_label: z.string().openapi({ example: "飞书" }),
  docs_url: z.string(),
  setup_guide: z.string(),
  fields: z.array(GatewayChannelFieldSchema),
}).openapi("GatewayChannelSchema", {
  description: "单个 IM 渠道的 schema 描述（用于前端表单自动生成）",
});

// ── 渠道运行时状态（/api/gateway/channels/list 响应里的 channels[i]）────

export const GatewayChannelStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  connected: z.boolean(),
  last_error: z.string().nullable(),
  has_qr_login: z.boolean(),
  has_doctor: z.boolean(),
  has_setup: z.boolean(),
  capabilities: z.object({
    media: z.boolean(),
    threads: z.boolean(),
    block_streaming: z.boolean(),
  }),
}).openapi("GatewayChannelStatus", {
  description: "单个渠道的连接状态与能力描述",
});

// ── 健康详情（/api/gateway/health 响应里的 health[platform]）────────────

export const GatewayHealthEntrySchema = z.object({
  status: z.string(),
  severity: z.number(),
  needs_restart: z.boolean(),
  cooldown_remaining: z.number(),
}).openapi("GatewayHealthEntry");

// ── 网关聚合健康（/api/gateway/health 响应）─────────────────────────────

export const GatewayHealthSchema = z.object({
  status: z.string().openapi({ example: "ok" }),
  version: z.string().optional(),
  api_connection: z.string().optional(),
  channels: z.record(
    z.object({
      connected: z.boolean(),
      last_error: z.string().nullable(),
    }),
  ).optional(),
  channel_count: z.number().optional(),
  active_sessions: z.number().optional(),
  health: z.record(GatewayHealthEntrySchema).optional(),
  reconnect: z.record(z.unknown()).optional(),
  // 离线兜底字段（API-P1-03：网关不可达时 sendSuccess 仍返回 status=offline + error）
  error: z.string().optional(),
}).openapi("GatewayHealth", {
  description: "IM 网关聚合健康（含每渠道 connect 状态 + 健康分级 + 重连指标）",
});

// ── 注册到 OpenAPI Registry ─────────────────────────────────────────────

registry.register("GatewayChannelField", GatewayChannelFieldSchema);
registry.register("GatewayChannelSchema", GatewayChannelSchemaSchema);
registry.register("GatewayChannelStatus", GatewayChannelStatusSchema);
registry.register("GatewayHealthEntry", GatewayHealthEntrySchema);
registry.register("GatewayHealth", GatewayHealthSchema);

// ── 路径声明 ────────────────────────────────────────────────────────────

// GET /api/gateway/health —— 聚合健康（透传或离线兜底）
registry.registerPath({
  method: "get",
  path: "/api/gateway/health",
  summary: "IM 网关聚合健康",
  description: "透传 Python 网关 /health；网关不可达时返回 status=offline 兜底",
  tags: ["Gateway"],
  responses: {
    200: {
      description: "网关健康详情",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(GatewayHealthSchema, "GatewayHealthEnvelope"),
        },
      },
    },
  },
});

// GET /api/gateway/channels/schemas —— 所有渠道的配置 schema 列表
registry.registerPath({
  method: "get",
  path: "/api/gateway/channels/schemas",
  summary: "列出所有渠道的配置 Schema",
  description: "前端据此自动渲染配置表单；透传 Python 网关响应",
  tags: ["Gateway"],
  responses: {
    200: {
      description: "渠道 schema 列表",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(
            z.array(GatewayChannelSchemaSchema),
            "GatewayChannelSchemasEnvelope",
          ),
        },
      },
    },
    502: {
      description: "网关不可达（走 sendError badGateway）",
      content: {
        "application/json": { schema: ApiErrorEnvelopeSchema },
      },
    },
  },
});

// GET /api/gateway/channels/list —— 列出所有渠道及连接状态
registry.registerPath({
  method: "get",
  path: "/api/gateway/channels/list",
  summary: "列出所有渠道及连接状态",
  description: "透传 Python 网关 /api/gateway/channels；返回每渠道连接 / 能力详情",
  tags: ["Gateway"],
  responses: {
    200: {
      description: "渠道状态列表",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(
            z.object({
              channels: z.array(GatewayChannelStatusSchema),
            }),
            "GatewayChannelListEnvelope",
          ),
        },
      },
    },
  },
});
