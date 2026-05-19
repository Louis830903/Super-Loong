"""
v3 Task 11 — Python 微服务统一错误码

与 TS web-types/src/error-codes.ts 的 ApiErrorCode 联合类型 + ERROR_CODE_DICT 对齐。
Python 服务（im-gateway, kb-parser, video-forge）通过本模块产出统一的
{ success: false, error: { code, message } } 响应壳。
"""

from __future__ import annotations

from typing import Any, Literal, Optional
from fastapi.responses import JSONResponse

# ─── 字面量类型（Python 3.8+ Literal，运行时仅为普通 str）──────────
ApiErrorCode = Literal[
    # 4xx 客户端错误
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE_ENTITY",
    "VALIDATION_ERROR",
    "PAYLOAD_TOO_LARGE",
    "RATE_LIMITED",
    # 5xx 服务端错误
    "INTERNAL_ERROR",
    "NOT_IMPLEMENTED",
    "BAD_GATEWAY",
    "SERVICE_UNAVAILABLE",
    "GATEWAY_TIMEOUT",
    # IM 网关
    "GATEWAY_ERROR",
    "GATEWAY_NON_JSON",
    "GATEWAY_BRIDGE_ERROR",
    # 鉴权
    "INVALID_API_KEY",
    "INVALID_TOKEN",
    "TOKEN_EXPIRED",
    "INTERNAL_TOKEN_INVALID",
    "VAULT_UNAVAILABLE",
    # Schema
    "SCHEMA_VALIDATION_FAILED",
    # v3 Task 11 业务专有码
    "RECURSIVE_PROTECTION",
    "BUILTIN_AGENT_IMMUTABLE",
    "SERVICE_UNINITIALIZED",
    "STT_UNAVAILABLE",
    "STT_BACKEND_ERROR",
    "VIDEO_GENERATION_FAILED",
    "KB_PARSE_FAILED",
    "KB_FILE_TOO_LARGE",
    "FILE_TOO_LARGE",
    "COST_LIMIT_EXCEEDED",
    "SYMLINK_ESCAPE",
    "SENSITIVE_FILE",
]

# ─── 默认中文映射（前端 toast 兜底）────────────────────────────
ERROR_CODE_DICT: dict[ApiErrorCode, str] = {
    "BAD_REQUEST": "请求参数有误",
    "UNAUTHORIZED": "请先登录",
    "FORBIDDEN": "权限不足",
    "NOT_FOUND": "请求的资源不存在",
    "CONFLICT": "资源状态冲突",
    "UNPROCESSABLE_ENTITY": "数据无法处理",
    "VALIDATION_ERROR": "请求参数校验失败",
    "PAYLOAD_TOO_LARGE": "请求体过大",
    "RATE_LIMITED": "请求过于频繁，请稍后再试",
    "INTERNAL_ERROR": "服务内部错误",
    "NOT_IMPLEMENTED": "功能尚未实现",
    "BAD_GATEWAY": "上游服务异常",
    "SERVICE_UNAVAILABLE": "服务暂不可用",
    "GATEWAY_TIMEOUT": "上游服务超时",
    "GATEWAY_ERROR": "IM 网关异常",
    "GATEWAY_NON_JSON": "IM 网关返回非 JSON 响应",
    "GATEWAY_BRIDGE_ERROR": "IM 网桥异常",
    "INVALID_API_KEY": "API Key 无效",
    "INVALID_TOKEN": "Token 无效",
    "TOKEN_EXPIRED": "登录已过期，请重新登录",
    "INTERNAL_TOKEN_INVALID": "内部 Token 无效",
    "VAULT_UNAVAILABLE": "凭据保险柜不可用",
    "SCHEMA_VALIDATION_FAILED": "数据校验失败",
    "RECURSIVE_PROTECTION": "检测到递归调用，操作被阻止",
    "BUILTIN_AGENT_IMMUTABLE": "内置专家 Agent 不可直接修改或删除",
    "SERVICE_UNINITIALIZED": "功能模块未初始化",
    "STT_UNAVAILABLE": "语音识别服务暂不可用",
    "STT_BACKEND_ERROR": "语音识别后端错误",
    "VIDEO_GENERATION_FAILED": "视频生成失败",
    "KB_PARSE_FAILED": "知识库文档解析失败",
    "KB_FILE_TOO_LARGE": "知识库文件过大",
    "FILE_TOO_LARGE": "文件过大",
    "COST_LIMIT_EXCEEDED": "预估成本超出上限，请确认后重试",
    "SYMLINK_ESCAPE": "路径越权访问被阻止",
    "SENSITIVE_FILE": "敏感文件禁止访问",
}


def error_response(
    status_code: int,
    code: ApiErrorCode,
    message: Optional[str] = None,
    details: Any = None,
) -> JSONResponse:
    """
    构造标准化错误响应，与 TS sendError 对齐：
      { success: false, error: { code, message, details? } }

    @param status_code - HTTP 状态码
    @param code         - 错误码（强类型 ApiErrorCode）
    @param message      - 面向客户端的错误描述（缺省从字典取）
    @param details      - 可选的调试详请
    """
    body: dict[str, Any] = {
        "success": False,
        "error": {
            "code": code,
            "message": message or ERROR_CODE_DICT.get(code, "未知错误"),
        },
    }
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(status_code=status_code, content=body)
