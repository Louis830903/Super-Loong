"""
飞书渠道 — 配置诊断修复适配器（DoctorAdapter 实现）

自动诊断飞书配置问题，如：
- app_id/app_secret 格式校验
- 模式配置一致性检查
- 权限配置检测
"""

import logging
from typing import Optional

from core.types import ChannelConfig, DoctorConfigMutation

logger = logging.getLogger("gateway.feishu.doctor")


class FeishuDoctor:
    """
    飞书配置诊断适配器 — 实现 DoctorAdapter Protocol

    诊断项：
    1. App ID 格式检查（应以 cli_ 开头）
    2. Webhook 模式缺少 verification_token
    3. 空白字段自动清理
    """

    def repair_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """诊断并修复配置问题"""
        patches = []
        changed = False

        creds = config.credentials

        # 1. App ID 格式修复：去除前后空格
        app_id = creds.get("app_id", "")
        if app_id != app_id.strip():
            patches.append({
                "path": "credentials.app_id",
                "old": app_id,
                "new": app_id.strip(),
            })
            changed = True

        # 2. App Secret 格式修复：去除前后空格
        app_secret = creds.get("app_secret", "")
        if app_secret != app_secret.strip():
            patches.append({
                "path": "credentials.app_secret",
                "old": "***",
                "new": "*** (trimmed)",
            })
            changed = True

        # 3. 模式不一致修复：有 verification_token 但模式是 websocket
        mode = creds.get("mode", "websocket")
        has_token = bool(creds.get("verification_token"))
        if mode == "websocket" and has_token:
            patches.append({
                "path": "info",
                "old": "mode=websocket, has verification_token",
                "new": "verification_token 在 WebSocket 模式下可选，但建议移除以避免混淆",
            })

        return DoctorConfigMutation(changed=changed, patches=patches)

    def clean_stale_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """清理过期/无效配置项"""
        warnings = []

        # 检查是否有无效的配置键
        valid_keys = {"app_id", "app_secret", "mode", "verification_token", "encrypt_key"}
        stale_keys = [k for k in config.credentials if k not in valid_keys]

        if stale_keys:
            warnings.append(f"发现未知配置项: {', '.join(stale_keys)}")

        return DoctorConfigMutation(
            changed=False,
            warnings=warnings,
        )

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集配置警告"""
        warnings = []
        creds = config.credentials

        app_id = creds.get("app_id", "")
        if app_id and not app_id.startswith("cli_"):
            warnings.append("App ID 格式异常：通常以 'cli_' 开头")

        mode = creds.get("mode", "websocket")
        if mode == "webhook" and not creds.get("verification_token"):
            warnings.append("Webhook 模式需要配置 Verification Token")

        if not creds.get("encrypt_key"):
            warnings.append("建议配置 Encrypt Key 以提高消息安全性")

        return warnings
