"""
企业微信渠道 — 配置诊断修复适配器（DoctorAdapter 实现）

对齐飞书 FeishuDoctor 的三方法契约：
- repair_config：去除凭证前后空格
- clean_stale_config：清理未知配置键
- collect_warnings：收集配置警告

企微支持两种模式：
- WebSocket Bot 模式：bot_id / bot_secret
- HTTP 回调模式：token / encoding_aes_key（消息 AES 加密 + SHA1 签名）
"""

import logging

from core.types import ChannelConfig, DoctorConfigMutation

logger = logging.getLogger("gateway.wecom.doctor")


class WeComDoctor:
    """
    企微配置诊断适配器 — 实现 DoctorAdapter Protocol

    诊断项：
    1. corp_id / app_secret / agent_id 等前后空格清理
    2. 未知配置键清理
    3. 回调模式缺 encoding_aes_key / token 警告
    """

    VALID_KEYS = {
        "corp_id", "app_secret", "agent_id",
        "token", "encoding_aes_key",
        "bot_id", "bot_secret", "mode",
    }

    def repair_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """诊断并修复配置问题（去除凭证前后空格）"""
        patches = []
        changed = False
        creds = config.credentials

        for field in ("corp_id", "app_secret", "agent_id", "token", "encoding_aes_key"):
            val = creds.get(field, "")
            if isinstance(val, str) and val != val.strip():
                is_secret = field in ("app_secret", "encoding_aes_key")
                patches.append({
                    "path": f"credentials.{field}",
                    "old": "***" if is_secret else val,
                    "new": "*** (trimmed)" if is_secret else val.strip(),
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

        # 回调模式：有 token 但缺 encoding_aes_key
        if creds.get("token") and not creds.get("encoding_aes_key"):
            warnings.append("配置了回调 Token 但缺少 EncodingAESKey：回调消息将无法解密")
        # encoding_aes_key 官方为 43 位字符
        aes = creds.get("encoding_aes_key", "")
        if aes and len(aes) != 43:
            warnings.append(f"EncodingAESKey 长度异常（应为 43 位，实际 {len(aes)}）")

        return warnings
