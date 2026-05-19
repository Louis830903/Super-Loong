/**
 * v3 Task 6 — 响应壳 zod schema（与 v3 Task 3 ApiSuccess/ApiError 双向同源）
 *
 * @why 把 v3 Task 3 已落地的响应壳 TypeScript interface 用 zod 重写，使
 *       OpenAPI 生成出来的 schema 与运行时校验完全一致；后续每条路由的响应
 *       schema 都通过 ApiSuccessSchema(MyDataSchema) 包装。
 */

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry-singleton.js";

// 给 zod 注入 .openapi() 扩展（必须在使用前调用一次）
extendZodWithOpenApi(z);

/**
 * 错误码 schema（与 response-helper.ts Errors 命名空间一一对应）。
 *
 * @why 限定错误码为字符串，先开放枚举；后续可在此处显式列出全部错误码做
 *       discriminator，与 Task 11 错误码标准化对齐。
 */
export const ErrorCodeSchema = z
  .string()
  .min(1)
  .openapi({ description: "标准化错误码", example: "NOT_FOUND" });

/**
 * 错误体 schema。
 *
 * @why 与 ApiError.error 字段一致：code/message 必填、details 可选；
 *       生产环境 details 会被服务端抹除，schema 层面保持可选即可。
 */
export const ApiErrorBodySchema = z
  .object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  })
  .openapi({ description: "标准化错误体" });

/**
 * 错误响应壳 schema（success: false）。
 *
 * @why 与 [ApiError](packages/api/src/routes/response-helper.ts) 一一对应；
 *       traceId 为可选字段，由 response-envelope hook 自动注入。
 */
export const ApiErrorEnvelopeSchema = z
  .object({
    success: z.literal(false),
    error: ApiErrorBodySchema,
    traceId: z.string().optional(),
  })
  .openapi("ApiErrorEnvelope", { description: "标准化错误响应壳" });

/**
 * 成功响应壳工厂（泛型包装）。
 *
 * @param dataSchema 业务 data 字段的 zod schema
 * @param name 注册到 OpenAPI registry 的组件名（如 "ChannelListEnvelope"）
 *
 * @why 工厂模式而非泛型 generic：zod-to-openapi 不支持运行时泛型展开，
 *       所以每个具体响应壳必须显式实例化并具名注册。
 */
export function apiSuccessEnvelope<T extends z.ZodTypeAny>(
  dataSchema: T,
  name?: string,
) {
  const schema = z
    .object({
      success: z.literal(true),
      data: dataSchema,
      traceId: z.string().optional(),
    })
    .openapi(name ?? "ApiSuccessEnvelope", {
      description: "标准化成功响应壳",
    });
  return schema;
}

// 注册全局共享组件到 registry
registry.register("ApiErrorEnvelope", ApiErrorEnvelopeSchema);
registry.registerComponent("schemas", "ApiErrorBody", {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "string", example: "NOT_FOUND" },
    message: { type: "string" },
    details: {},
  },
});
