"""
Super Agent IM Gateway - 适配器管理器（ChannelManager）

对标 OpenClaw createChannelManager (L183-694)：
- AdapterRuntime 完整运行时状态追踪
- 手动停止标记防止自动重连
- 重启历史滑动窗口实现每小时限流
- abort_event 支持任何阶段取消
- 与 HealthMonitor + ReconnectEngine 协作
"""

import asyncio
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Dict, Optional, Any, Callable, Awaitable

from structured_logger import create_logger, new_trace_id
from gateway_state import StateManager

logger = create_logger("gateway.adapter")

# 动态导入 Hermes 适配器
try:
    from gateway.platforms.base import BasePlatformAdapter, MessageEvent, SendResult
    from gateway.config import Platform, PlatformConfig
    from gateway.session import SessionSource
    HERMES_AVAILABLE = True
except ImportError:
    HERMES_AVAILABLE = False
    logger.warning("Hermes 适配器模块未找到，请设置 HERMES_PATH 环境变量")


# 消息处理回调类型: async def handler(platform, event) -> str
MessageHandler = Callable[[str, Any], Awaitable[str]]


@dataclass
class AdapterRuntime:
    """每个适配器的运行时状态追踪（对标 OpenClaw ChannelRuntime）"""
    platform: str
    config: dict = field(default_factory=dict)
    adapter: Any = None  # Hermes BasePlatformAdapter 实例
    status: str = "not_running"  # connected / disconnected / reconnecting / error / stopped / not_running
    connected_at: Optional[str] = None  # ISO8601
    last_event_at: Optional[str] = None  # ISO8601
    last_error: Optional[str] = None
    restart_attempts: int = 0
    restart_history: list = field(default_factory=list)  # [datetime, ...]
    manually_stopped: bool = False  # 手动停止标记，防止自动重连
    abort_event: asyncio.Event = field(default_factory=asyncio.Event)

    def to_dict(self) -> dict:
        """转为 API 可返回的字典"""
        return {
            "platform": self.platform,
            "status": self.status,
            "connected_at": self.connected_at,
            "last_event_at": self.last_event_at,
            "last_error": self.last_error,
            "restart_attempts": self.restart_attempts,
            "manually_stopped": self.manually_stopped,
            "is_connected": self.adapter.is_connected if self.adapter else False,
            "has_fatal_error": self.adapter.has_fatal_error if self.adapter else False,
        }


