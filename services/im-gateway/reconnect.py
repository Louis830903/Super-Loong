"""
Super Agent IM Gateway - 自动重连引擎

对标 OpenClaw backoff.ts + reconnect gating：
- 指数退避重连（base=5s, max=300s, factor=2x, jitter=0.1）
- 不可重连错误分类（认证失败、平台封禁等）
- 最大重试次数限制
- 与 HealthMonitor 协作
"""

import asyncio
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Awaitable, Optional

from structured_logger import create_logger
from config_manager import GatewayConfig

logger = create_logger("gateway.reconnect")


# ─── 指数退避策略 ────────────────────────────────────────────

@dataclass
class BackoffPolicy:
    """
    指数退避计算器（对标 OpenClaw BackoffPolicy）

    默认参数：base=5s, max=300s, factor=2x, jitter=0.1
    """
    base_ms: int = 5000
    max_ms: int = 300_000  # 5 分钟
    factor: float = 2.0
    jitter: float = 0.1

    def compute(self, attempt: int) -> float:
        """
        计算第 N 次重试的延迟秒数

        Args:
            attempt: 当前重试次数（从 1 开始）

        Returns:
            延迟秒数（含抖动）
        """
        delay = self.base_ms * (self.factor ** (attempt - 1))
        delay = min(delay, self.max_ms)
        # 添加随机抖动，避免多个适配器同时重连
        jitter_range = delay * self.jitter
        delay += jitter_range * (2 * random.random() - 1)  # [-jitter, +jitter]
        return max(delay / 1000, 0.1)  # 最少 100ms

    @classmethod
    def from_config(cls, config: GatewayConfig) -> "BackoffPolicy":
        """从配置创建退避策略"""
        return cls(
            base_ms=config.backoff_base_ms,
            max_ms=config.backoff_max_ms,
            factor=config.backoff_factor,
            jitter=config.backoff_jitter,
        )


# ─── 错误分类 ────────────────────────────────────────────────

class ErrorCategory(Enum):
    """错误分类（对标 OpenClaw reconnect-gating）"""
    RETRYABLE = "retryable"          # 可重试：网络超时、暂时不可用
    NON_RETRYABLE = "non_retryable"  # 不可重试：认证失败、平台封禁
    UNKNOWN = "unknown"              # 未知错误，默认可重试


# 不可重连的错误关键词
_NON_RETRYABLE_PATTERNS = [
    "auth",
    "token_expired",
    "token_invalid",
    "unauthorized",
    "forbidden",
    "banned",
    "revoked",
    "invalid_credentials",
    "permission_denied",
    "account_disabled",
]


def classify_error(error: Exception) -> ErrorCategory:
    """
    对错误进行分类，判断是否可以重试

    Args:
        error: 捕获的异常

    Returns:
        错误分类
    """
    error_str = str(error).lower()

    for pattern in _NON_RETRYABLE_PATTERNS:
        if pattern in error_str:
            return ErrorCategory.NON_RETRYABLE

    # 常见可重试场景
    retryable_indicators = [
        "timeout", "connection", "reset", "refused",
        "temporary", "unavailable", "503", "502",
        "network", "dns", "socket",
    ]
    for indicator in retryable_indicators:
        if indicator in error_str:
            return ErrorCategory.RETRYABLE

    return ErrorCategory.UNKNOWN


# ─── 重连任务 ────────────────────────────────────────────────

@dataclass
class ReconnectTask:
    """单个适配器的重连状态"""
    platform: str
    attempt: int = 0
    max_attempts: int = 10
    is_running: bool = False
    last_error: Optional[str] = None
    gave_up: bool = False
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)

    def reset(self) -> None:
        """重置重连状态（连接成功后调用）"""
        self.attempt = 0
        self.is_running = False
        self.last_error = None
        self.gave_up = False
        self.abort_event = asyncio.Event()

    def to_dict(self) -> dict:
        """转为 API 可返回的字典"""
        return {
            "platform": self.platform,
            "attempt": self.attempt,
            "max_attempts": self.max_attempts,
            "is_reconnecting": self.is_running,
            "last_error": self.last_error,
            "gave_up": self.gave_up,
        }


