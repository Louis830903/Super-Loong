"""
Super Agent IM Gateway - 结构化 JSON 日志系统

功能：
- JSON 格式输出（便于日志聚合工具收集）
- 子系统标记（gateway.server / gateway.health / gateway.bridge / gateway.adapter）
- 敏感信息自动脱敏（Token、API Key 等）
- 请求追踪 ID（从消息入站到回复出站的全链路 trace_id）
"""

import json
import logging
import re
import time
import uuid
from contextvars import ContextVar
from typing import Any, Optional


# ─── 全链路追踪 ID ───────────────────────────────────────────
# 使用 ContextVar 在同一异步请求内传递 trace_id
_trace_id: ContextVar[str] = ContextVar("trace_id", default="")


def new_trace_id() -> str:
    """生成新的追踪 ID 并设置到当前上下文"""
    tid = uuid.uuid4().hex[:12]
    _trace_id.set(tid)
    return tid


def get_trace_id() -> str:
    """获取当前上下文的追踪 ID"""
    return _trace_id.get()


def set_trace_id(tid: str) -> None:
    """手动设置追踪 ID（用于跨层传递）"""
    _trace_id.set(tid)


# ─── 敏感信息脱敏 ────────────────────────────────────────────

# 需要脱敏的关键词模式
_SENSITIVE_PATTERNS = [
    re.compile(r"(token|api_?key|secret|password|authorization|bearer)\s*[:=]\s*['\"]?(\S+)", re.IGNORECASE),
]

# 需要脱敏的字典键名
_SENSITIVE_KEYS = frozenset({
    "token", "api_key", "apiKey", "api-key", "secret", "password",
    "authorization", "bearer", "app_secret", "client_secret",
    "SUPER_AGENT_API_KEY", "IM_GATEWAY_API_KEY",
})


def _mask_value(value: str) -> str:
    """将敏感值脱敏为前4后4的掩码"""
    if len(value) <= 8:
        return "***"
    return f"{value[:4]}***{value[-4:]}"


def sanitize_data(data: Any) -> Any:
    """递归脱敏字典/列表中的敏感字段"""
    if isinstance(data, dict):
        result = {}
        for key, value in data.items():
            if key in _SENSITIVE_KEYS and isinstance(value, str) and value:
                result[key] = _mask_value(value)
            else:
                result[key] = sanitize_data(value)
        return result
    elif isinstance(data, (list, tuple)):
        return [sanitize_data(item) for item in data]
    elif isinstance(data, str):
        # 对字符串内容做正则脱敏
        text = data
        for pattern in _SENSITIVE_PATTERNS:
            text = pattern.sub(lambda m: f"{m.group(1)}=***", text)
        return text
    return data


# ─── JSON 日志格式化器 ───────────────────────────────────────

class StructuredFormatter(logging.Formatter):
    """结构化 JSON 日志格式化器"""

    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S.") + f"{int(record.msecs):03d}Z",
            "level": record.levelname,
            "subsystem": record.name,
            "message": record.getMessage(),
        }

        # 追加追踪 ID
        trace_id = get_trace_id()
        if trace_id:
            log_entry["trace_id"] = trace_id

        # 追加结构化附加字段（通过 extra 传入）
        extra_fields = getattr(record, "_structured_extra", None)
        if extra_fields and isinstance(extra_fields, dict):
            # 脱敏后追加
            sanitized = sanitize_data(extra_fields)
            log_entry.update(sanitized)

        # 异常信息
        if record.exc_info and record.exc_info[1]:
            log_entry["exception"] = {
                "type": type(record.exc_info[1]).__name__,
                "message": str(record.exc_info[1]),
            }

        return json.dumps(log_entry, ensure_ascii=False, default=str)


class TextFormatter(logging.Formatter):
    """人类可读的文本格式化器（开发模式用）"""

    def format(self, record: logging.LogRecord) -> str:
        trace_id = get_trace_id()
        trace_part = f" [{trace_id}]" if trace_id else ""
        ts = self.formatTime(record, "%H:%M:%S")

        # 追加结构化附加字段
        extra_fields = getattr(record, "_structured_extra", None)
        extra_part = ""
        if extra_fields and isinstance(extra_fields, dict):
            sanitized = sanitize_data(extra_fields)
            pairs = [f"{k}={v}" for k, v in sanitized.items()]
            if pairs:
                extra_part = " | " + ", ".join(pairs)

        return f"{ts} [{record.levelname}] {record.name}{trace_part}: {record.getMessage()}{extra_part}"


# ─── 结构化日志适配器 ────────────────────────────────────────

class StructuredLogger:
    """
    结构化日志包装器，支持附加字段和自动脱敏。

    用法：
        logger = create_logger("gateway.bridge")
        logger.info("消息已发送", platform="wecom", session_id="abc123")
        logger.error("发送失败", exc_info=True, error_code=500)
    """

    def __init__(self, logger: logging.Logger):
        self._logger = logger

    @property
    def name(self) -> str:
        return self._logger.name

    def _log(self, level: int, msg: str, exc_info: bool = False, **kwargs: Any) -> None:
        """内部日志方法，将 kwargs 作为结构化附加字段"""
        if not self._logger.isEnabledFor(level):
            return
        record = self._logger.makeRecord(
            name=self._logger.name,
            level=level,
            fn="",
            lno=0,
            msg=msg,
            args=(),
            exc_info=exc_info if exc_info else None,
        )
        if kwargs:
            record._structured_extra = kwargs  # type: ignore[attr-defined]
        self._logger.handle(record)

    def debug(self, msg: str, **kwargs: Any) -> None:
        self._log(logging.DEBUG, msg, **kwargs)

    def info(self, msg: str, **kwargs: Any) -> None:
        self._log(logging.INFO, msg, **kwargs)

    def warning(self, msg: str, **kwargs: Any) -> None:
        self._log(logging.WARNING, msg, **kwargs)

    def error(self, msg: str, exc_info: bool = False, **kwargs: Any) -> None:
        self._log(logging.ERROR, msg, exc_info=exc_info, **kwargs)

    def critical(self, msg: str, exc_info: bool = False, **kwargs: Any) -> None:
        self._log(logging.CRITICAL, msg, exc_info=exc_info, **kwargs)


# ─── 工厂函数 ────────────────────────────────────────────────

_initialized = False
_log_format: str = "text"  # 默认文本格式，生产环境可切换为 json


def setup_logging(log_format: str = "text", level: str = "INFO") -> None:
    """
    初始化全局日志配置（在 server.py 启动时调用一次）

    Args:
        log_format: "json" 或 "text"
        level: 日志级别 ("DEBUG", "INFO", "WARNING", "ERROR")
    """
    global _initialized, _log_format
    if _initialized:
        return

    _log_format = log_format
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # 清除已有 handler，避免重复输出
    root.handlers.clear()

    handler = logging.StreamHandler()
    if log_format == "json":
        handler.setFormatter(StructuredFormatter())
    else:
        handler.setFormatter(TextFormatter())

    root.addHandler(handler)

    # 抑制第三方库的 INFO 级日志（httpx 每次请求都输出 INFO，造成日志风暴）
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    _initialized = True


def create_logger(subsystem: str) -> StructuredLogger:
    """
    创建结构化日志器

    Args:
        subsystem: 子系统名称，如 "gateway.server", "gateway.bridge",
                   "gateway.health", "gateway.adapter", "gateway.reconnect"

    Returns:
        StructuredLogger 实例，支持 .info(msg, **extra_fields) 调用
    """
    return StructuredLogger(logging.getLogger(subsystem))
