"""
微信渠道 — 安装配置适配器（SetupAdapter 实现）

处理微信特有的 QR 扫码配置流程。
"""

from typing import Optional

from core.types import ChannelConfig


class WeixinSetup:
    """
    微信安装配置适配器 — 实现 SetupAdapter Protocol

    微信配置流程：
    1. 用户填入 iLink Bot API 地址和 Token
    2. 系统发起 QR 扫码登录
    3. 用户扫码确认
    4. 配置完成

    此适配器处理配置应用和输入校验。
    """

    def apply_account_config(self, config: ChannelConfig, input_data: dict) -> ChannelConfig:
        """应用用户输入的配置"""
        # 将用户输入合并到 credentials
        new_creds = dict(config.credentials)
        if "api_url" in input_data:
            new_creds["api_url"] = input_data["api_url"].rstrip("/")
        if "api_token" in input_data:
            new_creds["api_token"] = input_data["api_token"]

        return ChannelConfig(
            channel_id=config.channel_id,
            account_id=config.account_id,
            credentials=new_creds,
            settings=config.settings,
            enabled=config.enabled,
        )

    def validate_input(self, input_data: dict) -> Optional[str]:
        """校验用户输入"""
        api_url = input_data.get("api_url", "")
        if not api_url:
            return "请填入 iLink Bot API 地址"

        if not api_url.startswith(("http://", "https://")):
            return "API 地址需以 http:// 或 https:// 开头"

        api_token = input_data.get("api_token", "")
        if not api_token:
            return "请填入 API Token"

        return None
