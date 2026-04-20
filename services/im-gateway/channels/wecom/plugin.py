"""
企业微信渠道 — 插件组装入口

组装 ChannelPlugin，将 config / gateway / outbound / status / lifecycle 适配器组合在一起。
"""

from typing import Optional

from core.contracts import ChannelPlugin
from core.types import ChannelConfig

from .config import WECOM_CONFIG_SCHEMA, WECOM_CAPABILITIES
from .gateway import WeComGateway
from .outbound import WeComOutbound
from .status import WeComStatus
from .lifecycle import WeComLifecycle


class WeComConfigAdapter:
    """
    企微配置适配器 — 实现 ConfigAdapter Protocol

    验证 corp_id、app_secret、agent_id 三项必需凭证。
    """

    REQUIRED_FIELDS = ("corp_id", "app_secret", "agent_id")

    def validate(self, credentials: dict) -> Optional[str]:
        """验证凭证完整性"""
        missing = [f for f in self.REQUIRED_FIELDS if not credentials.get(f)]
        if missing:
            return f"缺少必需配置: {', '.join(missing)}"

        # WebSocket 模式额外检查
        if credentials.get("bot_id") and not credentials.get("bot_secret"):
            return "配置了 Bot ID 但缺少 Bot Secret"

        return None

    def is_configured(self, credentials: dict) -> bool:
        """判断是否已配置必需凭证"""
        return all(credentials.get(f) for f in self.REQUIRED_FIELDS)


def create_plugin() -> ChannelPlugin:
    """
    创建企微渠道插件 — 工厂函数

    组装所有适配器到 ChannelPlugin，供 channels/__init__.py 自动注册。
    """
    gateway = WeComGateway()
    outbound = WeComOutbound()
    status = WeComStatus(gateway=gateway)
    lifecycle = WeComLifecycle(gateway=gateway, outbound=outbound)

    return ChannelPlugin(
        id="wecom",
        label="企业微信",
        capabilities=WECOM_CAPABILITIES,
        config_schema=WECOM_CONFIG_SCHEMA,
        config_adapter=WeComConfigAdapter(),
        gateway_adapter=gateway,
        outbound_adapter=outbound,
        inbound_adapter=gateway,       # WeComGateway 同时实现 InboundAdapter
        health_adapter=gateway,        # WeComGateway 兼容 HealthAdapter 属性
        status_adapter=status,
        lifecycle_adapter=lifecycle,
    )
