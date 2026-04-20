"""
飞书媒体适配器
对标 OpenClaw 飞书扩展 (extensions/feishu/src/media.test.ts)

飞书媒体 API 参考:
- 上传图片: POST /open-apis/im/v1/images (type=message)
- 上传文件: POST /open-apis/im/v1/files (file_type=opus|mp4|pdf|doc|xls|ppt|stream)
- 发送图片消息: POST /open-apis/im/v1/messages (msg_type=image)
- 发送文件消息: POST /open-apis/im/v1/messages (msg_type=file)
- 发送语音消息: POST /open-apis/im/v1/messages (msg_type=audio)

官方限制:
- 图片: 10MB, JPG/PNG/GIF/BMP/TIFF/WebP
- 文件: 30MB
- 语音: opus/mp3
- tenant_access_token 有效期 2 小时

改进:
- [P0] Token 自动刷新: app_id + app_secret → 自动获取 tenant_access_token
- [P0] Token 过期自动重试 (code=99991663/99991664)
- [P1] 增加 audio 消息类型支持
- [P1] file_type 根据 MIME 类型细分映射 (pdf/doc/xls/ppt)
- [P2] 发送消息增加 uuid 去重参数
"""

import json
import logging
import os
import time
import uuid
from typing import Optional

import httpx

from .base import ChannelMediaAdapter, MediaPayload, TokenManager

logger = logging.getLogger("im-gateway.adapters.feishu")

# MediaKind → 飞书文件类型映射 (通用回退)
KIND_TO_FEISHU_FILE_TYPE = {
    "audio": "opus",
    "video": "mp4",
    "document": "stream",
    "file": "stream",
}

# MIME → 飞书 file_type 细分映射 (使飞书能正确预览)
MIME_TO_FEISHU_FILE_TYPE = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "doc",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt",
    "video/mp4": "mp4",
    "audio/opus": "opus",
    "audio/ogg": "opus",
    "audio/mpeg": "opus",  # mp3 走 opus 通道
}


def _resolve_file_type(payload: MediaPayload) -> str:
    """根据 MIME 类型细分决策 file_type, 优先 MIME 精确匹配"""
    if payload.mime_type in MIME_TO_FEISHU_FILE_TYPE:
        return MIME_TO_FEISHU_FILE_TYPE[payload.mime_type]
    return KIND_TO_FEISHU_FILE_TYPE.get(payload.kind, "stream")


class FeishuTokenManager(TokenManager):
    """飞书 tenant_access_token 自动刷新管理器"""

    def __init__(
        self,
        app_id: str = "",
        app_secret: str = "",
        static_token: str = "",
        base_url: str = "https://open.feishu.cn",
    ):
        super().__init__(static_token=static_token)
        self._app_id = app_id
        self._app_secret = app_secret
        self._base_url = base_url

    def has_credentials(self) -> bool:
        return bool(self._app_id and self._app_secret)

    async def _fetch_token(self) -> tuple[str, int]:
        """
        从飞书获取 tenant_access_token
        官方接口: POST /open-apis/auth/v3/tenant_access_token/internal
        """
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.post(
                f"{self._base_url}/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": self._app_id, "app_secret": self._app_secret},
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("code", -1) != 0:
            raise RuntimeError(f"飞书获取token失败: {data.get('msg', 'unknown')}")

        return data["tenant_access_token"], data.get("expire", 7200)


