"""
企业微信媒体适配器
对标 OpenClaw Slack 扩展的 uploadSlackFile 模式

企业微信媒体 API 参考:
- 上传临时素材: POST /cgi-bin/media/upload?type=image|voice|video|file
- 发送图片消息: POST /cgi-bin/message/send (msgtype=image)
- 发送文件消息: POST /cgi-bin/message/send (msgtype=file)
- 发送语音消息: POST /cgi-bin/message/send (msgtype=voice, AMR 限制)
- 发送视频消息: POST /cgi-bin/message/send (msgtype=video)

官方限制:
- 图片: 10MB, JPG/PNG
- 语音: 2MB, AMR 格式, 60秒以内
- 视频: 10MB, MP4
- 文件: 20MB
- 临时素材 media_id 有效期 3 天
- access_token 有效期 7200秒 (2小时)

改进:
- [P0] Token 自动刷新: corpid + corpsecret → 自动获取 + 缓存 + 过期刷新
- [P0] agentid 从配置传入, 不再硬编码 0
- [P0] Token 过期自动重试 (errcode=42001/40014)
- [P1] safe + enable_duplicate_check 参数支持
"""

import logging
import os
import time
from typing import Optional

import httpx

from .base import ChannelMediaAdapter, MediaPayload, TokenManager

logger = logging.getLogger("im-gateway.adapters.wecom")

# MediaKind → 企业微信 media type 映射
KIND_TO_WECOM_TYPE = {
    "image": "image",
    "audio": "voice",
    "video": "video",
    "document": "file",
    "file": "file",
}


class WeComTokenManager(TokenManager):
    """企业微信 access_token 自动刷新管理器"""

    def __init__(
        self,
        corpid: str = "",
        corpsecret: str = "",
        static_token: str = "",
        base_url: str = "https://qyapi.weixin.qq.com",
    ):
        super().__init__(static_token=static_token)
        self._corpid = corpid
        self._corpsecret = corpsecret
        self._base_url = base_url

    def has_credentials(self) -> bool:
        return bool(self._corpid and self._corpsecret)

    async def _fetch_token(self) -> tuple[str, int]:
        """
        从企业微信获取 access_token
        官方接口: GET /cgi-bin/gettoken?corpid=xxx&corpsecret=xxx
        """
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.get(
                f"{self._base_url}/cgi-bin/gettoken",
                params={"corpid": self._corpid, "corpsecret": self._corpsecret},
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"企业微信获取token失败: {data.get('errmsg', 'unknown')}")

        return data["access_token"], data.get("expires_in", 7200)


class WeComMediaAdapter(ChannelMediaAdapter):
    """
    企业微信媒体适配器

    使用企业微信服务端 API 上传和发送媒体文件。
    支持两种配置方式:
    1. corpid + corpsecret (推荐): 自动获取和刷新 access_token
    2. 直接传入 access_token (兼容旧配置, 但 2小时后会过期)
    """

    def __init__(
        self,
        base_url: str = "https://qyapi.weixin.qq.com",
        access_token: str = "",
        corpid: str = "",
        corpsecret: str = "",
        agentid: int = 0,
    ):
        self._base_url = base_url
        self._agentid = agentid
        self._token_manager = WeComTokenManager(
            corpid=corpid,
            corpsecret=corpsecret,
            static_token=access_token,
            base_url=base_url,
        )
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def platform_name(self) -> str:
        return "wecom"

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
        检测 errcode=42001/40014 → 强制刷新 token → 重试一次。
        """
        client = await self._ensure_client()
        token = await self._token_manager.get_token()

        # 注入 token 到 query params
        params = kwargs.pop("params", {}) or {}
        params["access_token"] = token
        kwargs["params"] = params

        start = time.time()
        resp = await getattr(client, method)(url, **kwargs)
        resp.raise_for_status()
        data = resp.json()

        # 检测 token 过期错误码 → 刷新 + 重试
        errcode = data.get("errcode", 0)
        if self._is_token_expired_error(errcode):
            logger.warning("[wecom] Token expired (errcode=%d), refreshing...", errcode)
            new_token = await self._token_manager.force_refresh()
            kwargs["params"]["access_token"] = new_token
            resp = await getattr(client, method)(url, **kwargs)
            resp.raise_for_status()
            data = resp.json()

        elapsed = time.time() - start
        logger.debug("[wecom] %s %s -> errcode=%s (%.2fs)", method.upper(), url, data.get("errcode", 0), elapsed)
        return data

    async def upload_media(self, payload: MediaPayload) -> str:
        """上传临时素材到企业微信"""
        wecom_type = KIND_TO_WECOM_TYPE.get(payload.kind, "file")

        with open(payload.path, "rb") as f:
            data = await self._request_with_retry(
                "post",
                "/cgi-bin/media/upload",
                params={"type": wecom_type},
                files={"media": (payload.filename, f, payload.mime_type)},
            )

        if data.get("errcode", 0) != 0:
            raise RuntimeError(f"企业微信上传失败: {data.get('errmsg', 'unknown')}")

        media_id = data.get("media_id", "")
        logger.info("[wecom] Media uploaded: %s → %s (%s)", payload.filename, media_id, wecom_type)
        return media_id

    async def send_media(
        self,
        chat_id: str,
        payload: MediaPayload,
        media_id: Optional[str] = None,
    ) -> bool:
        """通过企业微信 API 发送媒体消息"""
        if not media_id:
            media_id = await self.upload_media(payload)

        wecom_type = KIND_TO_WECOM_TYPE.get(payload.kind, "file")

        # 构建消息体: agentid 从配置传入, safe + enable_duplicate_check 官方推荐参数
        msg_body = {
            "touser": chat_id,
            "msgtype": wecom_type,
            "agentid": self._agentid,
            wecom_type: {"media_id": media_id},
            "safe": 0,                      # 0=普通消息, 1=保密消息
            "enable_duplicate_check": 0,     # 0=不检查, 1=去重
        }

        data = await self._request_with_retry(
            "post",
            "/cgi-bin/message/send",
            json=msg_body,
        )

        success = data.get("errcode", -1) == 0
        if not success:
            logger.error("[wecom] Send failed: errcode=%s, errmsg=%s", data.get("errcode"), data.get("errmsg"))
        return success

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
