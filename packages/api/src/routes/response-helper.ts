/**
 * API 响应格式统一化工具
 *
 * P4-T2: 所有成功响应 → { success: true, data: ... }
 *        所有错误响应 → { success: false, error: { code, message, details? } }
 */

import type { FastifyReply } from "fastify";

/** 标准化成功响应 */
export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
}

/** 标准化错误响应 */
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

/**
 * 发送标准化成功响应
 */
export function sendSuccess<T>(reply: FastifyReply, data: T, statusCode = 200): FastifyReply {
  return reply.status(statusCode).send({ success: true, data } satisfies ApiSuccess<T>);
}

/**
 * 发送标准化错误响应
 *
 * @param reply - Fastify 回复对象
 * @param statusCode - HTTP 状态码
 * @param code - 错误码（如 "NOT_FOUND"）
 * @param message - 面向客户端的错误描述
 * @param details - 可选的调试详请（仅开发/非生产环境返回）
 * @param exposeToClient - 即使在生产环境也暴露原始消息，默认 false
 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
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
  return reply.status(statusCode).send({
    success: false,
    error: {
      code,
      message: safeMessage,
      ...(safeDetails !== undefined ? { details: safeDetails } : {}),
    },
  } satisfies ApiError);
}

/**
 * 快捷错误辅助
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
};
