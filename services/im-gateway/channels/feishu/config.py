"""
飞书渠道 — 配置 Schema + 能力声明

飞书是最复杂的渠道，支持 WebSocket / Webhook 双模式、
消息卡片、流式回复、线程等高级功能。

参考 OpenClaw feishu 扩展 (1219行) + Hermes feishu.py (3965行)。
"""

from core.config_schema import ChannelConfigSchema, FieldSchema, FieldType
from core.types import ChannelCapabilities, ChatType


# ── 静态能力声明 ──
FEISHU_CAPABILITIES = ChannelCapabilities(
    chat_types=[ChatType.DIRECT, ChatType.GROUP, ChatType.THREAD],
    media=True,
    reactions=True,
    edit=True,
    unsend=True,
    reply=True,
    threads=True,
    block_streaming=True,  # 飞书支持消息卡片流式输出
)

# ── 配置 Schema ──
FEISHU_CONFIG_SCHEMA = ChannelConfigSchema(
    channel_id="feishu",
    channel_label="飞书",
    docs_url="https://open.feishu.cn/document/",
    setup_guide="""## 飞书配置指引

1. 登录[飞书开放平台](https://open.feishu.cn/app)
2. 创建企业自建应用 → 获取 **App ID** 和 **App Secret**
3. 在「事件与回调」中配置：
   - WebSocket 模式（推荐）：启用 **长连接** 模式
   - Webhook 模式：配置 **请求地址** 和 **验证 Token**
4. 在「权限管理」中开通所需权限（至少 im:message:receive_v1）
5. 发布应用并审核通过
""",
    fields=[
        FieldSchema(
            key="app_id",
            label="App ID",
            field_type=FieldType.STRING,
            placeholder="cli_xxxxxxxx",
            help_text="飞书开放平台 → 凭证与基础信息",
            order=1,
        ),
        FieldSchema(
            key="app_secret",
            label="App Secret",
            field_type=FieldType.SECRET,
            help_text="飞书开放平台 → 凭证与基础信息",
            order=2,
        ),
        FieldSchema(
            key="mode",
            label="接入模式",
            field_type=FieldType.SELECT,
            options=[
                {"value": "websocket", "label": "WebSocket 长连接（推荐）"},
                {"value": "webhook", "label": "Webhook 回调"},
            ],
            default="websocket",
            help_text="WebSocket 无需公网 IP，推荐使用",
            order=3,
        ),
        FieldSchema(
            key="verification_token",
            label="Verification Token",
            field_type=FieldType.SECRET,
            required=False,
            help_text="Webhook 模式必需，WebSocket 模式可选",
            group="advanced",
            order=4,
        ),
        FieldSchema(
            key="encrypt_key",
            label="Encrypt Key",
            field_type=FieldType.SECRET,
            required=False,
            help_text="消息加密密钥（可选，提高安全性）",
            group="advanced",
            order=5,
        ),
    ],
)
