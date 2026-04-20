"""
企业微信渠道 — 配置 Schema + 能力声明

企微应用配置需要：
- corp_id：企业 ID
- app_secret：自建应用 Secret（用于获取 access_token）
- agent_id：自建应用 AgentId
- token：回调 Token（高级配置，WebSocket 模式可选）
- encoding_aes_key：回调 EncodingAESKey（高级配置）

参考 Hermes wecom.py 的配置项 + OpenClaw Schema 驱动模式。
"""

from core.config_schema import ChannelConfigSchema, FieldSchema, FieldType
from core.types import ChannelCapabilities, ChatType


# ── 静态能力声明 ──
WECOM_CAPABILITIES = ChannelCapabilities(
    chat_types=[ChatType.DIRECT, ChatType.GROUP],
    media=True,
    reactions=False,
    edit=False,
    unsend=False,
    reply=False,
    threads=False,
    block_streaming=False,
)

# ── 配置 Schema ──
WECOM_CONFIG_SCHEMA = ChannelConfigSchema(
    channel_id="wecom",
    channel_label="企业微信",
    docs_url="https://developer.work.weixin.qq.com/document/",
    setup_guide="""## 企业微信配置指引

1. 登录[企业微信管理后台](https://work.weixin.qq.com/wework_admin/)
2. 进入「我的企业」→ 复制 **企业 ID**
3. 进入「应用管理」→ 创建自建应用 → 获取 **AgentId** 和 **Secret**
4. （可选）若使用 WebSocket Bot 模式：
   - 在应用的「开发者接口」中获取 **Bot ID** 和 **Secret**
5. 将上述信息填入下方
""",
    fields=[
        FieldSchema(
            key="corp_id",
            label="企业 ID",
            field_type=FieldType.STRING,
            placeholder="ww1234567890abcdef",
            help_text="企业微信管理后台 → 我的企业 → 企业信息",
            order=1,
        ),
        FieldSchema(
            key="app_secret",
            label="应用 Secret",
            field_type=FieldType.SECRET,
            help_text="自建应用的 Secret",
            order=2,
        ),
        FieldSchema(
            key="agent_id",
            label="应用 AgentId",
            field_type=FieldType.STRING,
            help_text="自建应用的 AgentId",
            order=3,
        ),
        FieldSchema(
            key="bot_id",
            label="Bot ID",
            field_type=FieldType.STRING,
            required=False,
            help_text="WebSocket Bot 模式的 Bot ID（可选）",
            group="advanced",
            order=4,
        ),
        FieldSchema(
            key="bot_secret",
            label="Bot Secret",
            field_type=FieldType.SECRET,
            required=False,
            help_text="WebSocket Bot 模式的 Secret（可选）",
            group="advanced",
            order=5,
        ),
        FieldSchema(
            key="token",
            label="回调 Token",
            field_type=FieldType.SECRET,
            required=False,
            help_text="用于消息回调签名验证",
            group="advanced",
            order=6,
        ),
        FieldSchema(
            key="encoding_aes_key",
            label="回调 EncodingAESKey",
            field_type=FieldType.SECRET,
            required=False,
            help_text="用于消息加解密",
            group="advanced",
            order=7,
        ),
    ],
)
