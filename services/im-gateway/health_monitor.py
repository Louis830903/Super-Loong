"""
Super Agent IM Gateway - 后台健康巡检器

基于 OpenClaw 声明式插件架构 v2：
- 使用 ChannelRegistry 获取渠道列表
- 通过 ChannelPlugin.gateway_adapter.is_connected 检查连接状态
- 通过 ChannelPlugin.status_adapter.probe_account() 主动探测
"""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import Any, Optional, TYPE_CHECKING

from structured_logger import create_logger
from config_manager import GatewayConfig
from gateway_state import StateManager
from health_policy import ChannelHealth, evaluate_channel_health, should_restart, health_to_dict

if TYPE_CHECKING:
    from core.registry import ChannelRegistry

logger = create_logger("gateway.health")


class HealthMonitor:
    """
    后台健康巡检器

    功能：
    - 巡检间隔：默认 5 分钟（可配置）
    - 冷却机制：重启后等待 2 个巡检周期再次评估
    - 重启限流：每小时最多 N 次重启（默认 10）
    - 启动宽限期：网关启动后 60 秒内不触发巡检
    - 异常隔离：单个渠道巡检失败不影响其他渠道
    """

    def __init__(
        self,
        config: GatewayConfig,
        state_manager: StateManager,
        registry: "ChannelRegistry" = None,
        config_persistence=None,  # 共享的持久化实例，用于自动重启时读取配置
    ):
        self._config = config
        self._state = state_manager
        self._registry = registry
        self._config_persistence = config_persistence
        self._task: Optional[asyncio.Task] = None
        self._running = False

        # 冷却追踪：channel_id -> 剩余冷却巡检次数
        self._cooldown_cycles: dict[str, int] = {}
        # 重启历史：channel_id -> [datetime]
        self._restart_history: dict[str, list[datetime]] = {}
        # 启动时间
        self._started_at = datetime.now(timezone.utc)

    async def start(self) -> None:
        """启动后台巡检任务"""
        if self._running:
            return
        self._running = True
        self._started_at = datetime.now(timezone.utc)
        self._task = asyncio.create_task(self._monitor_loop(), name="health-monitor")
        logger.info("健康巡检已启动",
                     interval_minutes=self._config.health_check_interval_minutes,
                     startup_grace_seconds=self._config.startup_grace_seconds)

    async def stop(self) -> None:
        """停止巡检任务"""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("健康巡检已停止")

    async def _monitor_loop(self) -> None:
        """巡检主循环"""
        grace = self._config.startup_grace_seconds
        logger.info("启动宽限期等待中...", grace_seconds=grace)
        await asyncio.sleep(grace)

        interval = self._config.health_check_interval_minutes * 60

        while self._running:
            try:
                await self._run_health_check()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("巡检循环异常", exc_info=True, error=str(e))

            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break

    async def _run_health_check(self) -> None:
        """执行一轮健康巡检"""
        logger.debug("开始健康巡检...")

        if self._registry:
            for plugin in self._registry.list_plugins():
                try:
                    await self._check_channel(plugin)
                except Exception as e:
                    logger.error("渠道巡检异常", channel=plugin.id, error=str(e))

        # 记录巡检完成
        self._state.record_health_check()

    async def _check_channel(self, plugin) -> None:
        """检查单个渠道的健康状态（新架构）"""
        channel_id = plugin.id
        gw = plugin.gateway_adapter

        is_connected = gw.is_connected
        last_error = gw.last_error

        # 通过 HealthAdapter 获取更多信息（如果支持）
        connected_at = None
        last_event_at = None
        has_fatal = False
        if plugin.health_adapter:
            try:
                connected_at = plugin.health_adapter.connected_at
                last_event_at = plugin.health_adapter.last_event_at
                has_fatal = plugin.health_adapter.has_fatal_error
            except Exception:
                pass

        # 评估健康状态
        health = evaluate_channel_health(
            is_registered=True,
            is_connected=is_connected,
            connected_at=connected_at,
            last_event_at=last_event_at,
            manually_stopped=False,
            has_fatal_error=has_fatal,
            config=self._config,
        )

        logger.info("渠道健康评估",
                     channel=channel_id,
                     health=health.value,
                     connected=is_connected,
                     last_error=last_error)

        # 检查是否需要重启
        if not should_restart(health):
            self._cooldown_cycles.pop(channel_id, None)
            return

        # 冷却期检查
        if channel_id in self._cooldown_cycles:
            remaining = self._cooldown_cycles[channel_id]
            if remaining > 0:
                self._cooldown_cycles[channel_id] = remaining - 1
                logger.info("渠道在冷却期内，跳过重启",
                            channel=channel_id, cooldown_remaining=remaining)
                return
            else:
                del self._cooldown_cycles[channel_id]

        # 重启限流
        if not self._can_restart_channel(channel_id):
            logger.warning("渠道已达每小时重启上限",
                           channel=channel_id,
                           max_per_hour=self._config.max_restarts_per_hour)
            return

        # 执行重启：停止 → 重新启动
        logger.warning("触发渠道自动重启", channel=channel_id, health=health.value)
        try:
            await gw.stop()
            # 从共享的 ConfigPersistence 实例获取配置（通过依赖注入）
            config = self._config_persistence.get(channel_id) if self._config_persistence else None
            if config:
                success = await gw.start(config)
                if success:
                    self._cooldown_cycles[channel_id] = 2
                    self._restart_history.setdefault(channel_id, []).append(
                        datetime.now(timezone.utc)
                    )
                    logger.info("渠道重启成功", channel=channel_id, cooldown_cycles=2)
                else:
                    logger.error("渠道重启失败", channel=channel_id)
            else:
                logger.error("渠道无持久化配置，无法重启", channel=channel_id)
        except Exception as e:
            logger.error("渠道重启异常", channel=channel_id, error=str(e))

    def _can_restart_channel(self, channel_id: str) -> bool:
        """检查渠道是否超过每小时重启限制"""
        history = self._restart_history.get(channel_id, [])
        if not history:
            return True
        one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
        recent = sum(1 for t in history if t > one_hour_ago)
        return recent < self._config.max_restarts_per_hour

    def get_health_snapshot(self) -> dict:
        """获取所有渠道的健康快照（用于 API 返回）"""
        result = {}

        if self._registry:
            for plugin in self._registry.list_plugins():
                gw = plugin.gateway_adapter
                connected_at = None
                last_event_at = None
                has_fatal = False
                if plugin.health_adapter:
                    try:
                        connected_at = plugin.health_adapter.connected_at
                        last_event_at = plugin.health_adapter.last_event_at
                        has_fatal = plugin.health_adapter.has_fatal_error
                    except Exception:
                        pass

                health = evaluate_channel_health(
                    is_registered=True,
                    is_connected=gw.is_connected,
                    connected_at=connected_at,
                    last_event_at=last_event_at,
                    manually_stopped=False,
                    has_fatal_error=has_fatal,
                    config=self._config,
                )
                result[plugin.id] = {
                    **health_to_dict(health),
                    "cooldown_remaining": self._cooldown_cycles.get(plugin.id, 0),
                }

        return result

