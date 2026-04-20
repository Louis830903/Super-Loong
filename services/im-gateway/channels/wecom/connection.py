"""
企微连接增强 — WebSocket 心跳保活 + 指数退避重连

参考 Hermes wecom.py 的连接管理：
- 30s 心跳间隔
- 指数退避重连：2, 5, 10, 30, 60s
- 连接健康监控
"""

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine, Dict, Optional

logger = logging.getLogger("wecom.connection")

# 心跳配置
HEARTBEAT_INTERVAL = 30  # 秒
HEARTBEAT_TIMEOUT = 10   # 心跳响应超时

# 重连配置
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
MAX_RECONNECT_ATTEMPTS = 0  # 0 = 无限重连


class WeComConnectionManager:
    """
    企微 WebSocket 连接管理增强层。

    在现有 WeComGateway 基础上提供：
    1. 自动心跳保活（30s 间隔）
    2. 指数退避重连
    3. 连接健康度监控
    """

    def __init__(
        self,
        connect_fn: Callable[[], Coroutine[Any, Any, bool]],
        disconnect_fn: Callable[[], Coroutine[Any, Any, None]],
        heartbeat_fn: Optional[Callable[[], Coroutine[Any, Any, bool]]] = None,
        *,
        heartbeat_interval: float = HEARTBEAT_INTERVAL,
        backoff: list[float] = RECONNECT_BACKOFF,
    ):
        self._connect_fn = connect_fn
        self._disconnect_fn = disconnect_fn
        self._heartbeat_fn = heartbeat_fn
        self._heartbeat_interval = heartbeat_interval
        self._backoff = backoff

        self._connected = False
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._last_heartbeat_at: Optional[float] = None
        self._consecutive_failures = 0
        self._total_reconnects = 0

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def stats(self) -> Dict[str, Any]:
        """连接统计"""
        return {
            "connected": self._connected,
            "total_reconnects": self._total_reconnects,
            "consecutive_failures": self._consecutive_failures,
            "last_heartbeat_at": self._last_heartbeat_at,
        }

    async def start(self) -> bool:
        """启动连接并开始心跳"""
        success = await self._try_connect()
        if success:
            self._start_heartbeat()
        return success

    async def stop(self) -> None:
        """停止连接和所有后台任务"""
        self._connected = False
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self._reconnect_task:
            self._reconnect_task.cancel()
        try:
            await self._disconnect_fn()
        except Exception as e:
            logger.error(f"断开连接异常: {e}")

    async def on_connection_lost(self, reason: str = "") -> None:
        """连接断开回调 — 触发重连"""
        logger.warning(f"连接断开: {reason}")
        self._connected = False
        if self._heartbeat_task:
            self._heartbeat_task.cancel()

        if not self._reconnect_task or self._reconnect_task.done():
            self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def _try_connect(self) -> bool:
        """尝试连接"""
        try:
            success = await self._connect_fn()
            if success:
                self._connected = True
                self._consecutive_failures = 0
                logger.info("企微连接成功")
            return success
        except Exception as e:
            logger.error(f"连接失败: {e}")
            return False

    async def _reconnect_loop(self) -> None:
        """指数退避重连"""
        attempt = 0

        while True:
            backoff_idx = min(attempt, len(self._backoff) - 1)
            delay = self._backoff[backoff_idx]
            attempt += 1

            logger.info(f"第 {attempt} 次重连，等待 {delay}s...")
            await asyncio.sleep(delay)

            success = await self._try_connect()
            if success:
                self._total_reconnects += 1
                self._start_heartbeat()
                logger.info(f"重连成功（第 {attempt} 次）")
                return

            self._consecutive_failures += 1

    def _start_heartbeat(self) -> None:
        """启动心跳任务"""
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _heartbeat_loop(self) -> None:
        """心跳循环"""
        try:
            while self._connected:
                await asyncio.sleep(self._heartbeat_interval)

                if not self._connected:
                    break

                if self._heartbeat_fn:
                    try:
                        alive = await asyncio.wait_for(
                            self._heartbeat_fn(),
                            timeout=HEARTBEAT_TIMEOUT,
                        )
                        if alive:
                            self._last_heartbeat_at = time.time()
                            logger.debug("心跳正常")
                        else:
                            logger.warning("心跳失败，触发重连")
                            await self.on_connection_lost("heartbeat_failed")
                            return
                    except asyncio.TimeoutError:
                        logger.warning("心跳超时，触发重连")
                        await self.on_connection_lost("heartbeat_timeout")
                        return
                else:
                    self._last_heartbeat_at = time.time()
        except asyncio.CancelledError:
            pass
