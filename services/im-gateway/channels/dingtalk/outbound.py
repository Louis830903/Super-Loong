"""
钉钉渠道 — 出站消息适配器（OutboundAdapter 实现）

发送方式：
1. session_webhook 回复：在消息回调中通过 webhook URL 即时回复（首选，0延迟）
2. 机器人 API（新 OAuth 2.0）：通过 api.dingtalk.com 的 robot API 主动推送
   - 私聊: POST /v1.0/robot/oToMessages/batchSend
   - 群聊: POST /v1.0/robot/groupMessages/send
3. 媒体发送：先上传到 oapi.dingtalk.com/media/upload（旧端点仍可用），
   再通过机器人 API 发送（msgKey + msgParam 格式）

已从旧的 oapi.dingtalk.com/gettoken + corpconversation/asyncsend_v2 全面升级到
api.dingtalk.com + OAuth 2.0 标准。参考 jiuwenclaw/dingding.py。
"""

import json
import logging
import os
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
        """从钉钉获取 access_token（新 OAuth 2.0 API）"""
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.post(
                "https://api.dingtalk.com/v1.0/oauth2/accessToken",
                json={"appKey": self._appkey, "appSecret": self._appsecret},
            )
            resp.raise_for_status()
            data = resp.json()

        # 新 API 返回 accessToken（驼峰命名），失败时无 errcode 字段
        token = data.get("accessToken", "")
        if not token:
            raise RuntimeError(
                f"钉钉获取token失败: {data.get('message', 'unknown')}"
            )

        expires_in = data.get("expireIn", 7200)
        return token, expires_in


