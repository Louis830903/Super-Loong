"""
飞书渠道 — 流式响应适配器（StreamingAdapter 实现）

飞书支持消息卡片的流式更新，通过 PATCH 接口追加内容。
"""

from typing import Optional

from core.types import StreamingConfig


class FeishuStreaming:
    """
    飞书流式响应适配器 — 实现 StreamingAdapter Protocol

    飞书通过消息卡片的 PATCH 更新实现「打字机效果」：
    1. 先发送一个空的消息卡片
    2. 通过 PATCH /open-apis/im/v1/messages/{message_id} 追加内容
    3. 合并策略：最少 20 字符 + 500ms 空闲后推送
    """

    @property
    def block_streaming_coalesce_defaults(self) -> Optional[StreamingConfig]:
        """飞书流式响应合并默认参数"""
        return StreamingConfig(
            min_chars=20,     # 最少 20 字符才触发推送
            idle_ms=500,      # 空闲 500ms 后强制推送
        )
