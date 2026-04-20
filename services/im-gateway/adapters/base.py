# -*- coding: utf-8 -*-
"""
渠道媒体适配器抽象基类
对标 OpenClaw 渠道扩展模式 - 每个渠道独立实现 upload_media + send_media

改进:
- [P0] TokenManager: 自动获取/缓存/刷新 access_token (过期前主动刷新)
- [P0] _request_with_retry: 检测 token 过期错误码 -> 自动刷新 -> 重试
- [P1] send_with_fallback: 保留原始异常信息, 结构化错误返回
- [P1] rate limit 指数退避重试
- [P2] 请求耗时结构化日志
"""

import asyncio
import logging
import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Set

logger = logging.getLogger("im-gateway.adapters")


# ─── 各平台文件大小限制 (字节) ─────────────────────────────
# 官方文档标准, 按平台+类型区分, bridge.py 中使用
PLATFORM_SIZE_LIMITS: Dict[str, Dict[str, int]] = {
    "wecom": {
        "image": 10 * 1024 * 1024,      # 10MB
        "audio": 2 * 1024 * 1024,       # 2MB
        "video": 10 * 1024 * 1024,      # 10MB
        "document": 20 * 1024 * 1024,   # 20MB
        "file": 20 * 1024 * 1024,       # 20MB
    },
    "feishu": {
        "image": 10 * 1024 * 1024,      # 10MB
        "audio": 30 * 1024 * 1024,      # 飞书文件统一 30MB
        "video": 30 * 1024 * 1024,      # 30MB
        "document": 30 * 1024 * 1024,   # 30MB
        "file": 30 * 1024 * 1024,       # 30MB
    },
    "dingtalk": {
        "image": 20 * 1024 * 1024,      # 20MB (官方实际支持)
        "audio": 2 * 1024 * 1024,       # 2MB
        "video": 20 * 1024 * 1024,      # 20MB
        "document": 20 * 1024 * 1024,   # 20MB
        "file": 20 * 1024 * 1024,       # 20MB
    },
}

# 各平台未配置时的全局回退限制
DEFAULT_SIZE_LIMIT = 5 * 1024 * 1024  # 5MB


def get_size_limit(platform: str, kind: str) -> int:
    """获取指定平台+类型的文件大小限制 (字节)"""
    limits = PLATFORM_SIZE_LIMITS.get(platform, {})
    return limits.get(kind, DEFAULT_SIZE_LIMIT)


# ─── 各平台 token 过期错误码 ──────────────────────────────
# 检测到这些错误码时自动刷新 token 并重试
TOKEN_EXPIRED_CODES: Dict[str, Set[int]] = {
    "wecom": {42001, 40014},       # access_token 已过期 / 不合法
    "feishu": {99991663, 99991664},  # token invalid / expired
    "dingtalk": {88, 40014},       # token 过期 / 不合法
}


@dataclass
class MediaPayload:
    """渠道发送用的媒体数据"""
    path: str                  # 本地文件绝对路径
    kind: str                  # image/video/audio/document/file
    mime_type: str             # MIME 类型
    filename: str              # 文件名
    caption: str = ""          # 附件说明/标题
    size: int = 0              # 文件大小 (字节)

    def __post_init__(self):
        if not self.size and os.path.isfile(self.path):
            self.size = os.path.getsize(self.path)


@dataclass
class AdapterError:
    """结构化错误信息 - 调用方可区分错误类型"""
    error_type: str            # token_expired / rate_limited / platform_error / network_error
    error_code: int = 0        # 平台错误码
    message: str = ""          # 错误描述
    retryable: bool = False    # 是否可重试


# ─── Token 管理基类 ───────────────────────────────────────

class TokenManager(ABC):
    """
    Token 自动刷新管理器 - 解决所有平台 access_token 2小时过期问题

    特性:
    - 缓存 token, 过期前 5 分钟自动刷新
    - asyncio.Lock 保证并发安全
    - 支持手动传入静态 token (兼容旧配置)
    """

    def __init__(self, static_token: str = ""):
        self._static_token = static_token   # 兼容旧的静态 token 配置
        self._cached_token: str = ""
        self._expires_at: float = 0.0       # Unix timestamp
        self._lock = asyncio.Lock()
        # 提前 5 分钟刷新, 避免在请求过程中过期
        self._refresh_margin: float = 300.0

    @abstractmethod
    async def _fetch_token(self) -> tuple[str, int]:
        """
        从平台获取新 token。

        Returns:
            (access_token, expires_in_seconds)
        """
        ...

    def has_credentials(self) -> bool:
        """
        是否配置了自动获取 token 所需的凭证 (corpid+secret 等)。
        子类应覆写此方法。未配置时回退到静态 token。
        """
        return False

    async def get_token(self) -> str:
        """
        获取有效的 access_token。
        如果配置了凭证, 自动获取+缓存+刷新;
        否则回退到静态 token。
        """
        # 没有凭证时使用静态 token
        if not self.has_credentials():
            return self._static_token

        # 未过期直接返回缓存
        if self._cached_token and time.time() < self._expires_at - self._refresh_margin:
            return self._cached_token

        # 加锁刷新 (并发安全)
        async with self._lock:
            # double-check: 可能其他协程已经刷新
            if self._cached_token and time.time() < self._expires_at - self._refresh_margin:
                return self._cached_token

            try:
                token, expires_in = await self._fetch_token()
                self._cached_token = token
                self._expires_at = time.time() + expires_in
                logger.info(
                    "[TokenManager] Token refreshed, expires in %ds",
                    expires_in,
                )
                return self._cached_token
            except Exception as e:
                logger.error("[TokenManager] Failed to refresh token: %s", e)
                # 刷新失败时回退到旧 token (可能已过期但聊胜于无)
                if self._cached_token:
                    return self._cached_token
                return self._static_token

    async def force_refresh(self) -> str:
        """强制刷新 token (用于检测到 token 过期错误码后的重试)"""
        if not self.has_credentials():
            return self._static_token
        async with self._lock:
            try:
                token, expires_in = await self._fetch_token()
                self._cached_token = token
                self._expires_at = time.time() + expires_in
                logger.info("[TokenManager] Token force-refreshed")
                return self._cached_token
            except Exception as e:
                logger.error("[TokenManager] Force refresh failed: %s", e)
                return self._cached_token or self._static_token


