"""
企微完整适配器 — 整合所有增强模块

将 media、streaming、markdown、crypto、connection 等模块
组装为统一的企微适配器门面，供 IM Gateway 注册使用。

设计原则：
- 现有 gateway.py/outbound.py/crypto.py 等保持不变
- 本适配器在现有基础上提供增强功能的统一入口
"""

import logging
from typing import Any, Callable, Coroutine, Dict, Optional

logger = logging.getLogger("wecom.adapter")


class WeComEnhancedAdapter:
    """
    企微增强适配器 — 聚合所有新增模块的统一门面。

    用法示例：
        adapter = WeComEnhancedAdapter()
        adapter.setup(
            ws_send_fn=my_ws_send,
            access_token_fn=get_access_token,
            config=channel_config,
        )

        # 流式发送
        await adapter.stream_sender.send_streaming(chat_id, long_text)

        # 分块上传
        media_id = await adapter.media_uploader.upload_file(data, "big.pdf")

        # Markdown 格式化
        formatted = adapter.format_markdown(text)
    """

    def __init__(self):
        self._config: Dict[str, Any] = {}
        self._initialized = False
        self._stream_sender = None
        self._media_uploader = None
        self._connection_manager = None

    def setup(
        self,
        ws_send_fn: Optional[Callable] = None,
        access_token_fn: Optional[Callable] = None,
        config: Optional[Dict[str, Any]] = None,
    ) -> "WeComEnhancedAdapter":
        """
        初始化适配器。

        Args:
            ws_send_fn: WebSocket 消息发送函数
            access_token_fn: 获取 access_token 的异步函数
            config: 渠道配置
        """
        self._config = config or {}
        self._initialized = True

        creds = self._config.get("credentials", {})

        # 流式发送器
        if ws_send_fn:
            from .streaming import WeComStreamSender
            self._stream_sender = WeComStreamSender(ws_send_fn)

        # 分块上传器
        if access_token_fn:
            from .media import WeComMediaUploader
            self._media_uploader = WeComMediaUploader(
                corp_id=creds.get("corp_id", ""),
                agent_id=creds.get("agent_id", ""),
                access_token_fn=access_token_fn,
            )

        logger.info("企微增强适配器初始化完成")
        return self

    @property
    def stream_sender(self):
        """流式消息发送器"""
        return self._stream_sender

    @property
    def media_uploader(self):
        """分块媒体上传器"""
        return self._media_uploader

    @property
    def connection_manager(self):
        """连接管理器"""
        return self._connection_manager

    # ── 便捷方法 ──

    async def send_text(self, chat_id: str, text: str, *, streaming: bool = False) -> None:
        """
        发送文本消息。

        Args:
            chat_id: 目标会话 ID
            text: 文本内容
            streaming: 是否使用流式发送
        """
        if streaming and self._stream_sender:
            await self._stream_sender.send_streaming(chat_id, text)
        elif self._stream_sender:
            # 非流式也通过 stream_sender 发送（单次推送）
            await self._stream_sender.send_streaming(chat_id, text)

    async def send_markdown(self, chat_id: str, text: str) -> None:
        """发送 Markdown 消息"""
        from .markdown import format_markdown
        formatted = format_markdown(text)
        await self.send_text(chat_id, formatted)

    async def upload_file(self, file_data: bytes, filename: str) -> Optional[str]:
        """上传文件并返回 media_id"""
        if self._media_uploader:
            return await self._media_uploader.upload_file(file_data, filename)
        logger.warning("媒体上传器未初始化")
        return None

    def format_markdown(self, text: str) -> str:
        """格式化 Markdown 为企微兼容格式"""
        from .markdown import format_markdown
        return format_markdown(text)

    def decrypt_message(self, encrypted: str) -> Optional[str]:
        """解密企微消息"""
        creds = self._config.get("credentials", {})
        token = creds.get("token", "")
        encoding_aes_key = creds.get("encoding_aes_key", "")
        corp_id = creds.get("corp_id", "")

        if not all([token, encoding_aes_key, corp_id]):
            logger.warning("解密参数不完整")
            return None

        from .crypto import WeComCrypto
        crypto = WeComCrypto(token, encoding_aes_key, corp_id)
        return crypto.decrypt_message(encrypted)

    def verify_signature(
        self, signature: str, timestamp: str, nonce: str, encrypted: str
    ) -> bool:
        """验证企微消息签名"""
        creds = self._config.get("credentials", {})
        token = creds.get("token", "")

        if not token:
            return False

        from .crypto import WeComCrypto
        crypto = WeComCrypto(
            token,
            creds.get("encoding_aes_key", ""),
            creds.get("corp_id", ""),
        )
        return crypto.verify_signature(signature, timestamp, nonce, encrypted)

    async def shutdown(self) -> None:
        """优雅关闭"""
        if self._connection_manager:
            await self._connection_manager.stop()
        logger.info("企微增强适配器已关闭")
