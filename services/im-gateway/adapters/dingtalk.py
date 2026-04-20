"""
钉钉媒体适配器

钉钉媒体 API 参考:
- 上传媒体: POST /media/upload (type=image|voice|video|file)
- 发送工作通知: POST /topapi/message/corpconversation/asyncsend_v2
- 发送群消息: POST /robot/send (webhook 模式)

官方限制:
- 图片: 20MB, JPG/GIF/PNG/BMP
- 语音: 2MB, AMR/MP3/WAV
- 视频: 20MB, MP4
- 文件: 20MB
- access_token 有效期 7200秒 (2小时)

改进:
- [P0] Token 自动刷新: appkey + appsecret → 自动获取 + 缓存
- [P0] agent_id 从配置传入, 不再硬编码 0
- [P0] Token 过期自动重试 (errcode=88/40014)
- [P1] 恢复 video 原生类型支持 (不再降级为 file)
- [P1] 图片大小限制修正为官方 20MB (原 5MB 不符)
"""

import logging
import os
import time
from typing import Optional

import httpx

from .base import ChannelMediaAdapter, MediaPayload, TokenManager

logger = logging.getLogger("im-gateway.adapters.dingtalk")

# MediaKind → 钉钉 media type 映射 (恢复 video 原生支持)
KIND_TO_DINGTALK_TYPE = {
    "image": "image",
    "audio": "voice",
    "video": "video",      # 钉钉实际支持 video 类型, 不再降级为 file
    "document": "file",
    "file": "file",
}


class DingTalkTokenManager(TokenManager):
    """钉钉 access_token 自动刷新管理器"""

    def __init__(
        self,
        appkey: str = "",
        appsecret: str = "",
        static_token: str = "",
        base_url: str = "https://oapi.dingtalk.com",
    ):
        super().__init__(static_token=static_token)
        self._appkey = appkey
        self._appsecret = appsecret
        self._base_url = base_url

    def has_credentials(self) -> bool:
        return bool(self._appkey and self._appsecret)

    async def _fetch_token(self) -> tuple[str, int]:
        """
        从钉钉获取 access_token
        官方接口: POST /gettoken?appkey=xxx&appsecret=xxx
        """
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(
                f"{self._base_url}/gettoken",
                params={"appkey": self._appkey, "appsecret": self._appsecret},
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"钉钉获取token失败: {data.get('errmsg', 'unknown')}")

        return data["access_token"], data.get("expires_in", 7200)


class DingTalkMediaAdapter(ChannelMediaAdapter):
    """
    钉钉媒体适配器

    使用钉钉服务端 API 上传和发送媒体。
    支持两种配置方式:
    1. appkey + appsecret (推荐): 自动获取 access_token
    2. 直接传入 access_token (兼容, 但 2小时过期)
    """

    def __init__(
        self,
        base_url: str = "https://oapi.dingtalk.com",
        access_token: str = "",
        appkey: str = "",
        appsecret: str = "",
        agent_id: int = 0,
    ):
        self._base_url = base_url
        self._agent_id = agent_id
        self._token_manager = DingTalkTokenManager(
            appkey=appkey,
            appsecret=appsecret,
            static_token=access_token,
            base_url=base_url,
        )
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def platform_name(self) -> str:
        return "dingtalk"

    async def _ensure_client(self) -> httpx.AsyncClient:
        if not self._client:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(30.0),
            )
        return self._client

    async def _request_with_retry(self, method: str, url: str, **kwargs) -> dict:
        """
        带 token 过期自动重试的请求包装。
        检测 errcode=88/40014 → 刷新 token → 重试。
        """
        client = await self._ensure_client()
        token = await self._token_manager.get_token()

        params = kwargs.pop("params", {}) or {}
        params["access_token"] = token
        kwargs["params"] = params

        start = time.time()
        resp = await getattr(client, method)(url, **kwargs)
        resp.raise_for_status()
        data = resp.json()

        errcode = data.get("errcode", 0)
        if self._is_token_expired_error(errcode):
            logger.warning("[dingtalk] Token expired (errcode=%d), refreshing...", errcode)
            new_token = await self._token_manager.force_refresh()
            kwargs["params"]["access_token"] = new_token
            resp = await getattr(client, method)(url, **kwargs)
            resp.raise_for_status()
            data = resp.json()

        elapsed = time.time() - start
        logger.debug("[dingtalk] %s %s -> errcode=%s (%.2fs)", method.upper(), url, data.get("errcode", 0), elapsed)
        return data

    async def upload_media(self, payload: MediaPayload) -> str:
        """上传媒体到钉钉"""
        dingtalk_type = KIND_TO_DINGTALK_TYPE.get(payload.kind, "file")

        with open(payload.path, "rb") as f:
            data = await self._request_with_retry(
                "post",
                "/media/upload",
                params={"type": dingtalk_type},
                files={"media": (payload.filename, f, payload.mime_type)},
            )

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"钉钉上传失败: {data.get('errmsg', 'unknown')}")

        media_id = data.get("media_id", "")
        logger.info("[dingtalk] Media uploaded: %s → %s (%s)", payload.filename, media_id, dingtalk_type)
        return media_id

    async def send_media(
        self,
        chat_id: str,
        payload: MediaPayload,
        media_id: Optional[str] = None,
    ) -> bool:
        """通过钉钉 API 发送媒体消息"""
        if not media_id:
            media_id = await self.upload_media(payload)

        dingtalk_type = KIND_TO_DINGTALK_TYPE.get(payload.kind, "file")

        # 构建工作通知消息体 (恢复 video 原生类型)
        msg = {}
        if dingtalk_type == "image":
            msg = {"msgtype": "image", "image": {"media_id": media_id}}
        elif dingtalk_type == "voice":
            msg = {"msgtype": "voice", "voice": {"media_id": media_id}}
        elif dingtalk_type == "video":
            msg = {"msgtype": "video", "video": {"media_id": media_id}}
        else:
            msg = {"msgtype": "file", "file": {"media_id": media_id}}

        data = await self._request_with_retry(
            "post",
            "/topapi/message/corpconversation/asyncsend_v2",
            json={
                "agent_id": self._agent_id,
                "userid_list": chat_id,
                "msg": msg,
            },
        )

        success = data.get("errcode", -1) == 0
        if not success:
            logger.error("[dingtalk] Send failed: errcode=%s, errmsg=%s", data.get("errcode"), data.get("errmsg"))
        return success

    def supports_kind(self, kind: str) -> bool:
        """钉钉支持所有媒体类型 (包括视频, 不再降级)"""
        return kind in ("image", "audio", "video", "document", "file")

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
