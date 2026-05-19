/**
 * API 响应格式统一化工具
 *
 * P4-T2: 所有成功响应 → { success: true, data: ... }
 *        所有错误响应 → { success: false, error: { code, message, details? } }
 *
 * v3 Task 3 扩展：
 *   - 所有响应壳自动注入 traceId（取自 request.requestId / x-request-id）
 *   - 与 onSend response-envelope hook 配合形成双层兜底（路由显式 + hook 兜底）
 */

import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "@super-agent/web-types";

/**
 * v3 Task 11：导出后端可用的错误码联合类型，便于路由层直接 import。
 * @why 单一数据源在 web-types/src/error-codes.ts；后端只是 re-export，
 *       前端 toast 与后端 sendError 共用同一份字面量集合。
 */
export type { ApiErrorCode };

/** 从 reply.request 提取 requestId 作为 traceId（不存在则 undefined）。 */
function extractTraceId(reply: FastifyReply): string | undefined {
  // @why Fastify v4 reply 可访问关联 request；requestId 由 registerRequestId hook 注入
  const req = (reply as any).request;
  const rid = req?.requestId ?? req?.headers?.["x-request-id"];
  return typeof rid === "string" && rid.length > 0 ? rid : undefined;
}

/**
 * 标准化成功响应
 *
 * @why v3 Task 3 响应壳：以 success+data 为必填字段、traceId 为可选，
 *       保证前端 apiFetch 解包逻辑与 onSend hook 兼底全路径一致。
 */
export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  /** v3 Task 3：链路追踪 ID（来自 request.requestId） */
  traceId?: string;
}

/**
 * 标准化错误响应
 *
 * @why error 子对象处 code/message 为必填、details 可选，避免生产环境泄露
 *       堆栈；与 API-P1-03 响应脱敏策略保持一致。
 */
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  /** v3 Task 3：链路追踪 ID（来自 request.requestId） */
  traceId?: string;
}

/**
 * 响应壳联合类型。
 *
 * @why 使路由函数返回类型明确只能是 "成功壳" 或 "错误壳" 二选一，
 *       在类型层面防止遗漏 traceId 或出现中间状态。
 */
export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

/**
 * 发送标准化成功响应
 *
 * @why 与 onSend response-envelope hook 双层兼容：路由显式调用 = 主路径，
 *       hook = 兼底；同时自动注入 traceId 保证所有响应可检索。
 */
export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): FastifyReply {
  const traceId = extractTraceId(reply);
  return reply.status(statusCode).send({
    success: true,
    data,
    ...(traceId ? { traceId } : {}),
  } satisfies ApiSuccess<T>);
}

/**
 * 发送标准化错误响应
 *
 * @param reply - Fastify 回复对象
 * @param statusCode - HTTP 状态码
 * @param code - 错误码（强类型 ApiErrorCode，编译期校验拼写）
 * @param message - 面向客户端的错误描述
 * @param details - 可选的调试详请（仅开发/非生产环境返回）
 * @param exposeToClient - 即使在生产环境也暴露原始消息，默认 false
 *
 * @why 生产默认脱敏 5xx 消息 + 抹去 details，避免堆栈泄露；exposeToClient 仅
 *       限已面向用户的可读错误。与 API-P1-03 合规。
 *       v3 Task 11：code 类型从 string 收紧到 ApiErrorCode，新增码必须先在
 *       web-types/src/error-codes.ts 字典登记，否则 TS 编译报错。
 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
  exposeToClient = false,
): FastifyReply {
  // 生产环境自动脱敏：内部错误消息统一为通用提示
  const isProduction = process.env.NODE_ENV === "production";
  const safeMessage = (!exposeToClient && isProduction && statusCode >= 500)
    ? "内部服务器错误"
    : message;
  // 生产环境不返回 details，防止泄露内部信息
  const safeDetails = (!exposeToClient && isProduction) ? undefined : details;
  const traceId = extractTraceId(reply);
  return reply.status(statusCode).send({
    success: false,
    error: {
      code,
      message: safeMessage,
      ...(safeDetails !== undefined ? { details: safeDetails } : {}),
    },
    ...(traceId ? { traceId } : {}),
  } satisfies ApiError);
}

/**
 * 快捷错误辅助
 *
 * @why 集中定义常见 HTTP 错误码调用，避免路由中出现零散的魔法字符串，
 *       保证错误码全局唯一可检索。
 */
export const Errors = {
  badRequest: (reply: FastifyReply, message: string, details?: unknown) =>
    sendError(reply, 400, "BAD_REQUEST", message, details),
  notFound: (reply: FastifyReply, message = "Resource not found") =>
    sendError(reply, 404, "NOT_FOUND", message),
  unauthorized: (reply: FastifyReply, message = "Unauthorized") =>
    sendError(reply, 401, "UNAUTHORIZED", message),
  forbidden: (reply: FastifyReply, message = "Forbidden") =>
    sendError(reply, 403, "FORBIDDEN", message),
  conflict: (reply: FastifyReply, message: string) =>
    sendError(reply, 409, "CONFLICT", message),
  internal: (reply: FastifyReply, message = "Internal server error", details?: unknown) =>
    sendError(reply, 500, "INTERNAL_ERROR", message, details),
  serviceUnavailable: (reply: FastifyReply, message = "Service unavailable") =>
    sendError(reply, 503, "SERVICE_UNAVAILABLE", message),
  badGateway: (reply: FastifyReply, message = "Bad gateway", details?: unknown) =>
    sendError(reply, 502, "BAD_GATEWAY", message, details),
  notImplemented: (reply: FastifyReply, message = "Not implemented") =>
    sendError(reply, 501, "NOT_IMPLEMENTED", message),
  // v3 Task 11 业务专有快捷工厂
  payloadTooLarge: (reply: FastifyReply, message: string, details?: unknown) =>
    sendError(reply, 413, "PAYLOAD_TOO_LARGE", message, details),
  serviceUninitialized: (reply: FastifyReply, message = "模块未初始化") =>
    sendError(reply, 501, "SERVICE_UNINITIALIZED", message),
  recursiveProtection: (reply: FastifyReply, message: string) =>
    sendError(reply, 403, "RECURSIVE_PROTECTION", message),
  builtinAgentImmutable: (reply: FastifyReply, message: string) =>
    sendError(reply, 403, "BUILTIN_AGENT_IMMUTABLE", message),
  costLimitExceeded: (reply: FastifyReply, message: string, details?: unknown) =>
    sendError(reply, 402, "COST_LIMIT_EXCEEDED", message, details),
  fileTooLarge: (reply: FastifyReply, message: string) =>
    sendError(reply, 413, "FILE_TOO_LARGE", message),
};
