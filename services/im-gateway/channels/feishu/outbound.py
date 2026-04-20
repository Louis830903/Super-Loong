"""
飞书渠道 — 出站消息 + 媒体适配器（OutboundAdapter 实现）

发送方式：
1. 文本消息：POST /open-apis/im/v1/messages (msg_type=text)
2. 消息卡片：POST /open-apis/im/v1/messages (msg_type=interactive)
3. 媒体消息：先上传再发送（图片/文件/音频）
4. 流式回复：创建卡片后通过 PATCH 更新内容

参考 adapters/feishu.py + Hermes feishu.py 的消息卡片和流式回复逻辑。
"""

import json
import logging
import time
import uuid
from typing import Optional

import httpx

from core.types import ChannelConfig, SendResult, MediaPayload
from core.token_manager import TokenManager, TOKEN_EXPIRED_CODES

logger = logging.getLogger("gateway.feishu.outbound")

# MIME → 飞书 file_type 映射
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
    "audio/mpeg": "opus",
}

KIND_TO_FEISHU_FILE_TYPE = {
    "audio": "opus",
    "video": "mp4",
    "document": "stream",
    "file": "stream",
}

# 飞书 Token 过期错误码（从 core.token_manager 统一获取）
_FEISHU_EXPIRED_CODES = TOKEN_EXPIRED_CODES.get("feishu", set())

# 飞书消息最大文本长度（实际可以很长，但推荐不超过 4000）
FEISHU_MAX_TEXT_LENGTH = 4000


class FeishuTokenManager(TokenManager):
    """飞书 tenant_access_token 自动刷新管理器"""

    def __init__(self, app_id: str = "", app_secret: str = ""):
        super().__init__()
        self._app_id = app_id
        self._app_secret = app_secret

    def has_credentials(self) -> bool:
        return bool(self._app_id and self._app_secret)

    async def _fetch_token(self) -> tuple[str, int]:
        """从飞书获取 tenant_access_token"""
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
            resp = await client.post(
                "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": self._app_id, "app_secret": self._app_secret},
            )
            resp.raise_for_status()
            data = resp.json()

        if data.get("code", -1) != 0:
            raise RuntimeError(f"飞书获取token失败: {data.get('msg', 'unknown')}")

        return data["tenant_access_token"], data.get("expire", 7200)