# ─── 渠道适配器抽象基类 ───────────────────────────────────

class ChannelMediaAdapter(ABC):
    """
    渠道媒体适配器抽象基类 - 对标 OpenClaw 渠道扩展模式

    每个 IM 渠道 (企业微信/飞书/钉钉) 需实现:
    - upload_media: 上传媒体到渠道平台，返回 media_id
    - send_media: 向指定聊天发送媒体
    - platform_name: 渠道标识
    - token_manager: Token 自动刷新管理
    """

    @property
    @abstractmethod
    def platform_name(self) -> str:
        """渠道标识 (wecom/feishu/dingtalk)"""
        ...

    @abstractmethod
    async def upload_media(self, payload: MediaPayload) -> str:
        """
        上传媒体到渠道平台，返回 media_id

        不同渠道有不同的上传 API:
        - 企业微信: POST /cgi-bin/media/upload
        - 飞书: POST /open-apis/im/v1/images (图片) / im/v1/files (文件)
        - 钉钉: POST /media/upload
        """
        ...

    @abstractmethod
    async def send_media(
        self,
        chat_id: str,
        payload: MediaPayload,
        media_id: Optional[str] = None,
    ) -> bool:
        """
        向指定聊天发送媒体

        Args:
            chat_id: 目标聊天 ID
            payload: 媒体数据
            media_id: 已上传的 media_id (如果之前已调用 upload_media)

        Returns:
            是否发送成功
        """
        ...

    def supports_kind(self, kind: str) -> bool:
        """检查渠道是否支持该媒体类型"""
        return kind in ("image", "video", "audio", "document", "file")

    def _is_token_expired_error(self, error_code: int) -> bool:
        """判断错误码是否为 token 过期 (子类可覆写)"""
        expired_codes = TOKEN_EXPIRED_CODES.get(self.platform_name, set())
        return error_code in expired_codes

    async def send_with_fallback(
        self,
        chat_id: str,
        payload: MediaPayload,
    ) -> bool:
        """
        发送媒体（带降级策略 + 结构化错误保留）

        优先尝试原始类型发送，如果渠道不支持该类型，
        则降级为文件类型发送。降级失败时保留原始异常信息。
        """
        original_error: Optional[Exception] = None
        start_time = time.time()

        if self.supports_kind(payload.kind):
            try:
                media_id = await self.upload_media(payload)
                result = await self.send_media(chat_id, payload, media_id)
                elapsed = time.time() - start_time
                logger.info(
                    "[%s] send_with_fallback OK: %s (%s) in %.2fs",
                    self.platform_name, payload.filename, payload.kind, elapsed,
                )
                return result
            except Exception as e:
                original_error = e
                logger.warning(
                    "[%s] Failed to send %s as %s, falling back to file: %s",
                    self.platform_name, payload.filename, payload.kind, e,
                )

        # 降级: 作为普通文件发送
        fallback = MediaPayload(
            path=payload.path,
            kind="file",
            mime_type=payload.mime_type,
            filename=payload.filename,
            caption=payload.caption,
            size=payload.size,
        )
        try:
            media_id = await self.upload_media(fallback)
            result = await self.send_media(chat_id, fallback, media_id)
            elapsed = time.time() - start_time
            logger.info(
                "[%s] send_with_fallback (file fallback) OK: %s in %.2fs",
                self.platform_name, payload.filename, elapsed,
            )
            return result
        except Exception as e:
            elapsed = time.time() - start_time
            # 保留原始异常信息, 便于调用方诊断
            detail = f"Original error: {original_error}" if original_error else ""
            logger.error(
                "[%s] send_with_fallback FAILED: %s (%.2fs). Fallback error: %s. %s",
                self.platform_name, payload.filename, elapsed, e, detail,
            )
            return False
