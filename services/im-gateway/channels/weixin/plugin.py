"""
微信渠道 — 插件组装入口

组装 ChannelPlugin，将 config / gateway / outbound / setup 适配器组合在一起。
微信渠道特点：需要 QR 扫码登录 + iLink Bot 桥接。
"""

from typing import Optional

from core.contracts import ChannelPlugin
from core.types import ChannelConfig

from .config import WEIXIN_CONFIG_SCHEMA, WEIXIN_CAPABILITIES
from .gateway import WeixinGateway
from .outbound import WeixinOutbound
from .setup import WeixinSetup


class WeixinConfigAdapter:
    """
    微信配置适配器 — 实现 ConfigAdapter Protocol

    验证 api_url 和 api_token 两项必需凭证。
    """

    REQUIRED_FIELDS = ("api_url", "api_token")

    def validate(self, credentials: dict) -> Optional[str]:
        """验证凭证完整性"""
        missing = [f for f in self.REQUIRED_FIELDS if not credentials.get(f)]
        if missing:
            return f"缺少必需配置: {', '.join(missing)}"

        api_url = credentials.get("api_url", "")
        if not api_url.startswith(("http://", "https://")):
            return "API 地址需以 http:// 或 https:// 开头"

        return None

    def is_configured(self, credentials: dict) -> bool:
        """判断是否已配置必需凭证"""
        return all(credentials.get(f) for f in self.REQUIRED_FIELDS)


def create_plugin() -> ChannelPlugin:
    """
    创建微信渠道插件 — 工厂函数

    组装所有适配器到 ChannelPlugin，供 channels/__init__.py 自动注册。
    微信特有：qr_login_adapter（QR 扫码登录）+ setup_adapter（配置向导）。
    """
    gateway = WeixinGateway()
    outbound = WeixinOutbound()
    setup = WeixinSetup()

    return ChannelPlugin(
        id="weixin",
        label="微信",
        capabilities=WEIXIN_CAPABILITIES,
        config_schema=WEIXIN_CONFIG_SCHEMA,
        config_adapter=WeixinConfigAdapter(),
        gateway_adapter=gateway,
        outbound_adapter=outbound,
        inbound_adapter=gateway,           # WeixinGateway 同时实现 InboundAdapter
        qr_login_adapter=gateway,          # WeixinGateway 同时实现 QrLoginAdapter
        setup_adapter=setup,               # 微信有安装配置向导
    )
