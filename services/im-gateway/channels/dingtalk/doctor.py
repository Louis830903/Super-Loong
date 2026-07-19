"""
钉钉渠道 — 配置诊断修复适配器（DoctorAdapter 实现）

对齐飞书 FeishuDoctor 的三方法契约：
- repair_config：可自动修复项（去空格等）
- clean_stale_config：清理未知配置键
- collect_warnings：收集配置警告

钉钉使用 Stream 长连接模式（dingtalk-stream SDK），凭证为
app_key / app_secret / robot_code；无 HTTP 回调，故无 webhook 相关项。
"""

import logging
from typing import Optional

from core.types import ChannelConfig, DoctorConfigMutation

logger = logging.getLogger("gateway.dingtalk.doctor")


class DingTalkDoctor:
    """
    钉钉配置诊断适配器 — 实现 DoctorAdapter Protocol

    诊断项：
    1. app_key / app_secret / robot_code 前后空格清理
    2. 未知配置键清理
    3. 缺 robot_code 警告（发送消息需要）
    """

    # Stream 模式合法配置键
    VALID_KEYS = {"app_key", "app_secret", "robot_code", "mode"}

    def repair_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """诊断并修复配置问题（去除凭证前后空格）"""
        patches = []
        changed = False
        creds = config.credentials

        for field in ("app_key", "app_secret", "robot_code"):
            val = creds.get(field, "")
            if isinstance(val, str) and val != val.strip():
                patches.append({
                    "path": f"credentials.{field}",
                    "old": "***" if field == "app_secret" else val,
                    "new": "*** (trimmed)" if field == "app_secret" else val.strip(),
                })
                changed = True

        return DoctorConfigMutation(changed=changed, patches=patches)

    def clean_stale_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """清理过期/无效配置项"""
        warnings = []
        stale_keys = [k for k in config.credentials if k not in self.VALID_KEYS]
        if stale_keys:
            warnings.append(f"发现未知配置项: {', '.join(stale_keys)}")
        return DoctorConfigMutation(changed=False, warnings=warnings)

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集配置警告"""
        warnings = []
        creds = config.credentials

        if not creds.get("robot_code"):
            warnings.append("未配置 Robot Code：主动发送消息（非会话内回复）时需要")

        app_key = creds.get("app_key", "")
        if app_key and len(app_key) < 8:
            warnings.append("App Key 长度异常，请确认是否完整复制")

        return warnings
