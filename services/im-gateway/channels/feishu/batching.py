"""
飞书消息批处理 — 短间隔消息合并发送

参考 Hermes feishu.py _enqueue_text_event() / _enqueue_media_event() 实现。
文本消息 0.6s 延迟合并，拆分消息 2.0s 延迟合并。
"""

import asyncio
import logging
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger("feishu.batching")

# 批处理延迟（秒）
TEXT_BATCH_DELAY = 0.6
SPLIT_BATCH_DELAY = 2.0


class MessageBatcher:
    """
    飞书消息批处理器。

    将短间隔内的多条消息合并为一次发送，减少 API 调用频次。
    """

    def __init__(
        self,
        send_fn: Callable[[str, str], Coroutine[Any, Any, None]],
        *,
        text_delay: float = TEXT_BATCH_DELAY,
        split_delay: float = SPLIT_BATCH_DELAY,
    ):
        self._send_fn = send_fn
        self._text_delay = text_delay
        self._split_delay = split_delay
        # chat_id → 待发送消息列表
        self._buffers: Dict[str, List[str]] = {}
        # chat_id → 延迟发送任务
        self._timers: Dict[str, asyncio.Task] = {}

    async def enqueue(
        self,
        chat_id: str,
        text: str,
        *,
        is_split: bool = False,
    ) -> None:
        """
        入队一条消息。

        如果短时间内有多条消息入队，会合并发送。
        """
        if chat_id not in self._buffers:
            self._buffers[chat_id] = []

        self._buffers[chat_id].append(text)

        # 取消上一个延迟任务（如果存在）
        if chat_id in self._timers:
            self._timers[chat_id].cancel()

        # 创建新的延迟发送任务
        delay = self._split_delay if is_split else self._text_delay
        self._timers[chat_id] = asyncio.create_task(
            self._delayed_flush(chat_id, delay)
        )

    async def flush(self, chat_id: str) -> None:
        """立即发送缓冲区中的所有消息。"""
        if chat_id in self._timers:
            self._timers[chat_id].cancel()
            del self._timers[chat_id]

        messages = self._buffers.pop(chat_id, [])
        if not messages:
            return

        # 合并消息
        combined = "\n\n".join(messages)
        try:
            await self._send_fn(chat_id, combined)
            logger.debug(f"批处理发送 {len(messages)} 条消息到 {chat_id}")
        except Exception as e:
            logger.error(f"批处理发送失败: {e}")

    async def flush_all(self) -> None:
        """立即发送所有缓冲区的消息。"""
        chat_ids = list(self._buffers.keys())
        for chat_id in chat_ids:
            await self.flush(chat_id)

    async def _delayed_flush(self, chat_id: str, delay: float) -> None:
        """延迟后自动发送。"""
        try:
            await asyncio.sleep(delay)
            await self.flush(chat_id)
        except asyncio.CancelledError:
            pass
