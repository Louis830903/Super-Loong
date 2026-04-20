"""
Super Agent IM Gateway - 健康评估策略

对标 OpenClaw channel-health-policy.ts (evaluateChannelHealth L58-133)
定义 5 级健康状态分类和评估逻辑。
"""

from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Optional, Any

from structured_logger import create_logger
from config_manager import GatewayConfig

logger = create_logger("gateway.health")


class ChannelHealth(Enum):
    """5 级健康状态（对标 OpenClaw）"""
    HEALTHY = "healthy"                # 正常运行，事件流活跃
    STARTUP_GRACE = "startup_grace"    # 启动宽限期内（默认 120s）
    STALE = "stale"                    # 运行但长时间无事件（默认 30min）
    DISCONNECTED = "disconnected"      # 已断开连接
    NOT_RUNNING = "not_running"        # 未启动


# 健康状态的严重程度排序（用于决策）
HEALTH_SEVERITY = {
    ChannelHealth.HEALTHY: 0,
    ChannelHealth.STARTUP_GRACE: 1,
    ChannelHealth.STALE: 2,
    ChannelHealth.DISCONNECTED: 3,
    ChannelHealth.NOT_RUNNING: 4,
}


def evaluate_channel_health(
    *,
    is_registered: bool,
    is_connected: bool,
    connected_at: Optional[str],
    last_event_at: Optional[str],
    manually_stopped: bool,
    has_fatal_error: bool,
    config: GatewayConfig,
) -> ChannelHealth:
    """
    评估单个适配器的健康状态（对标 OpenClaw evaluateChannelHealth）

    评估逻辑按优先级：
    1. 未注册 → NOT_RUNNING
    2. 手动停止 → NOT_RUNNING
    3. 致命错误 / 未连接 → DISCONNECTED
    4. 连接时间在宽限期内 → STARTUP_GRACE
    5. 长时间无事件 → STALE
    6. 正常 → HEALTHY

    Args:
        is_registered: 适配器是否已注册
        is_connected: 适配器是否已连接
        connected_at: 连接时间 ISO8601
        last_event_at: 最后事件时间 ISO8601
        manually_stopped: 是否手动停止
        has_fatal_error: 是否有致命错误
        config: 网关配置（包含各种阈值）
    """
    now = datetime.now(timezone.utc)

    # 1. 未注册
    if not is_registered:
        return ChannelHealth.NOT_RUNNING

    # 2. 手动停止
    if manually_stopped:
        return ChannelHealth.NOT_RUNNING

    # 3. 致命错误或未连接
    if has_fatal_error or not is_connected:
        return ChannelHealth.DISCONNECTED

    # 4. 启动宽限期
    if connected_at:
        try:
            connect_time = datetime.fromisoformat(connected_at)
            grace_delta = timedelta(seconds=config.connect_grace_seconds)
            if now - connect_time < grace_delta:
                return ChannelHealth.STARTUP_GRACE
        except (ValueError, TypeError):
            pass

    # 5. 事件活跃度检查
    if last_event_at:
        try:
            event_time = datetime.fromisoformat(last_event_at)
            stale_delta = timedelta(minutes=config.stale_event_threshold_minutes)
            if now - event_time > stale_delta:
                return ChannelHealth.STALE
        except (ValueError, TypeError):
            pass
    else:
        # 从未收到过事件 — 如果已过宽限期，标记为 STALE
        if connected_at:
            try:
                connect_time = datetime.fromisoformat(connected_at)
                grace_delta = timedelta(seconds=config.connect_grace_seconds)
                if now - connect_time > grace_delta:
                    return ChannelHealth.STALE
            except (ValueError, TypeError):
                pass

    # 6. 正常
    return ChannelHealth.HEALTHY


def should_restart(health: ChannelHealth) -> bool:
    """判断该健康状态是否需要触发重启"""
    return health in (ChannelHealth.DISCONNECTED, ChannelHealth.STALE)


def health_to_dict(health: ChannelHealth) -> dict:
    """将健康状态转为 API 可返回的字典"""
    return {
        "status": health.value,
        "severity": HEALTH_SEVERITY[health],
        "needs_restart": should_restart(health),
    }
