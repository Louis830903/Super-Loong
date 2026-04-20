"""
渠道插件协议 — 每个渠道需实现的接口契约

借鉴 OpenClaw types.plugin.ts 的组合式适配器，定义 12 个 Protocol：
  基础层（6）：ConfigAdapter / GatewayAdapter / QrLoginAdapter / OutboundAdapter / InboundAdapter / HealthAdapter
  P0 生产级（3）：StatusAdapter / LifecycleAdapter / DoctorAdapter
  P1 增强级（3）：SetupAdapter / SecurityAdapter / StreamingAdapter
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Optional, runtime_checkable, TYPE_CHECKING

if TYPE_CHECKING:
    from core.config_schema import ChannelConfigSchema

from core.types import (
    ChannelConfig,
    ChannelCapabilities,
    MessageEvent,
    SendResult,
    MediaPayload,
    QrLoginResult,
    QrStatusResult,
    AccountSnapshot,
    StatusIssue,
    DoctorConfigMutation,
    SecurityWarning,
    StreamingConfig,
)


# ══════════════════════════════════════════════════════════════
# 基础层 Protocol（6 个）
# ══════════════════════════════════════════════════════════════


@runtime_checkable
class ConfigAdapter(Protocol):
    """配置适配器 — 凭证验证+账户解析"""

    def validate(self, credentials: dict) -> Optional[str]:
        """验证凭证完整性，返回 None 表示通过，否则返回错误信息"""
        ...

    def is_configured(self, credentials: dict) -> bool:
        """判断是否已配置必需凭证"""
        ...


@runtime_checkable
class GatewayAdapter(Protocol):
    """网关适配器 — 连接生命周期管理"""

    async def start(self, config: ChannelConfig) -> bool:
        """启动连接（WebSocket/Long-poll/Stream）"""
        ...

    async def stop(self) -> None:
        """停止连接"""
        ...

    @property
    def is_connected(self) -> bool:
        """当前是否已连接"""
        ...

    @property
    def last_error(self) -> Optional[str]:
        """最近一次错误信息"""
        ...


@runtime_checkable
class QrLoginAdapter(Protocol):
    """二维码登录适配器 — 微信等需要扫码的平台"""

    async def start_qr_login(self) -> QrLoginResult:
        """发起二维码登录"""
        ...

    async def check_qr_status(self) -> QrStatusResult:
        """轮询二维码状态"""
        ...


@runtime_checkable
class OutboundAdapter(Protocol):
    """出站消息适配器 — 发送文本+媒体"""

    async def send_text(self, chat_id: str, text: str, **kwargs) -> SendResult:
        """发送文本消息"""
        ...

    async def send_media(self, chat_id: str, payload: MediaPayload) -> SendResult:
        """发送媒体消息"""
        ...

    def max_text_length(self) -> int:
        """平台最大文本长度"""
        ...


@runtime_checkable
class InboundAdapter(Protocol):
    """入站消息适配器 — 设置消息回调"""

    def set_message_handler(self, handler) -> None:
        """设置消息处理回调"""
        ...


@runtime_checkable
class HealthAdapter(Protocol):
    """健康检查适配器"""

    @property
    def is_connected(self) -> bool: ...

    @property
    def has_fatal_error(self) -> bool: ...

    @property
    def connected_at(self) -> Optional[str]: ...

    @property
    def last_event_at(self) -> Optional[str]: ...


# ══════════════════════════════════════════════════════════════
# P0 生产级 Protocol（对标 OpenClaw types.adapters.ts）
# ══════════════════════════════════════════════════════════════


@runtime_checkable
class StatusAdapter(Protocol):
    """
    状态探测适配器（对标 OpenClaw ChannelStatusAdapter）
    主动探测账户健康、构建快照、收集问题
    飞书参考：调用 /open-apis/bot/v1/openclaw_bot/ping 探测连通性
    """

    async def probe_account(self, config: ChannelConfig, timeout_ms: int = 5000) -> dict:
        """主动探测账户连通性，返回平台特定探测结果"""
        ...

    def build_account_snapshot(
        self,
        config: ChannelConfig,
        runtime: Optional[AccountSnapshot] = None,
        probe: Optional[dict] = None,
    ) -> AccountSnapshot:
        """构建账户运行时快照"""
        ...

    def collect_status_issues(self, snapshots: list[AccountSnapshot]) -> list[StatusIssue]:
        """收集所有账户的状态问题"""
        ...


@runtime_checkable
class LifecycleAdapter(Protocol):
    """
    生命周期钩子适配器（对标 OpenClaw ChannelLifecycleAdapter）
    配置变更通知、账户清理、启动维护
    """

    async def on_config_changed(
        self, prev_config: ChannelConfig, next_config: ChannelConfig
    ) -> None:
        """配置变更钩子 — 渠道可在此做 token 刷新、连接重建等"""
        ...

    async def on_account_removed(self, config: ChannelConfig) -> None:
        """账户移除钩子 — 清理残留资源（WebSocket、定时器等）"""
        ...

    async def run_startup_maintenance(self, config: ChannelConfig) -> None:
        """启动维护 — 系统启动时执行的清理/迁移逻辑"""
        ...


@runtime_checkable
class DoctorAdapter(Protocol):
    """
    配置诊断修复适配器（对标 OpenClaw ChannelDoctorAdapter）
    自动诊断配置问题、提供修复建议、执行自动修复
    """

    def repair_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """诊断并修复配置问题，返回修复结果"""
        ...

    def clean_stale_config(self, config: ChannelConfig) -> DoctorConfigMutation:
        """清理过期/无效配置项"""
        ...

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集配置警告信息（不修复，只报告）"""
        ...


