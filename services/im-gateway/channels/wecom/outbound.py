"""
企业微信渠道 — 出站消息 + 媒体适配器（OutboundAdapter 实现）

发送方式：
1. 应用消息 API：POST /cgi-bin/message/send（主要方式）
2. 媒体发送：先 POST /cgi-bin/media/upload 上传，再发送消息

参考 adapters/wecom.py（WeComMediaAdapter）+ Hermes wecom.py 的 API 调用逻辑。
"""

import logging
import time
from typing import Optional

import httpx

from core.types import ChannelConfig, SendResult, MediaPayload
from core.token_manager import TokenManager, TOKEN_EXPIRED_CODES

logger = logging.getLogger("gateway.wecom.outbound")

# MediaKind → 企微 media type 映射
KIND_TO_WECOM_TYPE = {
    "image": "image",
    "audio": "voice",
    "video": "video",
    "document": "file",
    "file": "file",
}

# 企微消息最大文本长度
WECOM_MAX_TEXT_LENGTH = 2048

# 企微 Token 过期错误码（从 core.token_manager 统一获取）
_WECOM_EXPIRED_CODES = TOKEN_EXPIRED_CODES.get("wecom", set())


class WeComTokenManager(TokenManager):
    """企微 access_token 自动刷新管理器"""

    def __init__(self, corpid: str = "", corpsecret: str = ""):
        super().__init__()
        self._corpid = corpid
        self._corpsecret = corpsecret

    def has_credentials(self) -> bool:
        return bool(self._corpid and self._corpsecret)

    async def _fetch_token(self) -> tuple[str, int]:
        """从企微获取 access_token"""
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(
                "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
                params={"corpid": self._corpid, "corpsecret": self._corpsecret},
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"企微获取token失败: {data.get('errmsg', 'unknown')}")

        return data["access_token"], data.get("expires_in", 7200)


class WeComOutbound:
    """
    企微出站消息适配器 — 实现 OutboundAdapter Protocol

    通过企微应用消息 API 发送文本和媒体消息。
    Token 过期时自动刷新并重试。
    """

    BASE_URL = "https://qyapi.weixin.qq.com"

    def __init__(self):
        self._config: Optional[ChannelConfig] = None
        self._token_manager: Optional[WeComTokenManager] = None
        self._client: Optional[httpx.AsyncClient] = None

    def configure(self, config: ChannelConfig) -> None:
        """初始化配置"""
        self._config = config
        corpid = config.credentials.get("corp_id", "")
        corpsecret = config.credentials.get("app_secret", "")
        self._token_manager = WeComTokenManager(corpid, corpsecret)

    # ── OutboundAdapter Protocol ──

    async def send_text(self, chat_id: str, text: str, **kwargs) -> SendResult:
        """发送文本消息"""
        agent_id = self._config.credentials.get("agent_id", "0") if self._config else "0"

        msg_body = {
            "touser": chat_id,
            "msgtype": "text",
            "agentid": agent_id,
            "text": {"content": text},
            "safe": 0,
            "enable_duplicate_check": 0,
        }

        return await self._send_message(msg_body)

    async def send_media(self, chat_id: str, payload: MediaPayload) -> SendResult:
        """发送媒体消息"""
        try:
            # 1. 上传媒体
            media_id = await self._upload_media(payload)
            if not media_id:
                return SendResult(success=False, error="媒体上传失败")

            # 2. 发送消息
            agent_id = self._config.credentials.get("agent_id", "0") if self._config else "0"
            wecom_type = KIND_TO_WECOM_TYPE.get(payload.kind, "file")

            msg_body = {
                "touser": chat_id,
                "msgtype": wecom_type,
                "agentid": agent_id,
                wecom_type: {"media_id": media_id},
                "safe": 0,
                "enable_duplicate_check": 0,
            }

            return await self._send_message(msg_body)

        except Exception as e:
            logger.error("企微媒体发送异常: %s", e)
            return SendResult(success=False, error=str(e))

    def max_text_length(self) -> int:
        return WECOM_MAX_TEXT_LENGTH

    # ── 内部方法 ──

    async def _send_message(self, msg_body: dict) -> SendResult:
        """发送消息（带 token 过期重试）"""
        try:
            data = await self._request_with_retry(
                "post", "/cgi-bin/message/send", json=msg_body
            )
            success = data.get("errcode", -1) == 0
            return SendResult(
                success=success,
                message_id=str(data.get("msgid", "")),
                error="" if success else data.get("errmsg", ""),
            )
        except Exception as e:
            logger.error("企微发送失败: %s", e)
            return SendResult(success=False, error=str(e))

    async def _upload_media(self, payload: MediaPayload) -> str:
        """上传临时素材"""
        wecom_type = KIND_TO_WECOM_TYPE.get(payload.kind, "file")

        with open(payload.path, "rb") as f:
            data = await self._request_with_retry(
                "post",
                "/cgi-bin/media/upload",
                params={"type": wecom_type},
                files={"media": (payload.filename, f, payload.mime_type)},
            )

        if data.get("errcode", 0) != 0:
            logger.error("企微上传失败: %s", data.get("errmsg"))
            return ""

        media_id = data.get("media_id", "")
        logger.info("企微媒体已上传: %s → %s", payload.filename, media_id)
        return media_id

    async def _request_with_retry(self, method: str, path: str, **kwargs) -> dict:
        """带 token 过期重试的 API 请求"""
        client = await self._ensure_client()
        token = await self._token_manager.get_token()

        params = kwargs.pop("params", {}) or {}
        params["access_token"] = token
        kwargs["params"] = params

        start = time.time()
        resp = await getattr(client, method)(f"{self.BASE_URL}{path}", **kwargs)
        resp.raise_for_status()
        data = resp.json()

        # 检测 token 过期 → 刷新 + 重试
        errcode = data.get("errcode", 0)
        if errcode in _WECOM_EXPIRED_CODES:
            logger.warning("企微 Token 过期 (errcode=%d)，刷新中...", errcode)
            new_token = await self._token_manager.force_refresh()
            kwargs["params"]["access_token"] = new_token
            resp = await getattr(client, method)(f"{self.BASE_URL}{path}", **kwargs)
            resp.raise_for_status()
            data = resp.json()

        elapsed = time.time() - start
        logger.debug("企微 %s %s → errcode=%s (%.2fs)", method.upper(), path, data.get("errcode", 0), elapsed)
        return data

    async def _ensure_client(self) -> httpx.AsyncClient:
        if not self._client:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
