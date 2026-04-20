"""
渠道媒体适配器包（已废弃）
对标 OpenClaw extensions/ 渠道扩展模式

▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
⚠️ DEPRECATED: 本包已废弃，请使用 channels/ 插件和 core/ 基础模块
  - MediaPayload → core.types.MediaPayload
  - TokenManager → core.token_manager.TokenManager
  - PLATFORM_SIZE_LIMITS / get_size_limit → core.types
  - TOKEN_EXPIRED_CODES → core.token_manager.TOKEN_EXPIRED_CODES
‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾
"""

import warnings
warnings.warn(
    "adapters 包已废弃，请使用 channels/ 插件和 core/ 基础模块",
    DeprecationWarning,
    stacklevel=2,
)

from .base import (
    ChannelMediaAdapter,
    MediaPayload,
    TokenManager,
    AdapterError,
    PLATFORM_SIZE_LIMITS,
    get_size_limit,
    TOKEN_EXPIRED_CODES,
)

__all__ = [
    "ChannelMediaAdapter",
    "MediaPayload",
    "TokenManager",
    "AdapterError",
    "PLATFORM_SIZE_LIMITS",
    "get_size_limit",
    "TOKEN_EXPIRED_CODES",
]
