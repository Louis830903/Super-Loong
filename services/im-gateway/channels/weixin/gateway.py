"""
微信渠道 — 连接管理 + QR 登录（GatewayAdapter + InboundAdapter + QrLoginAdapter）

iLink Bot API 连接流程：
1. QR 扫码登录：GET /api/qr → 获取二维码 → 用户扫码
2. 轮询状态：GET /api/qr/status → 等待确认
3. Long-poll 消息接收：GET /api/messages/poll → 阻塞等待新消息
4. 断线重连：Long-poll 超时后自动重连

参考 Hermes weixin.py 的 iLink Bot 集成方式。
"""

import asyncio
import logging
import time
from typing import Optional, Callable

import httpx

from core.types import (
    ChannelConfig, MessageEvent, MessageSource, MessageType,
    QrLoginResult, QrStatus, QrStatusResult,
)

logger = logging.getLogger("gateway.weixin.gateway")

POLL_TIMEOUT = 30  # Long-poll 超时秒数


class WeixinGateway:
    """
    微信网关适配器 — 实现 GatewayAdapter + InboundAdapter + QrLoginAdapter Protocol

    通过 iLink Bot API 桥接微信消息：
    - QR 扫码登录
    - Long-poll 消息接收
    - 自动重连
    """

    def __init__(self):
        self._connected = False
        self._last_error: Optional[str] = None
        self._message_handler: Optional[Callable] = None
        self._config: Optional[ChannelConfig] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._poll_task: Optional[asyncio.Task] = None
        self._qr_session_id: str = ""

    # ── GatewayAdapter Protocol ──

    async def start(self, config: ChannelConfig) -> bool:
        """启动微信连接（需要先完成 QR 扫码）"""
        self._config = config
        api_url = config.credentials.get("api_url", "")
        api_token = config.credentials.get("api_token", "")

        if not api_url or not api_token:
            self._last_error = "缺少 API 地址或 API Token"
            logger.error("微信连接失败: %s", self._last_error)
            return False

        try:
            self._client = httpx.AsyncClient(
                base_url=api_url.rstrip("/"),
                timeout=httpx.Timeout(POLL_TIMEOUT + 10),
                headers={"Authorization": f"Bearer {api_token}"},
            )

            # 检查 iLink Bot 是否可达
            resp = await self._client.get("/api/status", timeout=10)
            data = resp.json()

            if data.get("logged_in"):
                # 已登录，直接启动消息轮询
                self._connected = True
                self._last_error = None
                self._poll_task = asyncio.create_task(self._poll_loop())
                logger.info("微信已连接（已登录状态）")
                return True
            else:
                # 需要扫码登录
                self._last_error = "需要扫码登录"
                logger.info("微信需要扫码登录")
                return False

        except Exception as e:
            self._last_error = str(e)
            logger.error("微信连接异常: %s", e)
            return False

    async def stop(self) -> None:
        """停止微信连接"""
        self._connected = False
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
        if self._client:
            await self._client.aclose()
            self._client = None
        logger.info("微信连接已停止")

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    # ── InboundAdapter Protocol ──

    def set_message_handler(self, handler: Callable) -> None:
        self._message_handler = handler

    # ── QrLoginAdapter Protocol ──

    async def start_qr_login(self) -> QrLoginResult:
        """发起微信 QR 扫码登录"""
        if not self._client:
            return QrLoginResult(message="未初始化，请先配置 API 地址")

        try:
            resp = await self._client.get("/api/qr")
            data = resp.json()

            qr_data_url = data.get("qr_data_url", "")
            session_id = data.get("session_id", "")
            self._qr_session_id = session_id

            return QrLoginResult(
                qr_data_url=qr_data_url,
                session_id=session_id,
                message="请使用微信扫描二维码",
            )

        except Exception as e:
            logger.error("微信获取二维码失败: %s", e)
            return QrLoginResult(message=f"获取二维码失败: {e}")

    async def check_qr_status(self) -> QrStatusResult:
        """轮询 QR 扫码状态"""
        if not self._client:
            return QrStatusResult(status=QrStatus.ERROR, error="未初始化")

        try:
            resp = await self._client.get("/api/qr/status", timeout=10)
            data = resp.json()

            status_str = data.get("status", "waiting")
            status_map = {
                "waiting": QrStatus.WAITING,
                "scanned": QrStatus.SCANNED,
                "confirmed": QrStatus.CONFIRMED,
                "expired": QrStatus.EXPIRED,
            }
            status = status_map.get(status_str, QrStatus.ERROR)

            if status == QrStatus.CONFIRMED:
                # 扫码成功，启动消息轮询
                self._connected = True
                self._last_error = None
                self._poll_task = asyncio.create_task(self._poll_loop())
                logger.info("微信扫码登录成功")

            return QrStatusResult(
                status=status,
                connected=(status == QrStatus.CONFIRMED),
            )

        except Exception as e:
            logger.error("微信查询扫码状态失败: %s", e)
            return QrStatusResult(status=QrStatus.ERROR, error=str(e))

    # ── 内部方法 ──

    async def _poll_loop(self) -> None:
        """Long-poll 消息接收循环"""
        retry_count = 0
        while self._connected:
            try:
                resp = await self._client.get(
                    "/api/messages/poll",
                    timeout=httpx.Timeout(POLL_TIMEOUT + 10),
                )
                data = resp.json()
                retry_count = 0  # 成功后重置重试

                messages = data.get("messages", [])
                for msg in messages:
                    await self._handle_message(msg)

            except asyncio.CancelledError:
                break
            except httpx.ReadTimeout:
                # Long-poll 超时是正常的，继续轮询
                continue
            except Exception as e:
                retry_count += 1
                self._last_error = str(e)
                logger.warning("微信消息轮询异常 (retry=%d): %s", retry_count, e)
                await asyncio.sleep(min(retry_count * 2, 30))

                if retry_count > 10:
                    self._connected = False
                    logger.error("微信消息轮询失败次数过多，断开连接")
                    break

    async def _handle_message(self, raw_msg: dict) -> None:
        """处理收到的微信消息"""
        msg_type_raw = raw_msg.get("type", "text")
        text = raw_msg.get("content", "")
        sender = raw_msg.get("sender", {})

        msg_type_map = {
            "text": MessageType.TEXT,
            "image": MessageType.IMAGE,
            "voice": MessageType.AUDIO,
            "video": MessageType.VIDEO,
            "file": MessageType.FILE,
        }

        event = MessageEvent(
            text=text,
            source=MessageSource(
                user_id=sender.get("id", ""),
                chat_id=raw_msg.get("chat_id", sender.get("id", "")),
                is_group=raw_msg.get("is_group", False),
                sender_name=sender.get("name", ""),
            ),
            msg_type=msg_type_map.get(msg_type_raw, MessageType.TEXT),
            msg_id=raw_msg.get("msg_id", ""),
            timestamp=raw_msg.get("timestamp", time.time()),
            media_urls=raw_msg.get("media_urls", []),
            raw=raw_msg,
        )

        if self._message_handler:
            await self._message_handler(event)
