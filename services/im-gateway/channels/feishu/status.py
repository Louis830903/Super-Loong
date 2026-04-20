"""
飞书渠道 — 状态探测适配器（StatusAdapter 实现）

通过飞书 Open API 验证凭证和应用状态。
"""

import logging
from typing import Optional

from core.types import ChannelConfig, AccountSnapshot, StatusIssue

logger = logging.getLogger("gateway.feishu.status")


class FeishuStatus:
    """
    飞书状态探测适配器 — 实现 StatusAdapter Protocol

    探测方式：
    1. 尝试获取 tenant_access_token 验证 app_id + app_secret
    2. 检查 WebSocket / Webhook 连接状态
    """

    def __init__(self, gateway=None):
        self._gateway = gateway

    async def probe_account(self, config: ChannelConfig, timeout_ms: int = 5000) -> dict:
        """主动探测飞书账户连通性"""
        result = {
            "reachable": False,
            "token_valid": False,
            "gateway_connected": False,
            "error": None,
        }

        if self._gateway:
            result["gateway_connected"] = self._gateway.is_connected

        app_id = config.credentials.get("app_id", "")
        app_secret = config.credentials.get("app_secret", "")

        if not app_id or not app_secret:
            result["error"] = "缺少 App ID 或 App Secret"
            return result

        try:
            import httpx
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_ms / 1000)) as client:
                resp = await client.post(
                    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                    json={"app_id": app_id, "app_secret": app_secret},
                )
                resp.raise_for_status()
                data = resp.json()

            if data.get("code", -1) == 0:
                result["reachable"] = True
                result["token_valid"] = True
            else:
                result["error"] = data.get("msg", "unknown error")

        except Exception as e:
            result["error"] = str(e)
            logger.warning("飞书探测失败: %s", e)

        return result

    def build_account_snapshot(
        self,
        config: ChannelConfig,
        runtime: Optional[AccountSnapshot] = None,
        probe: Optional[dict] = None,
    ) -> AccountSnapshot:
        """构建飞书账户快照"""
        snapshot = runtime or AccountSnapshot()

        if probe:
            snapshot.connected = probe.get("gateway_connected", False)
            if probe.get("error"):
                snapshot.last_error = probe["error"]
                snapshot.status = "error"
            elif probe.get("gateway_connected"):
                snapshot.status = "connected"
            elif probe.get("token_valid"):
                snapshot.status = "disconnected"
            else:
                snapshot.status = "error"
            snapshot.extra = {
                "token_valid": probe.get("token_valid", False),
                "reachable": probe.get("reachable", False),
                "mode": config.credentials.get("mode", "websocket"),
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
        """收集飞书账户的状态问题"""
        issues = []
        for snap in snapshots:
            if snap.last_error:
                issues.append(StatusIssue(
                    channel="feishu",
                    account_id="default",
                    kind="runtime",
                    message=f"飞书连接异常: {snap.last_error}",
                    fix="检查 App ID / App Secret 配置和网络连接",
                ))
            if snap.status == "disconnected" and snap.extra.get("token_valid"):
                mode = snap.extra.get("mode", "websocket")
                issues.append(StatusIssue(
                    channel="feishu",
                    account_id="default",
                    kind="runtime",
                    message=f"飞书 Token 有效但 {mode} 未连接",
                    fix=f"检查 {mode} 配置或尝试重新连接",
                ))
        return issues
