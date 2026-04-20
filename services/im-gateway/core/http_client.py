"""
平台 HTTP 客户端基类 — 带 token 注入 + 重试

封装 httpx.AsyncClient，自动从 TokenManager 获取 token 注入请求头。
各渠道的 gateway/outbound/media 模块使用此客户端发起平台 API 请求。
"""

import logging
from typing import Optional

import httpx

from core.token_manager import TokenManager

logger = logging.getLogger("gateway.http")


class PlatformHttpClient:
    """
    平台 HTTP 客户端

    特性：
    - 自动从 TokenManager 获取 Bearer token
    - 统一超时控制（默认 30s）
    - 文件上传支持
    - 优雅关闭
    """

    def __init__(
        self,
        base_url: str,
        token_manager: Optional[TokenManager] = None,
        timeout: float = 30.0,
    ):
        self._base_url = base_url.rstrip("/")
        self._token_manager = token_manager
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    async def get(self, path: str, **kwargs) -> httpx.Response:
        """GET 请求（自动注入 token）"""
        headers = await self._auth_headers()
        return await self._client.get(
            f"{self._base_url}{path}", headers=headers, **kwargs
        )

    async def post(self, path: str, **kwargs) -> httpx.Response:
        """POST 请求（自动注入 token）"""
        headers = await self._auth_headers()
        return await self._client.post(
            f"{self._base_url}{path}", headers=headers, **kwargs
        )

    async def upload(
        self,
        path: str,
        file_data: bytes,
        filename: str,
        mime_type: str,
        **kwargs,
    ) -> httpx.Response:
        """文件上传"""
        headers = await self._auth_headers()
        files = {"file": (filename, file_data, mime_type)}
        return await self._client.post(
            f"{self._base_url}{path}", headers=headers, files=files, **kwargs
        )

    async def _auth_headers(self) -> dict:
        """获取认证头"""
        if self._token_manager:
            token = await self._token_manager.get_token()
            return {"Authorization": f"Bearer {token}"}
        return {}

    async def close(self) -> None:
        """关闭 HTTP 客户端"""
        await self._client.aclose()
        logger.debug("HTTP 客户端已关闭: %s", self._base_url)