class ReconnectEngine:
    """
    自动重连引擎

    管理所有适配器的重连任务，提供指数退避、
    错误分类、最大重试次数限制等能力。
    """

    def __init__(self, config: GatewayConfig):
        self._config = config
        self._backoff = BackoffPolicy.from_config(config)
        self._tasks: dict[str, ReconnectTask] = {}
        self._async_tasks: dict[str, asyncio.Task] = {}
        # 重启历史：platform -> [datetime, ...]
        self._restart_history: dict[str, list[datetime]] = {}

    def get_restart_history(self, platform: str) -> list[datetime]:
        """获取适配器的重启历史时间戳列表"""
        return self._restart_history.get(platform, [])

    def get_status(self, platform: str) -> Optional[dict]:
        """获取适配器的重连状态"""
        task = self._tasks.get(platform)
        return task.to_dict() if task else None

    def get_all_status(self) -> dict[str, dict]:
        """获取所有适配器的重连状态"""
        return {p: t.to_dict() for p, t in self._tasks.items()}

    async def schedule_reconnect(
        self,
        platform: str,
        connect_fn: Callable[[], Awaitable[bool]],
        error: Optional[Exception] = None,
    ) -> None:
        """
        为指定适配器调度重连

        Args:
            platform: 平台名称
            connect_fn: 异步连接函数，成功返回 True
            error: 导致断开的错误（用于分类）
        """
        # 错误分类
        if error:
            category = classify_error(error)
            if category == ErrorCategory.NON_RETRYABLE:
                logger.error("不可重试错误，放弃重连",
                             platform=platform,
                             error=str(error),
                             category=category.value)
                task = self._get_or_create_task(platform)
                task.gave_up = True
                task.last_error = str(error)
                return

        task = self._get_or_create_task(platform)

        # 已在重连中，跳过
        if task.is_running:
            logger.debug("重连已在进行中", platform=platform, attempt=task.attempt)
            return

        # 已达最大重试次数
        if task.attempt >= task.max_attempts:
            logger.error("已达最大重连次数，放弃",
                         platform=platform,
                         max_attempts=task.max_attempts)
            task.gave_up = True
            return

        # 启动异步重连任务
        task.is_running = True
        task.last_error = str(error) if error else None

        async_task = asyncio.create_task(
            self._reconnect_loop(platform, connect_fn),
            name=f"reconnect-{platform}",
        )
        self._async_tasks[platform] = async_task

    async def cancel_reconnect(self, platform: str) -> None:
        """取消指定适配器的重连任务"""
        task = self._tasks.get(platform)
        if task:
            task.abort_event.set()
            task.is_running = False

        async_task = self._async_tasks.pop(platform, None)
        if async_task and not async_task.done():
            async_task.cancel()
            try:
                await async_task
            except asyncio.CancelledError:
                pass

        logger.info("重连任务已取消", platform=platform)

    async def cancel_all(self) -> None:
        """取消所有重连任务"""
        for platform in list(self._async_tasks.keys()):
            await self.cancel_reconnect(platform)

    def reset_platform(self, platform: str) -> None:
        """重置平台的重连状态（连接成功后调用）"""
        task = self._tasks.get(platform)
        if task:
            task.reset()

    async def _reconnect_loop(
        self,
        platform: str,
        connect_fn: Callable[[], Awaitable[bool]],
    ) -> None:
        """重连循环（在独立 Task 中执行）"""
        task = self._tasks[platform]

        while task.attempt < task.max_attempts and not task.abort_event.is_set():
            task.attempt += 1
            delay = self._backoff.compute(task.attempt)

            logger.info("重连等待中...",
                        platform=platform,
                        attempt=task.attempt,
                        max_attempts=task.max_attempts,
                        delay_seconds=round(delay, 1))

            # 可中断等待
            try:
                await asyncio.wait_for(
                    task.abort_event.wait(),
                    timeout=delay,
                )
                # abort_event 被设置，退出
                logger.info("重连被中断", platform=platform)
                break
            except asyncio.TimeoutError:
                # 正常：等待超时，继续执行重连
                pass

            # 尝试连接
            try:
                logger.info("尝试重连...",
                            platform=platform,
                            attempt=task.attempt)
                success = await connect_fn()
                if success:
                    logger.info("重连成功!",
                                platform=platform,
                                total_attempts=task.attempt)
                    # 记录重启历史
                    self._record_restart(platform)
                    task.reset()
                    return
                else:
                    logger.warning("重连返回失败",
                                   platform=platform,
                                   attempt=task.attempt)
            except Exception as e:
                category = classify_error(e)
                logger.error("重连异常",
                             platform=platform,
                             attempt=task.attempt,
                             error=str(e),
                             category=category.value)

                if category == ErrorCategory.NON_RETRYABLE:
                    logger.error("遇到不可重试错误，停止重连", platform=platform)
                    task.gave_up = True
                    task.last_error = str(e)
                    break

                task.last_error = str(e)

        # 循环结束
        if task.attempt >= task.max_attempts:
            logger.error("重连已达最大次数，放弃",
                         platform=platform,
                         max_attempts=task.max_attempts)
            task.gave_up = True

        task.is_running = False

    def _get_or_create_task(self, platform: str) -> ReconnectTask:
        """获取或创建重连任务"""
        if platform not in self._tasks:
            self._tasks[platform] = ReconnectTask(
                platform=platform,
                max_attempts=self._config.max_reconnect_attempts,
            )
        return self._tasks[platform]

    def _record_restart(self, platform: str) -> None:
        """记录重启时间"""
        if platform not in self._restart_history:
            self._restart_history[platform] = []
        self._restart_history[platform].append(datetime.now(timezone.utc))
        # 只保留最近 24 小时的记录
        cutoff = datetime.now(timezone.utc) - __import__("datetime").timedelta(hours=24)
        self._restart_history[platform] = [
            t for t in self._restart_history[platform] if t > cutoff
        ]
