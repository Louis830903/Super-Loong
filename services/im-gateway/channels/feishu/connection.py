"""
⚠️ DEPRECATED — 本文件为孤岛代码，未被任何模块导入或注册。

飞书连接增强 — WebSocket 断线重连 + Webhook 双模式切换（原设计）

当前架构已迁移至 OpenClaw 插件体系，WebSocket 连接管理已内置于:
- feishu/gateway.py: FeishuGateway._run_ws_in_thread() → SDK 原生 WS
- bridge.py: AgentBridge._connect_ws() → Gateway WS

本文件保留仅供参考，计划在后续版本中移除。
"""

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Coroutine, Dict, Optional

logger = logging.getLogger("feishu.connection")

# 指数退避重连间隔（秒）
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
# 最大重连次数（0 = 无限）
MAX_RECONNECT_ATTEMPTS = 0
# 健康检查间隔（秒）
HEALTH_CHECK_INTERVAL = 30


class ConnectionManager:
    """
    飞书连接管理增强层。

    封装重连逻辑和连接健康监控，可与 FeishuGateway 配合使用。
    """

    def __init__(
        self,
        connect_fn: Callable[[], Coroutine[Any, Any, bool]],
        disconnect_fn: Callable[[], Coroutine[Any, Any, None]],
        *,
        backoff: list[float] = RECONNECT_BACKOFF,
        max_attempts: int = MAX_RECONNECT_ATTEMPTS,
    ):
        self._connect_fn = connect_fn
        self._disconnect_fn = disconnect_fn
        self._backoff = backoff
        self._max_attempts = max_attempts

        self._connected = False
        self._reconnect_task: Optional[asyncio.Task] = None
        self._health_task: Optional[asyncio.Task] = None
        self._attempt_count = 0
        self._last_connected_at: Optional[float] = None
        self._total_reconnects = 0
        self._on_status_change: Optional[Callable] = None

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def stats(self) -> Dict[str, Any]:
        """连接统计信息"""
        return {
            "connected": self._connected,
            "total_reconnects": self._total_reconnects,
            "current_attempt": self._attempt_count,
            "last_connected_at": self._last_connected_at,
            "uptime_seconds": (
                time.time() - self._last_connected_at
                if self._connected and self._last_connected_at
                else 0
            ),
        }

    def on_status_change(self, callback: Callable[[bool, str], None]) -> None:
        """注册连接状态变化回调"""
        self._on_status_change = callback

    async def start(self) -> bool:
        """建立连接（首次连接）"""
        success = await self._try_connect()
        if success:
            self._start_health_check()
        return success

    async def stop(self) -> None:
        """停止连接和所有后台任务"""
        if self._reconnect_task and not self._reconnect_task.done():
            self._reconnect_task.cancel()
        if self._health_task and not self._health_task.done():
            self._health_task.cancel()

        try:
            await self._disconnect_fn()
        except Exception as e:
            logger.error(f"断开连接异常: {e}")

        self._connected = False
        self._notify_status(False, "stopped")

    async def trigger_reconnect(self, reason: str = "manual") -> None:
        """触发重连（外部调用，如检测到连接异常）"""
        logger.info(f"触发重连: {reason}")
        self._connected = False
        self._notify_status(False, reason)

        if self._reconnect_task and not self._reconnect_task.done():
            return  # 已有重连任务在运行

        self._reconnect_task = asyncio.create_task(self._reconnect_loop())

    async def _try_connect(self) -> bool:
        """尝试连接一次"""
        try:
            success = await self._connect_fn()
            if success:
                self._connected = True
                self._attempt_count = 0
                self._last_connected_at = time.time()
                self._notify_status(True, "connected")
                logger.info("连接成功")
            return success
        except Exception as e:
            logger.error(f"连接失败: {e}")
            return False

    async def _reconnect_loop(self) -> None:
        """指数退避重连循环"""
        self._attempt_count = 0

        while True:
            if self._max_attempts > 0 and self._attempt_count >= self._max_attempts:
                logger.error(f"达到最大重连次数 {self._max_attempts}，放弃重连")
                self._notify_status(False, "max_attempts_reached")
                return

            # 计算退避时间
            backoff_idx = min(self._attempt_count, len(self._backoff) - 1)
            delay = self._backoff[backoff_idx]
            self._attempt_count += 1

            logger.info(f"第 {self._attempt_count} 次重连，等待 {delay}s...")
            await asyncio.sleep(delay)

            success = await self._try_connect()
            if success:
                self._total_reconnects += 1
                logger.info(f"重连成功（第 {self._attempt_count} 次尝试）")
                return

    def _start_health_check(self) -> None:
        """启动周期性健康检查"""
        if self._health_task and not self._health_task.done():
            return
        self._health_task = asyncio.create_task(self._health_check_loop())

    async def _health_check_loop(self) -> None:
        """周期性检查连接健康度"""
        try:
            while True:
                await asyncio.sleep(HEALTH_CHECK_INTERVAL)
                if not self._connected:
                    continue
                # 健康检查逻辑：可根据实际需要扩展
                logger.debug("连接健康检查通过")
        except asyncio.CancelledError:
            pass

    def _notify_status(self, connected: bool, reason: str) -> None:
        """通知状态变化"""
        if self._on_status_change:
            try:
                self._on_status_change(connected, reason)
            except Exception:
                pass


class AppMutex:
    """
    飞书应用互斥锁。

    防止多个进程同时使用同一个飞书应用（同一 app_id 只能有一个 WebSocket 连接）。
    使用文件锁实现。
    """

    def __init__(self, app_id: str, lock_dir: Optional[str] = None):
        self._app_id = app_id
        lock_dir = lock_dir or os.path.expanduser("~/.super-agent/locks")
        self._lock_path = Path(lock_dir) / f"feishu_{app_id}.lock"
        self._lock_path.parent.mkdir(parents=True, exist_ok=True)

    def acquire(self) -> bool:
        """
        获取互斥锁。

        Returns:
            True 获取成功，False 表示已有其他进程占用
        """
        try:
            if self._lock_path.exists():
                # 检查锁文件中的 PID 是否仍在运行
                pid = int(self._lock_path.read_text().strip())
                if self._is_process_alive(pid):
                    logger.warning(f"飞书应用 {self._app_id} 已被进程 {pid} 占用")
                    return False
                # PID 不存在，清理过期锁
                logger.info(f"清理过期锁: PID {pid}")

            self._lock_path.write_text(str(os.getpid()))
            return True
        except Exception as e:
            logger.error(f"获取互斥锁失败: {e}")
            return False

    def release(self) -> None:
        """释放互斥锁"""
        try:
            if self._lock_path.exists():
                pid = int(self._lock_path.read_text().strip())
                if pid == os.getpid():
                    self._lock_path.unlink()
        except Exception as e:
            logger.error(f"释放互斥锁失败: {e}")

    @staticmethod
    def _is_process_alive(pid: int) -> bool:
        """检查进程是否存活"""
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False

    def __enter__(self):
        if not self.acquire():
            raise RuntimeError(f"飞书应用 {self._app_id} 已被其他进程占用")
        return self

    def __exit__(self, *args):
        self.release()
