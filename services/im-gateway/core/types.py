"""
统一类型定义 — 所有渠道插件使用的公共类型

参考 OpenClaw types.core.ts / types.adapters.ts 的类型分离思路，
为 Python 端定义统一消息类型、状态类型和能力声明。

层级：
  基础类型：MessageType / MessageSource / MessageEvent / SendResult / MediaPayload / QrLogin
  P0 生产级：AccountSnapshot / StatusIssue / DoctorConfigMutation
  P1 增强级：ChatType / ChannelCapabilities / StreamingConfig / SecurityWarning
  G4 集成层：SessionKeyStrategy
"""

import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional


# ══════════════════════════════════════════════════════════════
# 基础类型
# ══════════════════════════════════════════════════════════════


class MessageType(str, Enum):
    """消息类型"""
    TEXT = "text"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    FILE = "file"
    COMMAND = "command"
    REACTION = "reaction"
    CARD_ACTION = "card_action"


@dataclass
class MessageSource:
    """消息来源"""
    user_id: str
    chat_id: str
    thread_id: str = ""
    group_id: str = ""
    is_group: bool = False
    sender_name: str = ""


@dataclass
class MessageEvent:
    """入站消息事件 — 所有渠道统一格式"""
    text: str
    source: MessageSource
    msg_type: MessageType = MessageType.TEXT
    msg_id: str = ""
    timestamp: float = 0.0
    media_urls: list[str] = field(default_factory=list)
    media_types: list[str] = field(default_factory=list)
    media_data: list[bytes] = field(default_factory=list)  # D-1: 原始二进制数据（缓存场景）
    raw: Any = None  # 平台原始数据（调试用）


@dataclass
class SendResult:
    """出站发送结果"""
    success: bool
    message_id: str = ""
    error: str = ""


@dataclass
class MediaPayload:
    """媒体数据"""
    path: str
    kind: str       # image/video/audio/document/file
    mime_type: str
    filename: str
    caption: str = ""
    size: int = 0

    def __post_init__(self):
        if not self.size and os.path.isfile(self.path):
            self.size = os.path.getsize(self.path)


@dataclass
class QrLoginResult:
    """二维码登录结果"""
    qr_data_url: str = ""
    message: str = ""
    session_id: str = ""


class QrStatus(str, Enum):
    """二维码扫描状态"""
    WAITING = "waiting"
    SCANNED = "scanned"
    CONFIRMED = "confirmed"
    EXPIRED = "expired"
    ERROR = "error"


@dataclass
class QrStatusResult:
    """二维码状态查询结果"""
    status: QrStatus
    connected: bool = False
    error: str = ""


@dataclass
class ChannelConfig:
    """渠道运行时配置"""
    channel_id: str
    account_id: str = "default"               # 多账户支持
    credentials: dict[str, str] = field(default_factory=dict)
    settings: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True


# ══════════════════════════════════════════════════════════════
# P0 生产级类型（对标 OpenClaw types.core.ts / types.adapters.ts）
# ══════════════════════════════════════════════════════════════


@dataclass
class AccountSnapshot:
    """账户运行时快照（对标 OpenClaw ChannelAccountSnapshot）"""
    connected: bool = False
    status: str = "not_running"   # connected/disconnected/reconnecting/error/stopped
    connected_at: Optional[str] = None
    last_event_at: Optional[str] = None
    last_error: Optional[str] = None
    restart_attempts: int = 0
    extra: dict[str, Any] = field(default_factory=dict)  # 平台特有信息


@dataclass
class StatusIssue:
    """状态问题（对标 OpenClaw ChannelStatusIssue）"""
    channel: str
    account_id: str
    kind: str              # intent / permissions / config / auth / runtime
    message: str
    fix: str = ""          # 修复建议


@dataclass
class DoctorConfigMutation:
    """配置修复结果（对标 OpenClaw ChannelDoctorConfigMutation）"""
    changed: bool = False
    patches: list[dict[str, Any]] = field(default_factory=list)  # [{path, old, new}]
    warnings: list[str] = field(default_factory=list)


# ══════════════════════════════════════════════════════════════
# P1 增强级类型
# ══════════════════════════════════════════════════════════════


class ChatType(str, Enum):
    """聊天类型（对标 OpenClaw ChatType）"""
    DIRECT = "direct"
    GROUP = "group"
    CHANNEL = "channel"
    THREAD = "thread"


