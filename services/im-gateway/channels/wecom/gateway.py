"""
企业微信渠道 — 连接管理（GatewayAdapter + InboundAdapter 实现）

支持两种连接模式：
1. WebSocket Bot 模式（首选）：通过 wss://openws.work.weixin.qq.com 持久连接
2. HTTP 回调模式（备选）：通过 aiohttp 启动回调服务器

参考 Hermes wecom.py 的 WebSocket 连接逻辑 + 消息去重。
"""

import asyncio
import hashlib
import json
import logging
import time
from typing import Optional, Callable, Any

from core.types import ChannelConfig, MessageEvent, MessageSource, MessageType

logger = logging.getLogger("gateway.wecom.gateway")

DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com"
HEARTBEAT_INTERVAL = 30  # 秒
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
MAX_MESSAGE_LENGTH = 4000
# 消息分片检测阈值（企微客户端会在 4000 字符处自动分割）
SPLIT_THRESHOLD = 3900


class WeComGateway:
    """
    企微网关适配器 — 实现 GatewayAdapter + InboundAdapter Protocol

    WebSocket Bot 模式：
    - 使用 aiohttp.ClientSession 建立 WebSocket 连接
    - 通过 aibot_subscribe 命令认证
    - 接收 aibot_msg_callback 消息事件
    - 发送 aibot_send_msg 消息回复
    - 自动心跳 + 断线重连
    """

    def __init__(self):
        self._connected = False
        self._last_error: Optional[str] = None
        self._message_handler: Optional[Callable] = None
        self._config: Optional[ChannelConfig] = None
        self._ws = None  # aiohttp WebSocket
        self._session = None  # aiohttp ClientSession
        self._task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._connected_at: Optional[str] = None
        self._last_event_at: Optional[str] = None
        # 消息分片缓冲（企微客户端会分割 >4000 字符的消息）
        self._fragment_buffer: dict[str, list[str]] = {}
        self._fragment_timers: dict[str, asyncio.TimerHandle] = {}

    # ── GatewayAdapter Protocol ──

    async def start(self, config: ChannelConfig) -> bool:
        """启动企微 WebSocket 连接"""
        self._config = config
        bot_id = config.credentials.get("bot_id", "")
        bot_secret = config.credentials.get("bot_secret", "")

        if not bot_id or not bot_secret:
            self._last_error = "缺少 Bot ID 或 Bot Secret（WebSocket 模式必需）"
            logger.error("企微连接失败: %s", self._last_error)
            return False

        try:
            import aiohttp
            self._session = aiohttp.ClientSession()
            self._task = asyncio.create_task(self._connect_loop(bot_id, bot_secret))
            logger.info("企微 WebSocket 连接启动中: bot_id=%s***", bot_id[:8])
            return True
        except ImportError:
            self._last_error = "aiohttp 未安装"
            logger.error("企微连接失败: %s", self._last_error)
            return False
        except Exception as e:
            self._last_error = str(e)
            logger.error("企微连接异常: %s", e)
            return False

    async def stop(self) -> None:
        """停止企微连接"""
        self._connected = False
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._ws and not self._ws.closed:
            await self._ws.close()
        if self._session and not self._session.closed:
            await self._session.close()
        self._ws = None
        self._session = None
        logger.info("企微连接已停止")

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    # ── InboundAdapter Protocol ──

    def set_message_handler(self, handler: Callable) -> None:
        self._message_handler = handler

    # ── HealthAdapter 兼容属性 ──

    @property
    def has_fatal_error(self) -> bool:
        return self._last_error is not None and not self._connected

    @property
    def connected_at(self) -> Optional[str]:
        return self._connected_at

    @property
    def last_event_at(self) -> Optional[str]:
        return self._last_event_at

    # ── 内部方法 ──

    async def _connect_loop(self, bot_id: str, bot_secret: str) -> None:
        """连接循环 — 断线后按指数退避重连"""
        attempt = 0
        while True:
            try:
                await self._connect_once(bot_id, bot_secret)
            except asyncio.CancelledError:
                break
            except Exception as e:
                self._last_error = str(e)
                self._connected = False
                logger.error("企微连接断开: %s", e)

            # 指数退避重连
            backoff = RECONNECT_BACKOFF[min(attempt, len(RECONNECT_BACKOFF) - 1)]
            logger.info("企微将在 %ds 后重连 (attempt=%d)", backoff, attempt + 1)
            await asyncio.sleep(backoff)
            attempt += 1

    async def _connect_once(self, bot_id: str, bot_secret: str) -> None:
        """单次 WebSocket 连接"""
        import aiohttp

        ws_url = self._config.credentials.get("websocket_url", DEFAULT_WS_URL) if self._config else DEFAULT_WS_URL

        async with self._session.ws_connect(ws_url, timeout=20) as ws:
            self._ws = ws

            # 1. 认证：发送 aibot_subscribe
            timestamp = str(int(time.time()))
            nonce = hashlib.md5(f"{bot_id}{timestamp}".encode()).hexdigest()[:16]
            sign_str = f"{bot_id}\n{timestamp}\n{nonce}"
            import hmac
            signature = hmac.new(
                bot_secret.encode(), sign_str.encode(), hashlib.sha256
            ).hexdigest()

            await ws.send_json({
                "header": {"cmd": "aibot_subscribe"},
                "body": {
                    "bot_id": bot_id,
                    "timestamp": timestamp,
                    "nonce": nonce,
                    "signature": signature,
                },
            })

            # 等待认证响应
            auth_resp = await asyncio.wait_for(ws.receive_json(), timeout=10)
            if auth_resp.get("header", {}).get("code", -1) != 0:
                raise RuntimeError(f"企微认证失败: {auth_resp}")

            self._connected = True
            self._last_error = None
            self._connected_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            logger.info("企微 WebSocket 已认证: bot_id=%s", bot_id)

            # 2. 启动心跳
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(ws))

            # 3. 消息接收循环
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_ws_message(json.loads(msg.data))
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break

            self._connected = False

    async def _heartbeat_loop(self, ws) -> None:
        """心跳循环"""
        try:
            while not ws.closed:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                if not ws.closed:
                    await ws.send_json({"header": {"cmd": "ping"}})
        except (asyncio.CancelledError, Exception):
            pass

    async def _handle_ws_message(self, data: dict) -> None:
        """处理 WebSocket 消息"""
        cmd = data.get("header", {}).get("cmd", "")

        if cmd in ("aibot_msg_callback", "aibot_callback"):
            self._last_event_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            body = data.get("body", {})

            msg_type_raw = body.get("msg_type", "text")
            text = body.get("content", "")
            user_id = body.get("from", {}).get("user_id", "")
            chat_id = body.get("conversation_id", "")
            is_group = body.get("chat_type", "") == "group"
            sender_name = body.get("from", {}).get("name", "")
            msg_id = body.get("msg_id", "")

            # 构造统一 MessageEvent
            event = MessageEvent(
                text=text,
                source=MessageSource(
                    user_id=user_id,
                    chat_id=chat_id,
                    is_group=is_group,
                    sender_name=sender_name,
                ),
                msg_type=self._map_msg_type(msg_type_raw),
                msg_id=msg_id,
                timestamp=time.time(),
                raw=body,
            )

            if self._message_handler:
                await self._message_handler(event)

    @staticmethod
    def _map_msg_type(raw_type: str) -> MessageType:
        """映射企微消息类型到统一类型"""
        mapping = {
            "text": MessageType.TEXT,
            "image": MessageType.IMAGE,
            "voice": MessageType.AUDIO,
            "video": MessageType.VIDEO,
            "file": MessageType.FILE,
        }
        return mapping.get(raw_type, MessageType.TEXT)