class DingTalkOutbound:
    """
    钉钉出站消息适配器 — 实现 OutboundAdapter Protocol

    支持两种发送模式：
    1. session_webhook：直接回复消息（低延迟，推荐）
    2. 机器人 API（新 OAuth 2.0）：主动推送消息（需 robot_code + accessToken）
       - 私聊：POST /v1.0/robot/oToMessages/batchSend
       - 群聊：POST /v1.0/robot/groupMessages/send
    """

    def __init__(self):
        self._config: Optional[ChannelConfig] = None
        self._token_manager: Optional[DingTalkTokenManager] = None
        self._client: Optional[httpx.AsyncClient] = None
        # 缓存最近一条消息的 session_webhook URL（由 gateway 回调设置）
        self._session_webhooks: dict[str, str] = {}  # chat_id → webhook_url
        # 缓存会话类型（由 gateway 回调设置，供出站选择私聊/群聊 API）
        self._conversation_types: dict[str, str] = {}  # chat_id → conversation_type

    def configure(self, config: ChannelConfig) -> None:
        """初始化配置（由 plugin 组装时调用）"""
        self._config = config
        appkey = config.credentials.get("app_key", "")
        appsecret = config.credentials.get("app_secret", "")
        self._token_manager = DingTalkTokenManager(appkey, appsecret)

    def set_session_webhook(self, chat_id: str, webhook_url: str) -> None:
        """缓存 session_webhook URL（由 gateway 消息回调设置）"""
        self._session_webhooks[chat_id] = webhook_url

    def set_conversation_type(self, chat_id: str, conversation_type: str) -> None:
        """缓存会话类型（供出站时选择正确的发送 API）"""
        self._conversation_types[chat_id] = conversation_type

    @staticmethod
    def _auth_headers(token: str) -> dict[str, str]:
        """构建新 API 的认证请求头（OAuth 2.0 Bearer Token）"""
        return {"x-acs-dingtalk-access-token": token}

    # ── OutboundAdapter Protocol ──

    async def send_text(self, chat_id: str, text: str, **kwargs) -> SendResult:
        """发送文本消息"""
        # 优先使用 session_webhook（如果有缓存）
        webhook_url = kwargs.get("session_webhook") or self._session_webhooks.get(chat_id)

        if webhook_url:
            return await self._send_via_webhook(webhook_url, text)

        # 回退到机器人 API（新接口，需区分私聊/群聊）
        conversation_type = kwargs.get("conversation_type") or self._conversation_types.get(chat_id, "1")
        return await self._send_via_robot_api(chat_id, text, conversation_type)

    async def send_media(self, chat_id: str, payload: MediaPayload) -> SendResult:
        """发送媒体消息（旧上传端点 + 新机器人发送 API）"""
        try:
            if not self._token_manager:
                return SendResult(success=False, error="未配置 token 管理器")

            client = await self._ensure_client()
            token = await self._token_manager.get_token()

            # 1. 上传媒体（保留旧端点，jiuwenclaw 也是如此，media_id 可直接用于新 API）
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

            # 2. 构建新机器人 API 的 msgKey + msgParam
            msg_key, msg_param = self._build_media_msg_param(dingtalk_type, media_id, payload.filename)

            # 3. 根据会话类型选择发送端点
            conversation_type = self._conversation_types.get(chat_id, "1")
            robot_code = self._config.credentials.get("robot_code", "") if self._config else ""

            if conversation_type == "2":
                url = "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
                body = {
                    "robotCode": robot_code,
                    "openConversationId": chat_id,
                    "msgKey": msg_key,
                    "msgParam": msg_param,
                }
            else:
                url = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
                body = {
                    "robotCode": robot_code,
                    "userIds": [chat_id],
                    "msgKey": msg_key,
                    "msgParam": msg_param,
                }

            resp = await client.post(
                url,
                json=body,
                headers=self._auth_headers(token),
            )

            if resp.status_code != 200:
                error_msg = f"HTTP {resp.status_code}: {resp.text}"
                logger.error("钉钉媒体发送失败: %s", error_msg)
                return SendResult(success=False, error=error_msg)

            result = resp.json()
            return SendResult(
                success=True,
                message_id=result.get("processQueryKey", ""),
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

    async def _send_via_robot_api(
        self, chat_id: str, text: str, conversation_type: str = "1"
    ) -> SendResult:
        """通过钉钉新版机器人 API 发送消息

        新 API 区分私聊和群聊两个端点：
        - 私聊 (conversation_type="1"): POST /v1.0/robot/oToMessages/batchSend
        - 群聊 (conversation_type="2"): POST /v1.0/robot/groupMessages/send
        """
        try:
            if not self._token_manager:
                return SendResult(success=False, error="未配置 token 管理器")

            client = await self._ensure_client()
            token = await self._token_manager.get_token()
            robot_code = self._config.credentials.get("robot_code", "") if self._config else ""

            # 消息内容：使用 sampleMarkdown 格式（支持富文本，兼容纯文本）
            msg_param = json.dumps({
                "text": text,
                "title": "Super Agent",
            })

            if conversation_type == "2":
                # 群聊：需要 openConversationId
                url = "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
                body = {
                    "robotCode": robot_code,
                    "openConversationId": chat_id,
                    "msgKey": "sampleMarkdown",
                    "msgParam": msg_param,
                }
            else:
                # 私聊：需要 userIds 列表
                url = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend"
                body = {
                    "robotCode": robot_code,
                    "userIds": [chat_id],
                    "msgKey": "sampleMarkdown",
                    "msgParam": msg_param,
                }

            resp = await client.post(
                url,
                json=body,
                headers=self._auth_headers(token),
            )

            if resp.status_code != 200:
                error_msg = f"HTTP {resp.status_code}: {resp.text}"
                logger.error("钉钉机器人 API 发送失败: %s", error_msg)
                return SendResult(success=False, error=error_msg)

            result = resp.json()
            # 新 API 成功时不返回 processQueryKey 等字段即表示成功
            logger.debug("钉钉消息已发送: chat=%s type=%s", chat_id, conversation_type)
            return SendResult(
                success=True,
                message_id=result.get("processQueryKey", ""),
            )

        except Exception as e:
            logger.error("钉钉机器人 API 发送异常: %s", e)
            return SendResult(success=False, error=str(e))

    async def _ensure_client(self) -> httpx.AsyncClient:
        """确保 HTTP 客户端就绪"""
        if not self._client:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
        return self._client

    @staticmethod
    def _build_media_msg_param(dingtalk_type: str, media_id: str, filename: str = "") -> tuple[str, str]:
        """构建新机器人 API 的 msgKey + msgParam（JSON 字符串）"""
        if dingtalk_type == "image":
            return "sampleImageMsg", json.dumps({"photoURL": media_id})
        elif dingtalk_type == "voice":
            return "sampleAudio", json.dumps({"mediaId": media_id})
        elif dingtalk_type == "video":
            return "sampleVideo", json.dumps({"mediaId": media_id})
        else:
            # file: 需要 fileName 和 fileType
            ext = os.path.splitext(filename)[1].lower().lstrip(".") if filename else "stream"
            if not ext:
                ext = "stream"
            return "sampleFile", json.dumps({
                "mediaId": media_id,
                "fileName": filename,
                "fileType": ext,
            })

    async def close(self) -> None:
        """关闭 HTTP 客户端"""
        if self._client:
            await self._client.aclose()
            self._client = None
