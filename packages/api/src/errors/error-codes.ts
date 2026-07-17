/**
 * 错误码标准化 — 替代字符串匹配的错误分类
 *
 * 优化：
 * 1. 错误码注册表
 * 2. 支持国际化
 * 3. 文档生成
 */

import pino from "pino";

const logger = pino({ name: "error-codes" });

/**
 * 错误码注册表
 */
export const ErrorCodes = {
  // 客户端错误 4xx
  INVALID_REQUEST: { code: "INVALID_REQUEST", status: 400, message: "请求参数错误" },
  UNAUTHORIZED: { code: "UNAUTHORIZED", status: 401, message: "未授权访问" },
  FORBIDDEN: { code: "FORBIDDEN", status: 403, message: "禁止访问" },
  NOT_FOUND: { code: "NOT_FOUND", status: 404, message: "资源不存在" },
  VALIDATION_ERROR: { code: "VALIDATION_ERROR", status: 400, message: "数据验证失败" },
  RATE_LIMITED: { code: "RATE_LIMITED", status: 429, message: "请求过于频繁" },

  // 服务端错误 5xx
  INTERNAL_ERROR: { code: "INTERNAL_ERROR", status: 500, message: "内部服务器错误" },
  LLM_ERROR: { code: "LLM_ERROR", status: 502, message: "LLM 服务错误" },
  TIMEOUT: { code: "TIMEOUT", status: 504, message: "请求超时" },
  SERVICE_UNAVAILABLE: { code: "SERVICE_UNAVAILABLE", status: 503, message: "服务不可用" },
  DATABASE_ERROR: { code: "DATABASE_ERROR", status: 500, message: "数据库错误" },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

/**
 * 应用错误类
 */
export class AppError extends Error {
  constructor(
    public errorCode: ErrorCode,
    message?: string,
    public details?: Record<string, unknown>,
  ) {
    const def = ErrorCodes[errorCode];
    super(message ?? def.message);
    this.name = "AppError";
  }

  get statusCode(): number {
    return ErrorCodes[this.errorCode].status;
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.errorCode,
        message: this.message,
        details: this.details,
      },
    };
  }
}

/**
 * 错误处理中间件
 */
export function errorHandler(error: unknown, request: any, reply: any) {
  // 已知错误
  if (error instanceof AppError) {
    logger.warn({ code: error.errorCode, details: error.details }, error.message);
    return reply.status(error.statusCode).send(error.toJSON());
  }

  // Fastify 错误
  if (error && typeof error === "object" && "statusCode" in error) {
    const err = error as any;
    logger.warn({ statusCode: err.statusCode }, err.message);
    return reply.status(err.statusCode).send({
      success: false,
      error: {
        code: err.code ?? "UNKNOWN",
        message: err.message,
      },
    });
  }

  // 未知错误
  logger.error(error, "Unhandled error");
  return reply.status(500).send({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "内部服务器错误",
    },
  });
}

/**
 * 生成错误码文档
 */
export function generateErrorDocs(): string {
  const lines = ["# API 错误码文档", ""];
  lines.push("| 错误码 | HTTP 状态 | 说明 |");
  lines.push("|--------|-----------|------|");

  for (const [key, def] of Object.entries(ErrorCodes)) {
    lines.push(`| ${def.code} | ${def.status} | ${def.message} |`);
  }

  return lines.join("\n");
}
