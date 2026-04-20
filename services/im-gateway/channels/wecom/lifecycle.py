"""
企业微信渠道 — 生命周期钩子适配器（LifecycleAdapter 实现）

处理配置变更（token 刷新、连接重建）、账户清理、启动维护。
"""

import logging
from typing import Optional

from core.types import ChannelConfig

logger = logging.getLogger("gateway.wecom.lifecycle")


class WeComLifecycle:
    """
    企微生命周期适配器 — 实现 LifecycleAdapter Protocol

    主要职责：
    1. 配置变更时重建连接（corp_id/secret/bot_id 变化需要重连 WebSocket）
    2. 账户移除时清理 WebSocket 连接和 HTTP 客户端
    3. 启动时检查并刷新过期的 access_token
    """

    def __init__(self, gateway=None, outbound=None):
        self._gateway = gateway
        self._outbound = outbound

    async def on_config_changed(
        self, prev_config: ChannelConfig, next_config: ChannelConfig
    ) -> None:
        """
        配置变更钩子

        检测关键凭证变化，必要时重建连接：
        - corp_id/app_secret 变化 → 刷新 token
        - bot_id/bot_secret 变化 → 重建 WebSocket 连接
        """
        prev_creds = prev_config.credentials
        next_creds = next_config.credentials

        # 检查 WebSocket 相关凭证是否变化
        ws_keys = ("bot_id", "bot_secret", "websocket_url")
        ws_changed = any(prev_creds.get(k) != next_creds.get(k) for k in ws_keys)

        if ws_changed and self._gateway:
            logger.info("企微 WebSocket 凭证变更，重建连接")
            await self._gateway.stop()
            await self._gateway.start(next_config)

        # 检查 API 凭证是否变化（需要刷新 token）
        api_keys = ("corp_id", "app_secret")
        api_changed = any(prev_creds.get(k) != next_creds.get(k) for k in api_keys)

        if api_changed and self._outbound:
            logger.info("企微 API 凭证变更，重新配置 outbound")
            self._outbound.configure(next_config)

    async def on_account_removed(self, config: ChannelConfig) -> None:
        """账户移除钩子 — 清理连接和客户端"""
        if self._gateway:
            await self._gateway.stop()
        if self._outbound and hasattr(self._outbound, "close"):
            await self._outbound.close()
        logger.info("企微账户已清理")

    async def run_startup_maintenance(self, config: ChannelConfig) -> None:
        """启动维护 — 预热 access_token"""
        if self._outbound:
            self._outbound.configure(config)
            logger.info("企微启动维护完成: outbound 已配置")
