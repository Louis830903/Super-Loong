/**
 * v3 Task 11 — API 错误码字典 + i18n 中文映射
 *
 * @why 统一前后端错误码定义，避免硬编码字符串到处散；前端可按 code 映射
 *       多语言提示，后端响应壳的 error.code 一旦扩展只需在此处加字典。
 *
 * 设计：
 *   - 字面量联合类型 ApiErrorCode 锁住后端可发的码值（编译期校验）
 *   - ERROR_CODE_DICT 提供默认中文映射（前端 toast 兜底用）
 *   - 后端 response-helper.ts 的 Errors.* 工厂统一引用此字典
 *   - 双发期（rolloutDate-sunsetDate）：响应仍带 message 字段；闸门到期后
 *     message 改由前端按 code 自行映射
 */

// ─── 字面量联合类型（后端可发码值集合）──────────────────────────────────

export type ApiErrorCode =
  // 4xx 客户端错误
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE_ENTITY"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  // 5xx 服务端错误
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "BAD_GATEWAY"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_TIMEOUT"
  // 业务级（IM 网关代理）
  | "GATEWAY_ERROR"
  | "GATEWAY_NON_JSON"
  | "GATEWAY_BRIDGE_ERROR"
  // 业务级（鉴权 / 凭据）
  | "INVALID_API_KEY"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "INTERNAL_TOKEN_INVALID"
  | "VAULT_UNAVAILABLE"
  // 业务级（v3 Task 6 schema 校验）
  | "SCHEMA_VALIDATION_FAILED"
  // 业务级（v3 Task 11：子系统专有码）
  | "RECURSIVE_PROTECTION"
  | "BUILTIN_AGENT_IMMUTABLE"
  | "SERVICE_UNINITIALIZED"
  | "STT_UNAVAILABLE"
  | "STT_BACKEND_ERROR"
  | "VIDEO_GENERATION_FAILED"
  | "KB_PARSE_FAILED"
  | "KB_FILE_TOO_LARGE"
  | "FILE_TOO_LARGE"
  | "COST_LIMIT_EXCEEDED"
  | "SYMLINK_ESCAPE"
  | "SENSITIVE_FILE";

// ─── 默认中文映射（前端 toast 兜底）────────────────────────────────────

export const ERROR_CODE_DICT: Record<ApiErrorCode, string> = {
  // 4xx
  BAD_REQUEST: "请求参数有误",
  UNAUTHORIZED: "请先登录",
  FORBIDDEN: "权限不足",
  NOT_FOUND: "请求的资源不存在",
  CONFLICT: "资源状态冲突",
  UNPROCESSABLE_ENTITY: "数据无法处理",
  VALIDATION_ERROR: "请求参数校验失败",
  PAYLOAD_TOO_LARGE: "请求体过大",
  RATE_LIMITED: "请求过于频繁，请稍后再试",
  // 5xx
  INTERNAL_ERROR: "服务内部错误",
  NOT_IMPLEMENTED: "功能尚未实现",
  BAD_GATEWAY: "上游服务异常",
  SERVICE_UNAVAILABLE: "服务暂不可用",
  GATEWAY_TIMEOUT: "上游服务超时",
  // IM 网关
  GATEWAY_ERROR: "IM 网关异常",
  GATEWAY_NON_JSON: "IM 网关返回非 JSON 响应",
  GATEWAY_BRIDGE_ERROR: "IM 网桥异常",
  // 鉴权
  INVALID_API_KEY: "API Key 无效",
  INVALID_TOKEN: "Token 无效",
  TOKEN_EXPIRED: "登录已过期，请重新登录",
  INTERNAL_TOKEN_INVALID: "内部 Token 无效",
  VAULT_UNAVAILABLE: "凭据保险柜不可用",
  // Schema
  SCHEMA_VALIDATION_FAILED: "数据校验失败",
  // v3 Task 11 业务专有码
  RECURSIVE_PROTECTION: "检测到递归调用，操作被阻止",
  BUILTIN_AGENT_IMMUTABLE: "内置专家 Agent 不可直接修改或删除",
  SERVICE_UNINITIALIZED: "功能模块未初始化",
  STT_UNAVAILABLE: "语音识别服务暂不可用",
  STT_BACKEND_ERROR: "语音识别后端错误",
  VIDEO_GENERATION_FAILED: "视频生成失败",
  KB_PARSE_FAILED: "知识库文档解析失败",
  KB_FILE_TOO_LARGE: "知识库文件过大",
  FILE_TOO_LARGE: "文件过大",
  COST_LIMIT_EXCEEDED: "预估成本超出上限，请确认后重试",
  SYMLINK_ESCAPE: "路径越权访问被阻止",
  SENSITIVE_FILE: "敏感文件禁止访问",
};

// ─── HTTP status → 默认 code 反查（response-helper.ts 复用）─────────────

export const HTTP_STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_ENTITY",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  501: "NOT_IMPLEMENTED",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
};

/**
 * 前端 helper：根据 code 返回中文提示，未知码回退到 fallback。
 * @why 错误码 code+message 双发期内前端应优先用 code 查字典；message 仅作 fallback。
 */
export function describeErrorCode(code: string, fallback?: string): string {
  if (code in ERROR_CODE_DICT) {
    return ERROR_CODE_DICT[code as ApiErrorCode];
  }
  return fallback ?? `未知错误（${code}）`;
}
