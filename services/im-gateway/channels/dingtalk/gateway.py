"""
钉钉渠道 — 连接管理（GatewayAdapter 实现）

使用 dingtalk-stream SDK 建立 Stream 长连接，
接收消息后通过 InboundAdapter 回调转发到 MessagePipeline。

参考 Hermes dingtalk.py 的 dingtalk-stream 集成方式。
"""

import asyncio
import logging
from typing import Optional, Callable, Any

from core.types import ChannelConfig, MessageEvent, MessageSource, MessageType

logger = logging.getLogger("gateway.dingtalk.gateway")


class DingTalkGateway:
    """
    钉钉网关适配器 — 实现 GatewayAdapter + InboundAdapter Protocol

    使用 dingtalk-stream SDK 的 Stream 模式：
    - 无需公网 IP / 域名
    - SDK 自动处理心跳和重连
    - 通过 callback 接收消息事件
    """

    def __init__(self):
        self._connected = False
        self._last_error: Optional[str] = None
        self._message_handler: Optional[Callable] = None
        self._stream_client = None  # dingtalk_stream.DingTalkStreamClient
        self._config: Optional[ChannelConfig] = None
        self._task: Optional[asyncio.Task] = None

    # ── GatewayAdapter Protocol ──

    async def start(self, config: ChannelConfig) -> bool:
        """启动 dingtalk-stream 连接"""
        self._config = config
        app_key = config.credentials.get("app_key", "")
        app_secret = config.credentials.get("app_secret", "")

        if not app_key or not app_secret:
            self._last_error = "缺少 AppKey 或 AppSecret"
            logger.error("钉钉连接失败: %s", self._last_error)
            return False

        try:
            import dingtalk_stream

            credential = dingtalk_stream.Credential(app_key, app_secret)
            client = dingtalk_stream.DingTalkStreamClient(credential)

            # 注册回调消息处理器
            client.register_callback_handler(
                dingtalk_stream.chatbot.ChatbotMessage.TOPIC,
                self._on_message_callback(),
            )

            # 在后台任务中启动 stream（SDK 内部有事件循环）
            self._stream_client = client
            self._task = asyncio.create_task(self._run_stream())
            self._connected = True
            self._last_error = None
            logger.info("钉钉 Stream 连接已启动: app_key=%s***", app_key[:8])
            return True

        except ImportError:
            self._last_error = "dingtalk-stream SDK 未安装"
            logger.error("钉钉连接失败: %s", self._last_error)
            return False
        except Exception as e:
            self._last_error = str(e)
            logger.error("钉钉连接异常: %s", e)
            return False

    async def stop(self) -> None:
        """停止钉钉连接"""
        self._connected = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._stream_client = None
        self._task = None
        logger.info("钉钉连接已停止")

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    # ── InboundAdapter Protocol ──

    def set_message_handler(self, handler: Callable) -> None:
        """设置消息处理回调"""
        self._message_handler = handler

    # ── 内部方法 ──

    async def _run_stream(self) -> None:
        """在后台运行 dingtalk-stream（阻塞式 SDK）"""
        try:
            loop = asyncio.get_event_loop()
            # dingtalk_stream.start() 是阻塞的，放到线程池执行
            await loop.run_in_executor(None, self._stream_client.start_forever)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._last_error = str(e)
            self._connected = False
            logger.error("钉钉 Stream 异常退出: %s", e)

    def _on_message_callback(self):
        """创建 dingtalk-stream 消息回调"""
        import dingtalk_stream

        gateway = self  # 闭包引用

        class MessageHandler(dingtalk_stream.ChatbotHandler):
            async def process(self, callback: dingtalk_stream.CallbackMessage):
                """处理收到的聊天消息"""
                try:
                    incoming = dingtalk_stream.ChatbotMessage.from_dict(callback.data)

                    # 构造统一 MessageEvent
                    event = MessageEvent(
                        text=incoming.text.content.strip() if incoming.text else "",
                        source=MessageSource(
                            user_id=incoming.sender_staff_id or incoming.sender_id or "",
                            chat_id=incoming.conversation_id or "",
                            is_group=incoming.conversation_type == "2",
                            sender_name=incoming.sender_nick or "",
                        ),
                        msg_type=MessageType.TEXT,
                        msg_id=incoming.msg_id or "",
                    )

                    # 回调上层处理器
                    if gateway._message_handler:
                        reply = await gateway._message_handler(event)

                        # 通过 session_webhook 回复
                        if reply and incoming.session_webhook:
                            import httpx
                            async with httpx.AsyncClient(timeout=30) as client:
                                await client.post(
                                    incoming.session_webhook,
                                    json={
                                        "msgtype": "text",
                                        "text": {"content": reply},
                                    },
                                )

                    return dingtalk_stream.AckMessage.STATUS_OK, "OK"

                except Exception as e:
                    logger.error("钉钉消息处理异常: %s", e)
                    return dingtalk_stream.AckMessage.STATUS_SYSTEM_EXCEPTION, str(e)

        return MessageHandler()
