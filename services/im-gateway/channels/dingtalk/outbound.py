"""
钉钉渠道 — 出站消息适配器（OutboundAdapter 实现）

发送方式：
1. session_webhook 回复：在消息回调中通过 webhook URL 即时回复（首选，0延迟）
2. 企业工作通知 API：通过 /topapi/message/corpconversation/asyncsend_v2 主动推送
3. 媒体发送：先上传到 /media/upload，再通过工作通知发送

参考 adapters/dingtalk.py（DingTalkMediaAdapter）的 API 调用逻辑。
"""

import logging
import time
from typing import Optional

import httpx

from core.types import ChannelConfig, SendResult, MediaPayload
from core.token_manager import TokenManager

logger = logging.getLogger("gateway.dingtalk.outbound")

# MediaKind → 钉钉 media type 映射
KIND_TO_DINGTALK_TYPE = {
    "image": "image",
    "audio": "voice",
    "video": "video",
    "document": "file",
    "file": "file",
}

# 钉钉消息最大文本长度（session_webhook 限制 2048 字节）
DINGTALK_MAX_TEXT_LENGTH = 2048


class DingTalkTokenManager(TokenManager):
    """钉钉 access_token 自动刷新管理器"""

    def __init__(self, appkey: str = "", appsecret: str = ""):
        super().__init__()
        self._appkey = appkey
        self._appsecret = appsecret

    def has_credentials(self) -> bool:
        return bool(self._appkey and self._appsecret)

    async def _fetch_token(self) -> tuple[str, int]:
        """从钉钉获取 access_token"""
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(
                "https://oapi.dingtalk.com/gettoken",
                params={"appkey": self._appkey, "appsecret": self._appsecret},
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"钉钉获取token失败: {data.get('errmsg', 'unknown')}")

        return data["access_token"], data.get("expires_in", 7200)


class DingTalkOutbound:
    """
    钉钉出站消息适配器 — 实现 OutboundAdapter Protocol

    支持两种发送模式：
    1. session_webhook：直接回复消息（低延迟，推荐）
    2. 工作通知 API：主动推送消息（需要 access_token + agent_id）
    """

    def __init__(self):
        self._config: Optional[ChannelConfig] = None
        self._token_manager: Optional[DingTalkTokenManager] = None
        self._client: Optional[httpx.AsyncClient] = None
        # 缓存最近一条消息的 session_webhook URL（由 gateway 回调设置）
        self._session_webhooks: dict[str, str] = {}  # chat_id → webhook_url

    def configure(self, config: ChannelConfig) -> None:
        """初始化配置（由 plugin 组装时调用）"""
        self._config = config
        appkey = config.credentials.get("app_key", "")
        appsecret = config.credentials.get("app_secret", "")
        self._token_manager = DingTalkTokenManager(appkey, appsecret)

    def set_session_webhook(self, chat_id: str, webhook_url: str) -> None:
        """缓存 session_webhook URL（由 gateway 消息回调设置）"""
        self._session_webhooks[chat_id] = webhook_url

    # ── OutboundAdapter Protocol ──

    async def send_text(self, chat_id: str, text: str, **kwargs) -> SendResult:
        """发送文本消息"""
        # 优先使用 session_webhook（如果有缓存）
        webhook_url = kwargs.get("session_webhook") or self._session_webhooks.get(chat_id)

        if webhook_url:
            return await self._send_via_webhook(webhook_url, text)

        # 回退到工作通知 API
        return await self._send_via_work_notice(chat_id, text)

    async def send_media(self, chat_id: str, payload: MediaPayload) -> SendResult:
        """发送媒体消息（上传+工作通知 API）"""
        try:
            client = await self._ensure_client()
            token = await self._token_manager.get_token()

            # 1. 上传媒体
            dingtalk_type = KIND_TO_DINGTALK_TYPE.get(payload.kind, "file")
            with open(payload.path, "rb") as f:
                resp = await client.post(
                    "https://oapi.dingtalk.com/media/upload",
                    params={"access_token": token, "type": dingtalk_type},
                    files={"media": (payload.filename, f, payload.mime_type)},
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("errcode", 0) != 0:
                return SendResult(success=False, error=f"上传失败: {data.get('errmsg')}")

            media_id = data.get("media_id", "")

            # 2. 发送工作通知
            msg = self._build_media_msg(dingtalk_type, media_id)
            agent_id = self._config.credentials.get("agent_id", "0") if self._config else "0"

            resp = await client.post(
                "https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2",
                params={"access_token": token},
                json={
                    "agent_id": agent_id,
                    "userid_list": chat_id,
                    "msg": msg,
                },
            )
            resp.raise_for_status()
            result = resp.json()

            success = result.get("errcode", -1) == 0
            if not success:
                return SendResult(success=False, error=f"发送失败: {result.get('errmsg')}")

            return SendResult(
                success=True,
                message_id=str(result.get("task_id", "")),
            )

        except Exception as e:
            logger.error("钉钉媒体发送异常: %s", e)
            return SendResult(success=False, error=str(e))

    def max_text_length(self) -> int:
        """钉钉消息最大文本长度"""
        return DINGTALK_MAX_TEXT_LENGTH

    # ── 内部方法 ──

    async def _send_via_webhook(self, webhook_url: str, text: str) -> SendResult:
        """通过 session_webhook 回复（低延迟）"""
        try:
            client = await self._ensure_client()
            resp = await client.post(
                webhook_url,
                json={"msgtype": "text", "text": {"content": text}},
            )
            resp.raise_for_status()
            return SendResult(success=True)
        except Exception as e:
            logger.warning("钉钉 webhook 回复失败，回退到工作通知: %s", e)
            return SendResult(success=False, error=str(e))

    async def _send_via_work_notice(self, chat_id: str, text: str) -> SendResult:
        """通过工作通知 API 发送"""
        try:
            if not self._token_manager:
                return SendResult(success=False, error="未配置 token 管理器")

            client = await self._ensure_client()
            token = await self._token_manager.get_token()
            agent_id = self._config.credentials.get("agent_id", "0") if self._config else "0"

            resp = await client.post(
                "https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2",
                params={"access_token": token},
                json={
                    "agent_id": agent_id,
                    "userid_list": chat_id,
                    "msg": {"msgtype": "text", "text": {"content": text}},
                },
            )
            resp.raise_for_status()
            result = resp.json()

            success = result.get("errcode", -1) == 0
            return SendResult(
                success=success,
                message_id=str(result.get("task_id", "")),
                error="" if success else result.get("errmsg", ""),
            )

        except Exception as e:
            logger.error("钉钉工作通知发送失败: %s", e)
            return SendResult(success=False, error=str(e))

    async def _ensure_client(self) -> httpx.AsyncClient:
        """确保 HTTP 客户端就绪"""
        if not self._client:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
        return self._client

    @staticmethod
    def _build_media_msg(dingtalk_type: str, media_id: str) -> dict:
        """构建钉钉媒体消息体"""
        if dingtalk_type == "image":
            return {"msgtype": "image", "image": {"media_id": media_id}}
        elif dingtalk_type == "voice":
            return {"msgtype": "voice", "voice": {"media_id": media_id}}
        elif dingtalk_type == "video":
            return {"msgtype": "video", "video": {"media_id": media_id}}
        else:
            return {"msgtype": "file", "file": {"media_id": media_id}}

    async def close(self) -> None:
        """关闭 HTTP 客户端"""
        if self._client:
            await self._client.aclose()
            self._client = None
