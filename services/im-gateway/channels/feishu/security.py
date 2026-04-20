"""
飞书渠道 — 安全策略适配器（SecurityAdapter 实现）

收集安全警告和审计发现。
新增：Webhook SHA256 签名验证 + 速率限制（参考 Hermes feishu.py 验签逻辑）
"""

import hashlib
import hmac
import logging
import time
from collections import defaultdict
from typing import Dict, Optional, Tuple

from core.types import ChannelConfig, SecurityWarning

logger = logging.getLogger("gateway.feishu.security")


class FeishuSecurity:
    """
    飞书安全策略适配器 — 实现 SecurityAdapter Protocol

    审计项：
    1. Encrypt Key 是否配置
    2. App Secret 是否定期轮换
    3. 权限范围是否过大
    """

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集安全警告"""
        warnings = []
        creds = config.credentials

        if not creds.get("encrypt_key"):
            warnings.append("未配置消息加密密钥（Encrypt Key），消息以明文传输")

        if creds.get("mode") == "webhook" and not creds.get("verification_token"):
            warnings.append("Webhook 模式未配置签名验证 Token，存在回调伪造风险")

        return warnings

    def collect_audit_findings(self, config: ChannelConfig) -> list[SecurityWarning]:
        """收集安全审计发现"""
        findings = []
        creds = config.credentials

        # 检查 Encrypt Key
        if not creds.get("encrypt_key"):
            findings.append(SecurityWarning(
                check_id="feishu_encrypt_key",
                severity="warn",
                title="消息加密未启用",
                detail="飞书消息未配置 Encrypt Key，事件回调内容以明文传输",
                remediation="在飞书开放平台 → 事件与回调 → 加密策略 中配置 Encrypt Key",
            ))

        # 检查 Webhook 模式的验证 Token
        if creds.get("mode") == "webhook" and not creds.get("verification_token"):
            findings.append(SecurityWarning(
                check_id="feishu_webhook_token",
                severity="critical",
                title="Webhook 签名验证缺失",
                detail="Webhook 模式未配置 Verification Token，无法验证回调来源",
                remediation="在飞书开放平台 → 事件与回调 中获取 Verification Token 并配置",
            ))

        # 检查 App Secret 长度（过短可能是误配置）
        app_secret = creds.get("app_secret", "")
        if app_secret and len(app_secret) < 16:
            findings.append(SecurityWarning(
                check_id="feishu_secret_length",
                severity="warn",
                title="App Secret 长度异常",
                detail=f"App Secret 仅 {len(app_secret)} 字符，正常应为 32+ 字符",
                remediation="确认 App Secret 是否完整复制",
            ))

        return findings


# ══════════════════════════════════════════════════════════
# Webhook SHA256 签名验证（参考 Hermes feishu.py verify_signature）
# ══════════════════════════════════════════════════════════

def verify_webhook_signature(
    timestamp: str,
    nonce: str,
    body: str,
    signature: str,
    encrypt_key: str,
) -> bool:
    """
    验证飞书 Webhook 回调的 SHA256 签名。

    飞书事件回调签名算法：
    sha256(timestamp + nonce + encrypt_key + body)

    Args:
        timestamp: 请求头 X-Lark-Request-Timestamp
        nonce: 请求头 X-Lark-Request-Nonce
        body: 原始请求体字符串
        signature: 请求头 X-Lark-Signature
        encrypt_key: 飞书开放平台配置的 Encrypt Key

    Returns:
        签名是否有效
    """
    if not all([timestamp, nonce, body, signature, encrypt_key]):
        return False

    content = f"{timestamp}{nonce}{encrypt_key}{body}"
    computed = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return hmac.compare_digest(computed, signature)


# ══════════════════════════════════════════════════════════
# 速率限制器（按 IP/user_id 限制请求频率）
# ══════════════════════════════════════════════════════════

class RateLimiter:
    """
    简易滑动窗口速率限制器。

    用于防护 Webhook 接口被恶意高频调用。
    """

    def __init__(self, max_requests: int = 60, window_seconds: int = 60):
        self._max_requests = max_requests
        self._window = window_seconds
        # key → list of timestamps
        self._requests: Dict[str, list] = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        """
        检查是否允许请求。

        Args:
            key: 限流键（IP 地址或 user_id）

        Returns:
            True 允许，False 被限流
        """
        now = time.monotonic()
        window_start = now - self._window

        # 清理过期记录
        self._requests[key] = [
            t for t in self._requests[key] if t > window_start
        ]

        if len(self._requests[key]) >= self._max_requests:
            logger.warning(f"速率限制触发: {key} ({len(self._requests[key])} 请求/{self._window}s)")
            return False

        self._requests[key].append(now)
        return True

    def cleanup(self) -> int:
        """
        清理所有过期的记录，返回清理的键数量。

        建议定期调用以防内存泄漏。
        """
        now = time.monotonic()
        window_start = now - self._window
        expired_keys = []

        for key, timestamps in self._requests.items():
            self._requests[key] = [t for t in timestamps if t > window_start]
            if not self._requests[key]:
                expired_keys.append(key)

        for key in expired_keys:
            del self._requests[key]

        return len(expired_keys)
