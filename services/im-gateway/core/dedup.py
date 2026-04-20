"""
消息去重器 — 防止平台重发导致重复处理

基于 LRU + TTL 的消息去重，独立于各平台的内建去重。
各平台（特别是企微和钉钉）均有消息重发问题，
需要在网关层做统一去重保护。
"""

import time
from collections import OrderedDict


class MessageDeduplicator:
    """基于 LRU + TTL 的消息去重"""

    def __init__(self, max_size: int = 1000, ttl_seconds: int = 300):
        self._cache: OrderedDict[str, float] = OrderedDict()
        self._max_size = max_size
        self._ttl = ttl_seconds

    def is_duplicate(self, msg_id: str) -> bool:
        """
        检查消息是否重复，非重复则记录

        Args:
            msg_id: 消息唯一标识（通常为 channel_id:platform_msg_id）

        Returns:
            True 表示重复消息，应丢弃
        """
        if not msg_id:
            return False  # 无 ID 的消息不做去重

        self._evict_expired()

        if msg_id in self._cache:
            # 已见过，移到末尾（LRU）
            self._cache.move_to_end(msg_id)
            return True

        # 新消息，记录
        self._cache[msg_id] = time.time()
        if len(self._cache) > self._max_size:
            self._cache.popitem(last=False)  # 淘汰最旧
        return False

    def _evict_expired(self) -> None:
        """清理过期条目"""
        now = time.time()
        expired = [k for k, t in self._cache.items() if now - t > self._ttl]
        for k in expired:
            del self._cache[k]

    def clear(self) -> None:
        """清空去重缓存"""
        self._cache.clear()

    @property
    def size(self) -> int:
        """当前缓存大小"""
        return len(self._cache)
