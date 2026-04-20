"""
微信渠道 — 配置 Schema + 能力声明

使用 iLink Bot API 作为微信消息桥接：
- 通过 QR 扫码登录微信
- Long-poll 模式接收消息
- AES 加密媒体传输

参考 Hermes weixin.py (1830行) 的 iLink Bot 集成。
"""

from core.config_schema import ChannelConfigSchema, FieldSchema, FieldType
from core.types import ChannelCapabilities, ChatType


# ── 静态能力声明 ──
WEIXIN_CAPABILITIES = ChannelCapabilities(
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
WEIXIN_CONFIG_SCHEMA = ChannelConfigSchema(
    channel_id="weixin",
    channel_label="微信",
    docs_url="https://ilink.wiki/docs/",
    setup_guide="""## 微信配置指引

1. 获取 [iLink Bot](https://ilink.wiki/) 服务
2. 启动 iLink Bot 服务，获取 **API 地址** 和 **API Token**
3. 将信息填入下方，点击「连接」后扫描二维码登录微信
4. 扫码成功后即可收发消息

> 注意：微信渠道通过 iLink Bot API 桥接，需要保持 iLink Bot 服务运行。
""",
    fields=[
        FieldSchema(
            key="api_url",
            label="API 地址",
            field_type=FieldType.URL,
            placeholder="http://localhost:9011",
            help_text="iLink Bot 服务地址",
            order=1,
        ),
        FieldSchema(
            key="api_token",
            label="API Token",
            field_type=FieldType.SECRET,
            help_text="iLink Bot 认证 Token",
            order=2,
        ),
    ],
)