class FeishuOutbound:
    """
    飞书出站消息适配器 — 实现 OutboundAdapter Protocol

    支持文本、消息卡片、媒体消息发送。
    Token 过期自动刷新 + UUID 消息去重。
    """

    BASE_URL = "https://open.feishu.cn"

    def __init__(self):
        self._config: Optional[ChannelConfig] = None
        self._token_manager: Optional[FeishuTokenManager] = None
        self._client: Optional[httpx.AsyncClient] = None

    def configure(self, config: ChannelConfig) -> None:
        """初始化配置"""
        self._config = config
        app_id = config.credentials.get("app_id", "")
        app_secret = config.credentials.get("app_secret", "")
        self._token_manager = FeishuTokenManager(app_id, app_secret)

    # ── OutboundAdapter Protocol ──

    async def send_text(self, chat_id: str, text: str, **kwargs) -> SendResult:
        """发送文本消息（支持 thread_id / msg_id 透传）"""
        msg_uuid = str(uuid.uuid4())

        # P1-06: 超长消息截断保护，避免飞书 API 400
        if len(text) > FEISHU_MAX_TEXT_LENGTH:
            logger.warning("消息超长截断: %d → %d 字符", len(text), FEISHU_MAX_TEXT_LENGTH)
            text = text[:FEISHU_MAX_TEXT_LENGTH - 3] + "..."

        data = await self._api_request(
            "post",
            "/open-apis/im/v1/messages",
            params={"receive_id_type": "chat_id"},
            json={
                "receive_id": chat_id,
                "msg_type": "text",
                "content": json.dumps({"text": text}),
                "uuid": msg_uuid,
            },
        )

        success = data.get("code", -1) == 0
        msg_id = data.get("data", {}).get("message_id", "")

        if success:
            logger.info("飞书消息已发送: chat_id=%s, msg_id=%s", chat_id, msg_id)
        else:
            logger.error("飞书消息发送失败: chat_id=%s, code=%s, msg=%s",
                         chat_id, data.get("code"), data.get("msg", ""))

        return SendResult(
            success=success,
            message_id=msg_id,
            error="" if success else data.get("msg", ""),
        )

    async def send_media(self, chat_id: str, payload: MediaPayload) -> SendResult:
        """发送媒体消息"""
        try:
            # 1. 上传媒体
            if payload.kind == "image":
                media_id = await self._upload_image(payload)
                msg_type = "image"
                content = {"image_key": media_id}
            elif payload.kind == "audio":
                media_id = await self._upload_file(payload)
                msg_type = "audio"
                content = {"file_key": media_id}
            else:
                media_id = await self._upload_file(payload)
                msg_type = "file"
                content = {"file_key": media_id}

            if not media_id:
                return SendResult(success=False, error="媒体上传失败")

            # 2. 发送消息
            msg_uuid = str(uuid.uuid4())
            data = await self._api_request(
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
            return SendResult(
                success=success,
                message_id=data.get("data", {}).get("message_id", ""),
                error="" if success else data.get("msg", ""),
            )

        except Exception as e:
            logger.error("飞书媒体发送异常: %s", e)
            return SendResult(success=False, error=str(e))

    def max_text_length(self) -> int:
        return FEISHU_MAX_TEXT_LENGTH

    # ── 媒体上传 ──

    async def _upload_image(self, payload: MediaPayload) -> str:
        """上传图片到飞书"""
        with open(payload.path, "rb") as f:
            data = await self._api_request(
                "post",
                "/open-apis/im/v1/images",
                data={"image_type": "message"},
                files={"image": (payload.filename, f, payload.mime_type)},
            )

        if data.get("code", -1) != 0:
            logger.error("飞书图片上传失败: %s", data.get("msg"))
            return ""

        image_key = data.get("data", {}).get("image_key", "")
        logger.info("飞书图片已上传: %s → %s", payload.filename, image_key)
        return image_key

    async def _upload_file(self, payload: MediaPayload) -> str:
        """上传文件到飞书"""
        file_type = self._resolve_file_type(payload)

        with open(payload.path, "rb") as f:
            data = await self._api_request(
                "post",
                "/open-apis/im/v1/files",
                data={"file_type": file_type, "file_name": payload.filename},
                files={"file": (payload.filename, f, payload.mime_type)},
            )

        if data.get("code", -1) != 0:
            logger.error("飞书文件上传失败: %s", data.get("msg"))
            return ""

        file_key = data.get("data", {}).get("file_key", "")
        logger.info("飞书文件已上传: %s → %s (%s)", payload.filename, file_key, file_type)
        return file_key

    @staticmethod
    def _resolve_file_type(payload: MediaPayload) -> str:
        """根据 MIME 类型解析飞书文件类型"""
        if payload.mime_type in MIME_TO_FEISHU_FILE_TYPE:
            return MIME_TO_FEISHU_FILE_TYPE[payload.mime_type]
        return KIND_TO_FEISHU_FILE_TYPE.get(payload.kind, "stream")

    # ── API 请求封装 ──

    async def _api_request(self, method: str, path: str, **kwargs) -> dict:
        """带 token 过期重试的 API 请求"""
        client = await self._ensure_client()

        start = time.time()
        resp = await getattr(client, method)(f"{self.BASE_URL}{path}", **kwargs)
        resp.raise_for_status()
        data = resp.json()

        # 检测 token 过期
        code = data.get("code", 0)
        if code in _FEISHU_EXPIRED_CODES:
            logger.warning("飞书 Token 过期 (code=%d)，刷新中...", code)
            await self._token_manager.force_refresh()
            # 重建客户端以更新 Authorization header
            await self._rebuild_client()
            client = await self._ensure_client()
            resp = await getattr(client, method)(f"{self.BASE_URL}{path}", **kwargs)
            resp.raise_for_status()
            data = resp.json()

        elapsed = time.time() - start
        logger.debug("飞书 %s %s → code=%s (%.2fs)", method.upper(), path, data.get("code", 0), elapsed)
        return data

    async def _ensure_client(self) -> httpx.AsyncClient:
        """确保 HTTP 客户端就绪（含 token 获取）"""
        if not self._token_manager:
            raise RuntimeError(
                "FeishuOutbound 未初始化：请先调用 configure() 设置凭证"
            )
        if not self._token_manager.has_credentials():
            raise RuntimeError(
                "飞书凭证不完整：app_id 或 app_secret 为空"
            )
        if not self._client:
            token = await self._token_manager.get_token()
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0),
                headers={"Authorization": f"Bearer {token}"},
            )
        return self._client

    async def _rebuild_client(self) -> None:
        """关闭旧客户端，下次请求时重建"""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