# ══════════════════════════════════════════════════════════════
# P1 增强级 Protocol
# ══════════════════════════════════════════════════════════════


@runtime_checkable
class SetupAdapter(Protocol):
    """
    安装配置适配器（对标 OpenClaw ChannelSetupAdapter）
    处理首次配置向导、账户名称应用、配置校验
    """

    def apply_account_config(self, config: ChannelConfig, input_data: dict) -> ChannelConfig:
        """应用用户输入的配置（首次配置/修改配置）"""
        ...

    def validate_input(self, input_data: dict) -> Optional[str]:
        """校验用户输入，返回 None 表示通过"""
        ...


@runtime_checkable
class SecurityAdapter(Protocol):
    """
    安全策略适配器（对标 OpenClaw ChannelSecurityAdapter）
    DM 策略、安全警告、审计发现
    """

    def collect_warnings(self, config: ChannelConfig) -> list[str]:
        """收集安全警告（如未配置白名单、密钥即将过期）"""
        ...

    def collect_audit_findings(self, config: ChannelConfig) -> list[SecurityWarning]:
        """收集安全审计发现"""
        ...


@runtime_checkable
class StreamingAdapter(Protocol):
    """
    流式响应适配器（对标 OpenClaw ChannelStreamingAdapter）
    块流式响应合并策略
    """

    @property
    def block_streaming_coalesce_defaults(self) -> Optional[StreamingConfig]:
        """块流式响应合并默认参数"""
        ...


# ══════════════════════════════════════════════════════════════
# 渠道插件聚合类型
# ══════════════════════════════════════════════════════════════


@dataclass
class ChannelPlugin:
    """
    渠道插件 — 对标 OpenClaw ChannelPlugin
    组合多个可选适配器，每个渠道只需实现需要的部分

    必须字段：id / label / capabilities / config_schema / config_adapter / gateway_adapter / outbound_adapter / inbound_adapter
    可选字段：其余 adapter 按需实现
    """
    # ── 身份与元数据 ──
    id: str                                      # 唯一标识：weixin/wecom/dingtalk/feishu
    label: str                                   # 显示名称
    capabilities: ChannelCapabilities             # 静态能力声明
    config_schema: "ChannelConfigSchema"          # 配置 Schema

    # ── 基础适配器（必须）──
    config_adapter: ConfigAdapter                 # 配置验证
    gateway_adapter: GatewayAdapter               # 连接管理
    outbound_adapter: OutboundAdapter             # 消息发送
    inbound_adapter: InboundAdapter               # 消息接收

    # ── 基础可选 ──
    qr_login_adapter: Optional[QrLoginAdapter] = None     # 微信扫码
    health_adapter: Optional[HealthAdapter] = None         # 基础健康

    # ── P0 生产级可选 ──
    status_adapter: Optional[StatusAdapter] = None         # 主动探测+快照
    lifecycle_adapter: Optional[LifecycleAdapter] = None   # 生命周期钩子
    doctor_adapter: Optional[DoctorAdapter] = None         # 配置诊断修复

    # ── P1 增强级可选 ──
    setup_adapter: Optional[SetupAdapter] = None           # 安装向导
    security_adapter: Optional[SecurityAdapter] = None     # 安全策略
    streaming_adapter: Optional[StreamingAdapter] = None   # 流式响应
