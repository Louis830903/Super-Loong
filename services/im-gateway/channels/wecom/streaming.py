"""
企微流式回复 — aibot_respond_msg 实时推送

参考 Hermes wecom.py 的流式回复逻辑：
- 通过 WebSocket 发送 aibot_respond_msg 命令
- 支持增量推送（type=stream_start/stream_append/stream_end）
- 长回复自动分片
"""

import asyncio
import json
import logging
from typing import Any, Callable, Coroutine, Dict, Optional

logger = logging.getLogger("wecom.streaming")

# 企微流式消息类型
STREAM_START = "stream_start"
STREAM_APPEND = "stream_append"
STREAM_END = "stream_end"

# 每次推送最大字符数（企微限制）
MAX_STREAM_CHUNK = 2000
# 推送间隔（秒），避免过快推送被限流
STREAM_INTERVAL = 0.3


class WeComStreamSender:
    """
    企微流式消息发送器。

    将长文本拆分为多次流式推送，实现「打字机效果」。
    """

    def __init__(
        self,
        ws_send_fn: Callable[[Dict[str, Any]], Coroutine[Any, Any, None]],
        *,
        max_chunk: int = MAX_STREAM_CHUNK,
        interval: float = STREAM_INTERVAL,
    ):
        self._ws_send = ws_send_fn
        self._max_chunk = max_chunk
        self._interval = interval

    async def send_streaming(
        self,
        chat_id: str,
        text: str,
        *,
        msg_id: str = "",
    ) -> None:
        """
        流式发送长文本。

        Args:
            chat_id: 目标会话 ID
            text: 完整文本内容
            msg_id: 消息 ID（用于追加流式内容）
        """
        if len(text) <= self._max_chunk:
            # 短消息直接发送，不走流式
            await self._send_respond(chat_id, text, msg_id=msg_id, stream_type=None)
            return

        # 拆分为多个片段
        chunks = self._split_text(text)

        for i, chunk in enumerate(chunks):
            if i == 0:
                stream_type = STREAM_START
            elif i == len(chunks) - 1:
                stream_type = STREAM_END
            else:
                stream_type = STREAM_APPEND

            await self._send_respond(
                chat_id, chunk, msg_id=msg_id, stream_type=stream_type
            )

            # 推送间隔
            if i < len(chunks) - 1:
                await asyncio.sleep(self._interval)

        logger.debug(f"流式发送完成: {len(chunks)} 个片段到 {chat_id}")

    async def _send_respond(
        self,
        chat_id: str,
        text: str,
        *,
        msg_id: str = "",
        stream_type: Optional[str] = None,
    ) -> None:
        """发送 aibot_respond_msg 命令"""
        payload: Dict[str, Any] = {
            "header": {"commandType": 2},
            "payload": {
                "chatId": chat_id,
                "chatType": "single",
                "contentType": "text",
                "content": text,
            },
        }

        if msg_id:
            payload["payload"]["msgId"] = msg_id

        if stream_type:
            payload["payload"]["streamType"] = stream_type

        try:
            await self._ws_send(payload)
        except Exception as e:
            logger.error(f"流式发送失败: {e}")

    def _split_text(self, text: str) -> list[str]:
        """
        智能分割文本。

        优先在换行符处分割，避免在单词/句子中间切断。
        """
        chunks = []
        remaining = text

        while remaining:
            if len(remaining) <= self._max_chunk:
                chunks.append(remaining)
                break

            # 在 max_chunk 范围内找最后一个换行符
            split_pos = remaining.rfind("\n", 0, self._max_chunk)
            if split_pos == -1 or split_pos < self._max_chunk // 2:
                # 没有合适的换行位置，按字符截断
                split_pos = self._max_chunk

            chunks.append(remaining[:split_pos])
            remaining = remaining[split_pos:].lstrip("\n")

        return chunks
