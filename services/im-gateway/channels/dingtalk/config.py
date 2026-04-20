"""
钉钉渠道 — 配置 Schema + 能力声明

参考 Hermes dingtalk.py（335行）的 API 调用逻辑，
结合 OpenClaw 声明式 Schema 模式定义配置。
"""

from core.config_schema import ChannelConfigSchema, FieldSchema, FieldType
from core.types import ChannelCapabilities, ChatType


# ── 静态能力声明 ──
DINGTALK_CAPABILITIES = ChannelCapabilities(
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
DINGTALK_CONFIG_SCHEMA = ChannelConfigSchema(
    channel_id="dingtalk",
    channel_label="钉钉",
    docs_url="https://open.dingtalk.com/document/",
    setup_guide="""## 钉钉配置指引

1. 登录[钉钉开放平台](https://open-dev.dingtalk.com/)
2. 创建企业内部应用 → 获取 AppKey 和 AppSecret
3. 在「机器人」页面启用机器人，获取机器人编码
4. 配置消息接收地址（Stream 模式无需配置）
5. 将 AppKey、AppSecret 和机器人编码填入下方
""",
    fields=[
        FieldSchema(
            key="app_key",
            label="AppKey",
            field_type=FieldType.STRING,
            placeholder="dingxxxxxxxx",
            help_text="企业内部应用的 AppKey",
            order=1,
        ),
        FieldSchema(
            key="app_secret",
            label="AppSecret",
            field_type=FieldType.SECRET,
            help_text="企业内部应用的 AppSecret",
            order=2,
        ),
        FieldSchema(
            key="robot_code",
            label="机器人编码",
            field_type=FieldType.STRING,
            help_text="机器人的 robotCode，在机器人管理页面获取",
            order=3,
        ),
    ],
)
