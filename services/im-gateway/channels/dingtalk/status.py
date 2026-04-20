"""
钉钉渠道 — 状态探测适配器（StatusAdapter 实现）

探测钉钉机器人在线状态，构建账户快照，收集状态问题。
钉钉 Stream 模式下，通过检查 SDK 连接状态来判断健康。
"""

import logging
from typing import Optional

from core.types import ChannelConfig, AccountSnapshot, StatusIssue

logger = logging.getLogger("gateway.dingtalk.status")


class DingTalkStatus:
    """
    钉钉状态探测适配器 — 实现 StatusAdapter Protocol

    钉钉 Stream 模式不提供公开的 ping/health API，
    因此通过以下方式判断状态：
    1. 检查 DingTalkGateway.is_connected 属性
    2. 检查配置完整性（AppKey/AppSecret/RobotCode）
    3. 验证 access_token 是否可正常获取
    """

    def __init__(self, gateway=None):
        """
        Args:
            gateway: DingTalkGateway 实例引用，用于检查连接状态
        """
        self._gateway = gateway

    async def probe_account(self, config: ChannelConfig, timeout_ms: int = 5000) -> dict:
        """
        主动探测钉钉账户连通性

        由于钉钉 Stream SDK 不暴露 ping 接口，
        通过尝试获取 access_token 来验证凭证有效性。
        """
        result = {
            "reachable": False,
            "token_valid": False,
            "stream_connected": False,
            "error": None,
        }

        # 检查 Stream 连接状态
        if self._gateway:
            result["stream_connected"] = self._gateway.is_connected

        # 尝试获取 access_token 验证凭证
        appkey = config.credentials.get("app_key", "")
        appsecret = config.credentials.get("app_secret", "")

        if not appkey or not appsecret:
            result["error"] = "缺少 AppKey 或 AppSecret"
            return result

        try:
            import httpx
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_ms / 1000)) as client:
                resp = await client.get(
                    "https://oapi.dingtalk.com/gettoken",
                    params={"appkey": appkey, "appsecret": appsecret},
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
            logger.warning("钉钉探测失败: %s", e)

        return result

    def build_account_snapshot(
        self,
        config: ChannelConfig,
        runtime: Optional[AccountSnapshot] = None,
        probe: Optional[dict] = None,
    ) -> AccountSnapshot:
        """构建钉钉账户快照"""
        snapshot = runtime or AccountSnapshot()

        if probe:
            snapshot.connected = probe.get("stream_connected", False)
            if probe.get("error"):
                snapshot.last_error = probe["error"]
                snapshot.status = "error"
            elif probe.get("stream_connected"):
                snapshot.status = "connected"
            elif probe.get("token_valid"):
                snapshot.status = "disconnected"  # token 有效但 stream 未连接
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

        return snapshot

    def collect_status_issues(self, snapshots: list[AccountSnapshot]) -> list[StatusIssue]:
        """收集钉钉账户的状态问题"""
        issues = []

        for snap in snapshots:
            if snap.last_error:
                issues.append(StatusIssue(
                    channel="dingtalk",
                    account_id="default",
                    kind="runtime",
                    message=f"钉钉连接异常: {snap.last_error}",
                    fix="检查网络连接和 AppKey/AppSecret 配置",
                ))

            if snap.status == "disconnected" and snap.extra.get("token_valid"):
                issues.append(StatusIssue(
                    channel="dingtalk",
                    account_id="default",
                    kind="runtime",
                    message="钉钉 Token 有效但 Stream 未连接",
                    fix="尝试重新启动钉钉连接",
                ))

            if not snap.extra.get("reachable", True):
                issues.append(StatusIssue(
                    channel="dingtalk",
                    account_id="default",
                    kind="config",
                    message="无法访问钉钉 API",
                    fix="检查网络连接和防火墙配置",
                ))

        return issues