class FeishuMediaAdapter(ChannelMediaAdapter):
    """
    飞书媒体适配器

    使用飞书开放平台 API 上传和发送媒体。
    支持两种配置方式:
    1. app_id + app_secret (推荐): 自动获取 tenant_access_token
    2. 直接传入 tenant_access_token (兼容, 但 2小时过期)
    """

    def __init__(
        self,
        base_url: str = "https://open.feishu.cn",
        tenant_access_token: str = "",
        app_id: str = "",
        app_secret: str = "",
    ):
        self._base_url = base_url
        self._token_manager = FeishuTokenManager(
            app_id=app_id,
            app_secret=app_secret,
            static_token=tenant_access_token,
            base_url=base_url,
        )
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def platform_name(self) -> str:
        return "feishu"

    async def _get_auth_headers(self) -> dict:
        """获取带有有效 token 的 Authorization 头"""
        token = await self._token_manager.get_token()
        return {"Authorization": f"Bearer {token}"}

    async def _ensure_client(self) -> httpx.AsyncClient:
        """(重新创建客户端时更新 token header)"""
        if not self._client:
            headers = await self._get_auth_headers()
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(30.0),
                headers=headers,
            )
        return self._client

    async def _request_with_retry(self, method: str, url: str, **kwargs) -> dict:
        """
        带 token 过期自动重试的请求包装。
        检测 code=99991663/99991664 → 刷新 token → 重新创建 client → 重试。
        """
        client = await self._ensure_client()
        start = time.time()
        resp = await getattr(client, method)(url, **kwargs)
        resp.raise_for_status()
        data = resp.json()

        code = data.get("code", 0)
        if self._is_token_expired_error(code):
            logger.warning("[feishu] Token expired (code=%d), refreshing...", code)
            await self._token_manager.force_refresh()
            # 重建 client 以更新 Authorization header
            if self._client:
                await self._client.aclose()
                self._client = None
            client = await self._ensure_client()
            resp = await getattr(client, method)(url, **kwargs)
            resp.raise_for_status()
            data = resp.json()

        elapsed = time.time() - start
        logger.debug("[feishu] %s %s -> code=%s (%.2fs)", method.upper(), url, data.get("code", 0), elapsed)
        return data

    async def upload_media(self, payload: MediaPayload) -> str:
        """上传媒体到飞书"""
        # 图片走专用上传 API
        if payload.kind == "image":
            return await self._upload_image(payload)
        # 其他文件走通用文件上传 API
        return await self._upload_file(payload)

    async def _upload_image(self, payload: MediaPayload) -> str:
        """上传图片到飞书 im/v1/images"""
        with open(payload.path, "rb") as f:
            data = await self._request_with_retry(
                "post",
                "/open-apis/im/v1/images",
                data={"image_type": "message"},
                files={"image": (payload.filename, f, payload.mime_type)},
            )

        if data.get("code", -1) != 0:
            raise RuntimeError(f"飞书图片上传失败: {data.get('msg', 'unknown')}")

        image_key = data.get("data", {}).get("image_key", "")
        logger.info("[feishu] Image uploaded: %s → %s", payload.filename, image_key)
        return image_key

    async def _upload_file(self, payload: MediaPayload) -> str:
        """上传文件到飞书 im/v1/files"""
        # 根据 MIME 类型细分 file_type, 使飞书能正确预览
        file_type = _resolve_file_type(payload)

        with open(payload.path, "rb") as f:
            data = await self._request_with_retry(
                "post",
                "/open-apis/im/v1/files",
                data={
                    "file_type": file_type,
                    "file_name": payload.filename,
                },
                files={"file": (payload.filename, f, payload.mime_type)},
            )

        if data.get("code", -1) != 0:
            raise RuntimeError(f"飞书文件上传失败: {data.get('msg', 'unknown')}")

        file_key = data.get("data", {}).get("file_key", "")
        logger.info("[feishu] File uploaded: %s → %s (%s)", payload.filename, file_key, file_type)
        return file_key

    async def send_media(
        self,
        chat_id: str,
        payload: MediaPayload,
        media_id: Optional[str] = None,
    ) -> bool:
        """通过飞书 API 发送媒体消息"""
        if not media_id:
            media_id = await self.upload_media(payload)

        # 图片、音频和文件走不同的消息类型
        if payload.kind == "image":
            msg_type = "image"
            content = {"image_key": media_id}
        elif payload.kind == "audio":
            # 飞书支持 audio 消息类型, 可以在客户端直接播放语音
            msg_type = "audio"
            content = {"file_key": media_id}
        else:
            msg_type = "file"
            content = {"file_key": media_id}

        # 生成 uuid 用于消息去重, 防止网络重试导致重复发送
        msg_uuid = str(uuid.uuid4())

        data = await self._request_with_retry(
            "post",
            "/open-apis/im/v1/messages",
            params={"receive_id_type": "chat_id"},
            json={
                "receive_id": chat_id,
                "msg_type": msg_type,
                "content": json.dumps(content),
                "uuid": msg_uuid,
            },
        )

        success = data.get("code", -1) == 0
        if not success:
            logger.error("[feishu] Send failed: code=%s, msg=%s", data.get("code"), data.get("msg"))
        return success

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None
