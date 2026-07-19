"""
企业微信渠道 — 安全策略适配器（SecurityAdapter 实现）

对齐飞书 FeishuSecurity 的两方法契约：
- collect_warnings：安全警告
- collect_audit_findings：结构化审计发现

签名校验：HTTP 回调模式下，企微用 SHA1(sorted[token, timestamp, nonce, encrypt])
校验回调来源，消息体 AES-256-CBC 加密。本模块复用 WeComCrypto.verify_signature
（channels/wecom/crypto.py 已实现官方算法），对外暴露 verify_callback_signature 供
网关回调入口调用。
"""

import logging
from typing import Optional

from core.types import ChannelConfig, SecurityWarning
from .crypto import WeComCrypto

logger = logging.getLogger("gateway.wecom.security")


class WeComSecurity:
    """
    企微安全策略适配器 — 实现 SecurityAdapter Protocol

    审计项：
    1. 回调模式是否配置 EncodingAESKey / Token（签名 + 加密）
    2. App Secret 长度是否异常
    """

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集安全警告"""
        warnings = []
        creds = config.credentials

        if creds.get("token") and not creds.get("encoding_aes_key"):
            warnings.append("回调模式配置了 Token 但缺少 EncodingAESKey，消息无法解密")
        if not creds.get("token") and not creds.get("bot_id"):
            warnings.append("既未配置回调 Token 也未配置 Bot 模式，请确认接入方式")

        return warnings

    def collect_audit_findings(self, config: ChannelConfig) -> list[SecurityWarning]:
        """收集安全审计发现"""
        findings = []
        creds = config.credentials

        # 回调模式签名/加密门控
        if creds.get("token"):
            if not creds.get("encoding_aes_key"):
                findings.append(SecurityWarning(
                    check_id="wecom_callback_aeskey",
                    severity="critical",
                    title="回调加密密钥缺失",
                    detail="配置了回调 Token 但缺少 EncodingAESKey，无法验签/解密回调，存在伪造与泄露风险",
                    remediation="在企业微信管理后台 → 接收消息 中配置 EncodingAESKey（43 位）",
                ))

        # App Secret 长度
        app_secret = creds.get("app_secret", "")
        if app_secret and len(app_secret) < 16:
            findings.append(SecurityWarning(
                check_id="wecom_secret_length",
                severity="warn",
                title="App Secret 长度异常",
                detail=f"App Secret 仅 {len(app_secret)} 字符，正常应为 32+ 字符",
                remediation="确认 App Secret 是否完整复制",
            ))

        return findings


def verify_callback_signature(
    config: ChannelConfig,
    signature: str,
    timestamp: str,
    nonce: str,
    encrypted: str,
) -> bool:
    """
    验证企微 HTTP 回调签名（复用 WeComCrypto，官方 SHA1 排序算法）。

    Args:
        config: 渠道配置（读取 token / encoding_aes_key / corp_id）
        signature: 回调 URL 上的 msg_signature
        timestamp / nonce / encrypted: 回调参数

    Returns:
        签名是否有效；缺少必要凭证时返回 False（拒绝）。
    """
    creds = config.credentials
    token = creds.get("token")
    aes_key = creds.get("encoding_aes_key")
    corp_id = creds.get("corp_id")
    if not token or not aes_key or not corp_id:
        logger.warning("企微回调验签缺少必要凭证（token/encoding_aes_key/corp_id）")
        return False
    try:
        crypto = WeComCrypto(token=token, encoding_aes_key=aes_key, corp_id=corp_id)
        return crypto.verify_signature(signature, timestamp, nonce, encrypted)
    except Exception as e:
        logger.error("企微回调验签失败: %s", e)
        return False
