"""
企业微信渠道 — 状态探测适配器（StatusAdapter 实现）

通过获取 access_token 验证凭证有效性，
结合 gateway 连接状态构建账户快照。
"""

import logging
from typing import Optional

from core.types import ChannelConfig, AccountSnapshot, StatusIssue

logger = logging.getLogger("gateway.wecom.status")


class WeComStatus:
    """
    企微状态探测适配器 — 实现 StatusAdapter Protocol

    探测方式：
    1. 尝试获取 access_token 验证 corp_id + secret
    2. 检查 WebSocket 连接状态
    """

    def __init__(self, gateway=None):
        self._gateway = gateway

    async def probe_account(self, config: ChannelConfig, timeout_ms: int = 5000) -> dict:
        """主动探测企微账户连通性"""
        result = {
            "reachable": False,
            "token_valid": False,
            "ws_connected": False,
            "error": None,
        }

        if self._gateway:
            result["ws_connected"] = self._gateway.is_connected

        corpid = config.credentials.get("corp_id", "")
        corpsecret = config.credentials.get("app_secret", "")

        if not corpid or not corpsecret:
            result["error"] = "缺少 corp_id 或 app_secret"
            return result

        try:
            import httpx
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_ms / 1000)) as client:
                resp = await client.get(
                    "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
                    params={"corpid": corpid, "corpsecret": corpsecret},
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("errcode", 0) == 0:
                result["reachable"] = True
                result["token_valid"] = True
            else:
                result["error"] = data.get("errmsg", "unknown error")

        except Exception as e:
            result["error"] = str(e)
            logger.warning("企微探测失败: %s", e)

        return result

    def build_account_snapshot(
        self,
        config: ChannelConfig,
        runtime: Optional[AccountSnapshot] = None,
        probe: Optional[dict] = None,
    ) -> AccountSnapshot:
        """构建企微账户快照"""
        snapshot = runtime or AccountSnapshot()

        if probe:
            snapshot.connected = probe.get("ws_connected", False)
            if probe.get("error"):
                snapshot.last_error = probe["error"]
                snapshot.status = "error"
            elif probe.get("ws_connected"):
                snapshot.status = "connected"
            elif probe.get("token_valid"):
                snapshot.status = "disconnected"
            else:
                snapshot.status = "error"
            snapshot.extra = {
                "token_valid": probe.get("token_valid", False),
                "reachable": probe.get("reachable", False),
            }
        elif self._gateway:
            snapshot.connected = self._gateway.is_connected
            snapshot.status = "connected" if self._gateway.is_connected else "disconnected"
            if self._gateway.last_error:
                snapshot.last_error = self._gateway.last_error
            if hasattr(self._gateway, "connected_at"):
                snapshot.connected_at = self._gateway.connected_at
            if hasattr(self._gateway, "last_event_at"):
                snapshot.last_event_at = self._gateway.last_event_at

        return snapshot

    def collect_status_issues(self, snapshots: list[AccountSnapshot]) -> list[StatusIssue]:
        """收集企微账户的状态问题"""
        issues = []
        for snap in snapshots:
            if snap.last_error:
                issues.append(StatusIssue(
                    channel="wecom",
                    account_id="default",
                    kind="runtime",
                    message=f"企微连接异常: {snap.last_error}",
                    fix="检查网络连接和 corp_id/secret 配置",
                ))
            if snap.status == "disconnected" and snap.extra.get("token_valid"):
                issues.append(StatusIssue(
                    channel="wecom",
                    account_id="default",
                    kind="runtime",
                    message="企微 Token 有效但 WebSocket 未连接",
                    fix="检查 Bot ID / Bot Secret 配置，或尝试重新连接",
                ))
        return issues