class AdapterManager:
    """
    IM 平台适配器生命周期管理器（ChannelManager）

    管理所有适配器的注册、启停、重启、状态追踪。
    与 HealthMonitor 和 ReconnectEngine 协作实现自动恢复。
    """

    def __init__(self, state_manager: Optional[StateManager] = None):
        self._runtimes: Dict[str, AdapterRuntime] = {}
        self._message_handler: Optional[MessageHandler] = None
        self._tasks: Dict[str, asyncio.Task] = {}
        self._state_manager = state_manager

    def set_message_handler(self, handler: MessageHandler):
        """设置全局消息处理回调"""
        self._message_handler = handler

    def set_state_manager(self, sm: StateManager) -> None:
        """注入状态管理器（延迟设置）"""
        self._state_manager = sm

    async def register_adapter(self, platform_name: str, config: Dict[str, Any]) -> bool:
        """
        注册并启动一个平台适配器

        Args:
            platform_name: 平台名称 (wecom/feishu/dingtalk/weixin/telegram/...)
            config: 平台配置字典

        Returns:
            是否注册成功
        """
        if not HERMES_AVAILABLE:
            logger.error("Hermes 不可用，无法注册适配器")
            return False

        if platform_name in self._runtimes:
            logger.warning("适配器已存在，先停止旧实例", platform=platform_name)
            await self.stop_adapter(platform_name, manual=False)

        try:
            adapter = self._create_adapter(platform_name, config)
            if not adapter:
                return False

            # 创建运行时状态
            runtime = AdapterRuntime(
                platform=platform_name,
                config=config,
                adapter=adapter,
                status="connecting",
            )
            self._runtimes[platform_name] = runtime

            # 设置消息处理器
            if self._message_handler:
                async def on_message(event: MessageEvent, _p=platform_name):
                    return await self._handle_adapter_message(_p, event)
                adapter.set_message_handler(on_message)

            # 连接
            connected = await adapter.connect()
            if not connected:
                runtime.status = "error"
                runtime.last_error = adapter.fatal_error_message if adapter.has_fatal_error else "Connection failed"
                logger.error("适配器连接失败",
                             platform=platform_name,
                             fatal=adapter.has_fatal_error,
                             error=runtime.last_error)
                self._update_state(platform_name, runtime)
                return False

            # 连接成功
            runtime.status = "connected"
            runtime.connected_at = datetime.now(timezone.utc).isoformat()
            runtime.last_error = None
            runtime.manually_stopped = False
            logger.info("适配器已注册并连接", platform=platform_name)
            self._update_state(platform_name, runtime)

            # 通知状态管理器
            if self._state_manager:
                self._state_manager.record_adapter_connected(platform_name)

            return True

        except Exception as e:
            logger.error("适配器注册失败", platform=platform_name, error=str(e))
            if platform_name in self._runtimes:
                self._runtimes[platform_name].status = "error"
                self._runtimes[platform_name].last_error = str(e)
            return False

    async def stop_adapter(self, platform_name: str, manual: bool = True) -> None:
        """
        停止适配器（优雅关闭，5 秒超时强制终止）

        Args:
            manual: 是否为手动停止（手动停止会阻止自动重连）
        """
        runtime = self._runtimes.get(platform_name)
        if not runtime:
            return

        # 设置中止信号
        runtime.abort_event.set()

        if runtime.adapter:
            try:
                await asyncio.wait_for(runtime.adapter.disconnect(), timeout=5.0)
                logger.info("适配器已断开", platform=platform_name, manual=manual)
            except asyncio.TimeoutError:
                logger.warning("适配器断开超时，强制终止", platform=platform_name)
            except Exception as e:
                logger.error("适配器断开异常", platform=platform_name, error=str(e))

        # 取消关联的异步任务
        task = self._tasks.pop(platform_name, None)
        if task and not task.done():
            task.cancel()

        # 更新状态
        runtime.status = "stopped" if manual else "disconnected"
        runtime.manually_stopped = manual

        # 通知状态管理器
        if self._state_manager:
            self._state_manager.record_adapter_disconnected(
                platform_name,
                error=runtime.last_error,
                manual=manual,
            )

    async def restart_adapter(self, platform_name: str) -> bool:
        """
        重启适配器：先 stop 再 start，保留 restart_attempts 计数

        Returns:
            是否重启成功
        """
        runtime = self._runtimes.get(platform_name)
        if not runtime:
            logger.error("适配器不存在，无法重启", platform=platform_name)
            return False

        saved_config = runtime.config
        runtime.restart_attempts += 1
        runtime.restart_history.append(datetime.now(timezone.utc))

        logger.info("开始重启适配器",
                     platform=platform_name,
                     attempt=runtime.restart_attempts)

        # 通知状态管理器
        if self._state_manager:
            self._state_manager.record_adapter_reconnecting(
                platform_name, runtime.restart_attempts)

        # 停止旧实例
        await self.stop_adapter(platform_name, manual=False)

        # 重新注册（会创建新的 runtime）
        success = await self.register_adapter(platform_name, saved_config)

        # 恢复重启计数
        if platform_name in self._runtimes:
            new_runtime = self._runtimes[platform_name]
            new_runtime.restart_attempts = runtime.restart_attempts
            new_runtime.restart_history = runtime.restart_history

        return success

    async def stop_all(self) -> None:
        """停止所有适配器"""
        for name in list(self._runtimes.keys()):
            await self.stop_adapter(name, manual=False)
        self._runtimes.clear()

    def record_event(self, platform_name: str) -> None:
        """记录适配器收到事件（更新 last_event_at）"""
        runtime = self._runtimes.get(platform_name)
        if runtime:
            runtime.last_event_at = datetime.now(timezone.utc).isoformat()
            if self._state_manager:
                self._state_manager.record_adapter_event(platform_name)

    def get_status(self) -> Dict[str, Any]:
        """获取所有适配器状态（向后兼容旧格式）"""
        result = {}
        for name, runtime in self._runtimes.items():
            result[name] = {
                "connected": runtime.adapter.is_connected if runtime.adapter else False,
                "has_error": runtime.adapter.has_fatal_error if runtime.adapter else False,
                "error_message": runtime.last_error,
            }
        return result

    def list_adapters(self) -> list:
        """列出所有已注册的适配器（向后兼容旧格式）"""
        return [
            {
                "platform": name,
                "connected": rt.adapter.is_connected if rt.adapter else False,
                "has_error": rt.adapter.has_fatal_error if rt.adapter else False,
            }
            for name, rt in self._runtimes.items()
        ]

    def get_runtime_snapshot(self) -> dict:
        """返回所有适配器的运行时状态快照（用于 API 返回）"""
        return {name: rt.to_dict() for name, rt in self._runtimes.items()}

    def get_all_runtimes(self) -> dict:
        """返回所有适配器的运行时信息字典（供 HealthMonitor 使用）"""
        result = {}
        for name, rt in self._runtimes.items():
            result[name] = {
                "is_connected": rt.adapter.is_connected if rt.adapter else False,
                "connected_at": rt.connected_at,
                "last_event_at": rt.last_event_at,
                "manually_stopped": rt.manually_stopped,
                "has_fatal_error": rt.adapter.has_fatal_error if rt.adapter else False,
            }
        return result

    def get_restart_history(self, platform: str) -> list:
        """获取适配器的重启历史（供 HealthMonitor 判断限流）"""
        runtime = self._runtimes.get(platform)
        return runtime.restart_history if runtime else []

    # ── 内部方法 ─────────────────────────────────────────

    def _create_adapter(self, platform_name: str, config: Dict[str, Any]) -> Optional[Any]:
        """根据平台名创建适配器实例"""
        platform_config = PlatformConfig(
            enabled=True,
            token=config.get("token", ""),
            api_key=config.get("api_key", ""),
            home_channel=config.get("home_channel", ""),
            extra=config.get("extra", {}),
        )

        try:
            if platform_name == "wecom":
                from gateway.platforms.wecom import WeComAdapter
                return WeComAdapter(platform_config)
            elif platform_name == "feishu":
                from gateway.platforms.feishu import FeishuAdapter
                return FeishuAdapter(platform_config)
            elif platform_name == "dingtalk":
                from gateway.platforms.dingtalk import DingTalkAdapter
                return DingTalkAdapter(platform_config)
            elif platform_name == "weixin":
                from gateway.platforms.weixin import WeixinAdapter
                return WeixinAdapter(platform_config)
            elif platform_name == "telegram":
                from gateway.platforms.telegram import TelegramAdapter
                return TelegramAdapter(platform_config)
            elif platform_name == "discord":
                from gateway.platforms.discord import DiscordAdapter
                return DiscordAdapter(platform_config)
            elif platform_name == "slack":
                from gateway.platforms.slack import SlackAdapter
                return SlackAdapter(platform_config)
            elif platform_name == "webhook":
                from gateway.platforms.webhook import WebhookAdapter
                return WebhookAdapter(platform_config)
            else:
                logger.error("未知平台", platform=platform_name)
                return None
        except ImportError as e:
            logger.error("平台依赖缺失", platform=platform_name, error=str(e))
            return None

    async def _handle_adapter_message(self, platform_name: str, event: Any) -> str:
        """处理适配器收到的消息"""
        if not self._message_handler:
            return ""

        # 记录事件时间（供 HealthMonitor 判断活跃度）
        self.record_event(platform_name)

        # 为消息生成追踪 ID
        trace_id = new_trace_id()

        try:
            reply = await self._message_handler(platform_name, event)
            return reply
        except Exception as e:
            logger.error("消息处理异常", platform=platform_name, error=str(e))
            return "处理消息时出错，请稍后重试。"

    def _update_state(self, platform: str, runtime: AdapterRuntime) -> None:
        """同步运行时状态到状态管理器"""
        if self._state_manager:
            self._state_manager.update_adapter(
                platform,
                status=runtime.status,
                connected_at=runtime.connected_at,
                last_event_at=runtime.last_event_at,
                last_error=runtime.last_error,
                manually_stopped=runtime.manually_stopped,
            )

    @staticmethod
    def supported_platforms() -> list:
        """返回支持的平台列表"""
        return [
            {"id": "wecom", "name": "企业微信", "requires": ["WECOM_BOT_ID", "WECOM_SECRET"]},
            {"id": "feishu", "name": "飞书", "requires": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]},
            {"id": "dingtalk", "name": "钉钉", "requires": ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"]},
            {"id": "weixin", "name": "微信", "requires": ["WEIXIN_ACCOUNT_ID"]},
            {"id": "telegram", "name": "Telegram", "requires": ["TELEGRAM_BOT_TOKEN"]},
            {"id": "discord", "name": "Discord", "requires": ["DISCORD_BOT_TOKEN"]},
            {"id": "slack", "name": "Slack", "requires": ["SLACK_BOT_TOKEN"]},
            {"id": "webhook", "name": "Webhook", "requires": []},
        ]
