"""
钉钉渠道 — 插件组装入口

组装 ChannelPlugin，将 config / gateway / outbound / status 适配器组合在一起。
这是 channels/__init__.py 中 register_all_channels() 调用的工厂函数。
"""

from typing import Optional

from core.contracts import ChannelPlugin
from core.types import ChannelConfig

from .config import DINGTALK_CONFIG_SCHEMA, DINGTALK_CAPABILITIES
from .gateway import DingTalkGateway
from .outbound import DingTalkOutbound
from .status import DingTalkStatus


class DingTalkConfigAdapter:
    """
    钉钉配置适配器 — 实现 ConfigAdapter Protocol

    验证 AppKey、AppSecret、RobotCode 三项必需凭证。
    """

    REQUIRED_FIELDS = ("app_key", "app_secret", "robot_code")

    def validate(self, credentials: dict) -> Optional[str]:
        """验证凭证完整性"""
        missing = [f for f in self.REQUIRED_FIELDS if not credentials.get(f)]
        if missing:
            return f"缺少必需配置: {', '.join(missing)}"
        return None

    def is_configured(self, credentials: dict) -> bool:
        """判断是否已配置必需凭证"""
        return all(credentials.get(f) for f in self.REQUIRED_FIELDS)


def create_plugin() -> ChannelPlugin:
    """
    创建钉钉渠道插件 — 工厂函数

    组装所有适配器到 ChannelPlugin，供 channels/__init__.py 自动注册。
    """
    gateway = DingTalkGateway()
    outbound = DingTalkOutbound()
    status = DingTalkStatus(gateway=gateway)

    return ChannelPlugin(
        id="dingtalk",
        label="钉钉",
        capabilities=DINGTALK_CAPABILITIES,
        config_schema=DINGTALK_CONFIG_SCHEMA,
        config_adapter=DingTalkConfigAdapter(),
        gateway_adapter=gateway,
        outbound_adapter=outbound,
        inbound_adapter=gateway,       # DingTalkGateway 同时实现 InboundAdapter
        status_adapter=status,
    )
