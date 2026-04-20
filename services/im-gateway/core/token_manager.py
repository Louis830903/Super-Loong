"""
Token 自动刷新管理器 — 从 adapters/base.py 提取的核心基类

解决所有平台 access_token 2小时过期问题：
- 缓存 token，过期前 5 分钟自动刷新
- asyncio.Lock 保证并发安全
- 支持手动传入静态 token（兼容旧配置）
- double-check 机制避免并发重连

各平台子类需实现 _fetch_token()，例如：
  WeComTokenManager → GET /cgi-bin/gettoken
  FeishuTokenManager → POST /open-apis/auth/v3/tenant_access_token/internal
  DingTalkTokenManager → GET /gettoken
"""

import asyncio
import time
import logging
from abc import ABC, abstractmethod
from typing import Set, Dict

logger = logging.getLogger("gateway.token")


# 各平台 token 过期错误码
TOKEN_EXPIRED_CODES: Dict[str, Set[int]] = {
    "wecom": {42001, 40014},       # access_token 已过期 / 不合法
    "feishu": {99991663, 99991664},  # token invalid / expired
    "dingtalk": {88, 40014},       # token 过期 / 不合法
}


class TokenManager(ABC):
    """
    Token 自动刷新管理器

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
        从平台获取新 token

        Returns:
            (token, expires_in_seconds)
        """
        ...

    async def get_token(self) -> str:
        """
        获取有效 token（自动刷新）

        Returns:
            当前有效的 access_token
        """
        # 静态 token 直接返回
        if self._static_token:
            return self._static_token

        # 检查是否需要刷新
        if self._cached_token and time.time() < (self._expires_at - self._refresh_margin):
            return self._cached_token

        # 并发安全刷新
        async with self._lock:
            # double-check: 另一个协程可能已经刷新了
            if self._cached_token and time.time() < (self._expires_at - self._refresh_margin):
                return self._cached_token

            token, expires_in = await self._fetch_token()
            self._cached_token = token
            self._expires_at = time.time() + expires_in
            logger.info("Token 已刷新, 有效期 %ds", expires_in)
            return token

    async def force_refresh(self) -> str:
        """
        强制刷新 token（用于检测到 token 过期错误码时）

        Returns:
            新的 access_token
        """
        async with self._lock:
            token, expires_in = await self._fetch_token()
            self._cached_token = token
            self._expires_at = time.time() + expires_in
            logger.info("Token 已强制刷新, 有效期 %ds", expires_in)
            return token

    def invalidate(self) -> None:
        """标记当前 token 无效"""
        self._cached_token = ""
        self._expires_at = 0.0

    @property
    def is_expired(self) -> bool:
        """当前 token 是否已过期"""
        if self._static_token:
            return False
        return not self._cached_token or time.time() >= self._expires_at
