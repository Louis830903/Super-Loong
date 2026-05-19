/**
 * v3 Task 6 — Channel 路由 zod schema（试点：4 个 CRUD 端点）
 *
 * @why 第一个迁移到 schema 驱动的业务路由：选择 channels 因为
 *       (1) 已经在路由层用了 core 的 ChannelConfigSchema 做 body 校验，
 *           复用度最高，零业务行为变更；
 *       (2) 前端目前完全没有 Channel 手写类型（web-types/api-types.ts 不含 channel），
 *           本次迁移直接补齐前端类型，价值最大；
 *       (3) 端点结构典型：覆盖 list / detail(params) / create(body) / delete(params)，
 *           作为模板供后续路由批量迁移参照。
 *
 * 范围（本次 Task 6-后续 第一批）：
 *   - GET    /api/channels       —— 列表
 *   - GET    /api/channels/{id}  —— 详情
 *   - POST   /api/channels       —— 新建
 *   - DELETE /api/channels/{id}  —— 删除
 *
 * 暂不迁移：/api/gateway/* 代理端点（数据结构由 Python 网关动态决定，
 *   后续 Task 6-后续 第二批再处理）。
 */

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry-singleton.js";
import {
  ApiErrorEnvelopeSchema,
  apiSuccessEnvelope,
} from "./envelope.js";

extendZodWithOpenApi(z);

/**
 * 渠道配置（与 core 的 ChannelConfigSchema 双向同源）。
 *
 * @why 此处不直接 import core 的 schema 以避免 web-types 间接依赖 core；
 *       字段定义保持与 core/src/types/index.ts:ChannelConfigSchema 一致，
 *       任一方修改都需同步另一方（CI 可后续加结构对齐校验）。
 */
export const ChannelConfigSchema = z
  .object({
    platform: z.string().openapi({ example: "feishu" }),
    enabled: z.boolean().default(true),
    displayName: z.string().optional(),
    credentials: z.record(z.string()).default({}),
    settings: z.record(z.unknown()).default({}),
  })
  .openapi("ChannelConfig", { description: "IM 渠道配置（凭据 + 业务设置）" });

/**
 * 渠道实体（持久化 + 运行时合体）。
 */
export const ChannelEntitySchema = z
  .object({
    id: z.string().openapi({ example: "ch_a1b2c3d4" }),
    config: ChannelConfigSchema,
    status: z.string().openapi({
      description: "渠道运行状态",
      example: "configuring",
    }),
  })
  .openapi("ChannelEntity", { description: "IM 渠道实体（含运行状态）" });

/** Path 参数：渠道 ID */
const ChannelIdParam = z.object({
  id: z.string().min(1).openapi({ example: "ch_a1b2c3d4" }),
});

// ───────────────────────────────────────────────────────────
// 注册到 registry：每个 path 显式声明请求/响应壳
// ───────────────────────────────────────────────────────────

registry.register("ChannelConfig", ChannelConfigSchema);
registry.register("ChannelEntity", ChannelEntitySchema);

// GET /api/channels —— 列表
registry.registerPath({
  method: "get",
  path: "/api/channels",
  summary: "列出所有 IM 渠道",
  tags: ["Channels"],
  responses: {
    200: {
      description: "渠道列表",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(
            z.object({ channels: z.array(ChannelEntitySchema) }),
            "ChannelListEnvelope",
          ),
        },
      },
    },
  },
});

// GET /api/channels/{id} —— 详情
registry.registerPath({
  method: "get",
  path: "/api/channels/{id}",
  summary: "获取单个 IM 渠道详情",
  tags: ["Channels"],
  request: { params: ChannelIdParam },
  responses: {
    200: {
      description: "渠道详情",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(
            z.object({ channel: ChannelEntitySchema }),
            "ChannelDetailEnvelope",
          ),
        },
      },
    },
    404: {
      description: "渠道不存在",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

// POST /api/channels —— 新建
registry.registerPath({
  method: "post",
  path: "/api/channels",
  summary: "新建 IM 渠道",
  tags: ["Channels"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ChannelConfigSchema } },
    },
  },
  responses: {
    201: {
      description: "渠道创建成功",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(
            z.object({ channel: ChannelEntitySchema }),
            "ChannelCreatedEnvelope",
          ),
        },
      },
    },
    400: {
      description: "渠道配置不合法",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});

// DELETE /api/channels/{id} —— 删除
registry.registerPath({
  method: "delete",
  path: "/api/channels/{id}",
  summary: "删除 IM 渠道",
  tags: ["Channels"],
  request: { params: ChannelIdParam },
  responses: {
    200: {
      description: "删除成功",
      content: {
        "application/json": {
          schema: apiSuccessEnvelope(
            z.object({ success: z.literal(true) }),
            "ChannelDeletedEnvelope",
          ),
        },
      },
    },
    404: {
      description: "渠道不存在",
      content: { "application/json": { schema: ApiErrorEnvelopeSchema } },
    },
  },
});