@dataclass
class ChannelCapabilities:
    """
    静态能力声明（对标 OpenClaw ChannelCapabilities）
    每个渠道声明自己支持的功能，运行时据此决策
    """
    chat_types: list[ChatType] = field(default_factory=lambda: [ChatType.DIRECT])
    media: bool = False           # 是否支持媒体附件
    reactions: bool = False       # 是否支持表情反应
    edit: bool = False            # 是否支持编辑消息
    unsend: bool = False          # 是否支持撤回
    reply: bool = False           # 是否支持引用回复
    threads: bool = False         # 是否支持线程
    block_streaming: bool = False # 是否支持块流式响应


@dataclass
class StreamingConfig:
    """流式响应合并配置（对标 OpenClaw ChannelStreamingAdapter）"""
    min_chars: int = 20           # 最小字符数才触发推送
    idle_ms: int = 500            # 空闲毫秒数后强制推送


@dataclass
class SecurityWarning:
    """安全审计发现（对标 OpenClaw collectAuditFindings）"""
    check_id: str
    severity: str                 # info / warn / critical
    title: str
    detail: str
    remediation: str = ""


# ══════════════════════════════════════════════════════════════
# G4 集成层类型：Session Key 策略
# ══════════════════════════════════════════════════════════════


class SessionKeyStrategy(str, Enum):
    """Session Key 生成策略（G4）"""
    PER_USER = "per_user"             # platform:user_id — 同一用户跨群聊共享上下文
    PER_CHAT = "per_chat"             # platform:chat_id — 同一群聊内共享
    PER_THREAD = "per_thread"         # platform:user_id:thread_id — 飞书线程隔离
    PER_USER_CHAT = "per_user_chat"   # platform:user_id:chat_id — 默认策略


@dataclass
class SessionResetPolicy:
    """Session 重置策略（G1）"""
    mode: str = "idle"              # idle / daily / both / none
    idle_timeout_s: int = 1800      # 30 分钟空闲重置


@dataclass
class GatewaySession:
    """网关会话（G1）"""
    session_key: str                # platform:user_id[:thread_id]
    agent_id: str
    platform: str
    user_id: str
    chat_id: str
    turn_count: int = 0
    last_activity: float = field(default_factory=time.time)

    def is_idle(self, timeout_s: int = 1800) -> bool:
        """检查 session 是否空闲超时"""
        return (time.time() - self.last_activity) > timeout_s

    def touch(self) -> None:
        """更新最后活动时间"""
        self.last_activity = time.time()
        self.turn_count += 1

    def to_dict(self) -> dict:
        """序列化为可持久化字典"""
        return {
            "session_key": self.session_key,
            "agent_id": self.agent_id,
            "platform": self.platform,
            "user_id": self.user_id,
            "chat_id": self.chat_id,
            "turn_count": self.turn_count,
            "last_activity": self.last_activity,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "GatewaySession":
        """从字典反序列化"""
        return cls(
            session_key=data["session_key"],
            agent_id=data["agent_id"],
            platform=data["platform"],
            user_id=data["user_id"],
            chat_id=data["chat_id"],
            turn_count=data.get("turn_count", 0),
            last_activity=data.get("last_activity", time.time()),
        )


# ══════════════════════════════════════════════════════════════
# 各平台文件大小限制（从 adapters/base.py 迁移，唯一权威来源）
# ══════════════════════════════════════════════════════════════

# 官方文档标准，按平台+媒体类型区分，bridge.py 中使用
PLATFORM_SIZE_LIMITS: Dict[str, Dict[str, int]] = {
    "wecom": {
        "image": 10 * 1024 * 1024,      # 10MB
        "audio": 2 * 1024 * 1024,       # 2MB
        "video": 10 * 1024 * 1024,      # 10MB
        "document": 20 * 1024 * 1024,   # 20MB
        "file": 20 * 1024 * 1024,       # 20MB
    },
    "feishu": {
        "image": 10 * 1024 * 1024,      # 10MB
        "audio": 30 * 1024 * 1024,      # 飞书文件统一 30MB
        "video": 30 * 1024 * 1024,      # 30MB
        "document": 30 * 1024 * 1024,   # 30MB
        "file": 30 * 1024 * 1024,       # 30MB
    },
    "dingtalk": {
        "image": 20 * 1024 * 1024,      # 20MB (官方实际支持)
        "audio": 2 * 1024 * 1024,       # 2MB
        "video": 20 * 1024 * 1024,      # 20MB
        "document": 20 * 1024 * 1024,   # 20MB
        "file": 20 * 1024 * 1024,       # 20MB
    },
}

# 各平台未配置时的全局回退限制
DEFAULT_SIZE_LIMIT = 5 * 1024 * 1024  # 5MB


def get_size_limit(platform: str, kind: str) -> int:
    """获取指定平台+类型的文件大小限制（字节）"""
    limits = PLATFORM_SIZE_LIMITS.get(platform, {})
    return limits.get(kind, DEFAULT_SIZE_LIMIT)
