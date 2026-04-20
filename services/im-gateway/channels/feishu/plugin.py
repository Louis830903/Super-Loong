"""
飞书渠道 — 插件组装入口

飞书是最完整的参考实现，实现了所有 12 个 Protocol 中的 10 个：
- 基础层（6）：ConfigAdapter / GatewayAdapter / InboundAdapter / OutboundAdapter / HealthAdapter + QrLoginAdapter(×)
- P0 生产级（3）：StatusAdapter / DoctorAdapter + LifecycleAdapter(×, 飞书 token 由 SDK 管理)
- P1 增强级（3）：SecurityAdapter / StreamingAdapter + SetupAdapter(×)
"""

from typing import Optional

from core.contracts import ChannelPlugin
from core.types import ChannelConfig

from .config import FEISHU_CONFIG_SCHEMA, FEISHU_CAPABILITIES
from .gateway import FeishuGateway
from .outbound import FeishuOutbound
from .status import FeishuStatus
from .doctor import FeishuDoctor
from .security import FeishuSecurity
from .streaming import FeishuStreaming


class FeishuConfigAdapter:
    """
    飞书配置适配器 — 实现 ConfigAdapter Protocol

    验证 app_id、app_secret 两项必需凭证。
    """

    REQUIRED_FIELDS = ("app_id", "app_secret")

    def validate(self, credentials: dict) -> Optional[str]:
        """验证凭证完整性"""
        missing = [f for f in self.REQUIRED_FIELDS if not credentials.get(f)]
        if missing:
            return f"缺少必需配置: {', '.join(missing)}"

        # App ID 格式检查
        app_id = credentials.get("app_id", "")
        if app_id and not app_id.startswith("cli_"):
            return "App ID 格式异常（应以 'cli_' 开头）"

        # Webhook 模式需要 verification_token
        mode = credentials.get("mode", "websocket")
        if mode == "webhook" and not credentials.get("verification_token"):
            return "Webhook 模式需要配置 Verification Token"

        return None

    def is_configured(self, credentials: dict) -> bool:
        """判断是否已配置必需凭证"""
        return all(credentials.get(f) for f in self.REQUIRED_FIELDS)


def create_plugin() -> ChannelPlugin:
    """
    创建飞书渠道插件 — 工厂函数

    飞书是最完整的参考实现，组装了最多数量的适配器。
    """
    gateway = FeishuGateway()
    outbound = FeishuOutbound()
    status = FeishuStatus(gateway=gateway)
    doctor = FeishuDoctor()
    security = FeishuSecurity()
    streaming = FeishuStreaming()

    return ChannelPlugin(
        id="feishu",
        label="飞书",
        capabilities=FEISHU_CAPABILITIES,
        config_schema=FEISHU_CONFIG_SCHEMA,
        config_adapter=FeishuConfigAdapter(),
        gateway_adapter=gateway,
        outbound_adapter=outbound,
        inbound_adapter=gateway,           # FeishuGateway 同时实现 InboundAdapter
        health_adapter=gateway,            # FeishuGateway 兼容 HealthAdapter
        status_adapter=status,
        doctor_adapter=doctor,
        security_adapter=security,
        streaming_adapter=streaming,
    )
