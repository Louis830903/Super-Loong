"""
微信渠道 — 出站消息 + 媒体适配器（OutboundAdapter 实现）

通过 iLink Bot API 发送消息和媒体。
"""

import logging
from typing import Optional

import httpx

from core.types import ChannelConfig, SendResult, MediaPayload

logger = logging.getLogger("gateway.weixin.outbound")

WEIXIN_MAX_TEXT_LENGTH = 4096


class WeixinOutbound:
    """
    微信出站消息适配器 — 实现 OutboundAdapter Protocol

    通过 iLink Bot API 发送文本和媒体消息。
    """

    def __init__(self):
        self._config: Optional[ChannelConfig] = None
        self._client: Optional[httpx.AsyncClient] = None

    def configure(self, config: ChannelConfig) -> None:
        """初始化配置"""
        self._config = config
        api_url = config.credentials.get("api_url", "").rstrip("/")
        api_token = config.credentials.get("api_token", "")
        self._client = httpx.AsyncClient(
            base_url=api_url,
            timeout=httpx.Timeout(30.0),
            headers={"Authorization": f"Bearer {api_token}"},
        )

    # ── OutboundAdapter Protocol ──

    async def send_text(self, chat_id: str, text: str, **kwargs) -> SendResult:
        """发送文本消息"""
        try:
            client = await self._ensure_client()
            resp = await client.post(
                "/api/messages/send",
                json={
                    "chat_id": chat_id,
                    "type": "text",
                    "content": text,
                },
            )
            data = resp.json()
            success = data.get("success", False)
            return SendResult(
                success=success,
                message_id=data.get("msg_id", ""),
                error="" if success else data.get("error", ""),
            )
        except Exception as e:
            logger.error("微信发送文本失败: %s", e)
            return SendResult(success=False, error=str(e))

    async def send_media(self, chat_id: str, payload: MediaPayload) -> SendResult:
        """发送媒体消息"""
        try:
            client = await self._ensure_client()

            # 通过 iLink Bot API 上传+发送媒体
            with open(payload.path, "rb") as f:
                resp = await client.post(
                    "/api/messages/send-media",
                    data={
                        "chat_id": chat_id,
                        "type": payload.kind,
                        "filename": payload.filename,
                    },
                    files={"file": (payload.filename, f, payload.mime_type)},
                )
                data = resp.json()

            success = data.get("success", False)
            return SendResult(
                success=success,
                message_id=data.get("msg_id", ""),
                error="" if success else data.get("error", ""),
            )

        except Exception as e:
            logger.error("微信发送媒体失败: %s", e)
            return SendResult(success=False, error=str(e))

    def max_text_length(self) -> int:
        return WEIXIN_MAX_TEXT_LENGTH

    # ── 内部方法 ──

    async def _ensure_client(self) -> httpx.AsyncClient:
        if not self._client:
            raise RuntimeError("微信 outbound 未初始化，请先调用 configure()")
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
