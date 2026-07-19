"""
钉钉渠道 — 安全策略适配器（SecurityAdapter 实现）

对齐飞书 FeishuSecurity 的两方法契约：
- collect_warnings：安全警告
- collect_audit_findings：结构化审计发现

签名说明：钉钉采用 Stream 长连接模式（dingtalk-stream SDK），入站消息经由
持久连接传输，连接本身由 app_key/app_secret 凭证认证（SDK 内部完成握手鉴权），
不存在 HTTP 回调，故无 webhook 伪造面，也无需单独的回调签名校验。
本适配器聚焦凭证卫生与配置审计。
"""

import logging

from core.types import ChannelConfig, SecurityWarning

logger = logging.getLogger("gateway.dingtalk.security")


class DingTalkSecurity:
    """
    钉钉安全策略适配器 — 实现 SecurityAdapter Protocol

    审计项：
    1. App Secret 是否疑似缺失/过短
    2. Stream 连接鉴权说明（信息项）
    """

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集安全警告"""
        warnings = []
        creds = config.credentials

        app_secret = creds.get("app_secret", "")
        if app_secret and len(app_secret) < 16:
            warnings.append("App Secret 长度异常（正常应为 32+ 字符），请确认是否完整复制")

        return warnings

    def collect_audit_findings(self, config: ChannelConfig) -> list[SecurityWarning]:
        """收集安全审计发现"""
        findings = []
        creds = config.credentials

        app_secret = creds.get("app_secret", "")
        if app_secret and len(app_secret) < 16:
            findings.append(SecurityWarning(
                check_id="dingtalk_secret_length",
                severity="warn",
                title="App Secret 长度异常",
                detail=f"App Secret 仅 {len(app_secret)} 字符，正常应为 32+ 字符",
                remediation="在钉钉开放平台确认 App Secret 是否完整复制",
            ))

        # 信息项：说明 Stream 模式的鉴权方式（无回调签名面）
        findings.append(SecurityWarning(
            check_id="dingtalk_stream_auth",
            severity="info",
            title="Stream 连接鉴权",
            detail="钉钉使用 Stream 长连接，由 app_key/app_secret 完成连接鉴权，无 HTTP 回调伪造面",
            remediation="无需额外操作；请妥善保管 app_secret",
        ))

        return findings
