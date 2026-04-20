"""
飞书消息去重 — SHA256 hash + TTL 过期 + 磁盘持久化

参考 Hermes feishu.py _is_duplicate() + _persist_seen_message_ids() 实现。
"""

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger("feishu.dedup")

# 默认去重窗口 5 分钟
DEFAULT_TTL_SECONDS = 300
# 持久化文件路径
DEFAULT_PERSIST_FILE = "feishu_seen_messages.json"


class MessageDeduplicator:
    """
    飞书消息去重器。

    使用 SHA256 hash + TTL 过期机制防止重复消息处理。
    支持内存缓存 + 磁盘持久化。
    """

    def __init__(
        self,
        *,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        persist_path: Optional[str] = None,
        max_entries: int = 10000,
    ):
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._persist_path = persist_path
        # message_id → 首次见到的时间戳
        self._seen: Dict[str, float] = {}
        # 启动时加载持久化数据
        if persist_path:
            self._load_persisted()

    def is_duplicate(self, message_id: str) -> bool:
        """
        检查消息是否重复。

        如果消息在 TTL 窗口内已见过，返回 True。
        """
        now = time.time()

        # 先清理过期条目
        self._cleanup(now)

        if message_id in self._seen:
            return True

        # 记录新消息
        self._seen[message_id] = now

        # 超限时淘汰最旧条目
        if len(self._seen) > self._max_entries:
            oldest_key = min(self._seen, key=self._seen.get)  # type: ignore
            del self._seen[oldest_key]

        return False

    def mark_seen(self, message_id: str) -> None:
        """标记消息为已见。"""
        self._seen[message_id] = time.time()

    def persist(self) -> None:
        """持久化到磁盘。"""
        if not self._persist_path:
            return
        try:
            data = {
                "version": 1,
                "ttl": self._ttl,
                "entries": self._seen,
            }
            Path(self._persist_path).write_text(
                json.dumps(data), encoding="utf-8"
            )
            logger.debug(f"去重数据已持久化: {len(self._seen)} 条")
        except Exception as e:
            logger.error(f"去重数据持久化失败: {e}")

    def _load_persisted(self) -> None:
        """从磁盘加载持久化数据。"""
        if not self._persist_path:
            return
        try:
            p = Path(self._persist_path)
            if not p.exists():
                return
            data = json.loads(p.read_text(encoding="utf-8"))
            entries = data.get("entries", {})
            now = time.time()
            # 只加载未过期的条目
            for msg_id, ts in entries.items():
                if now - ts < self._ttl:
                    self._seen[msg_id] = ts
            logger.debug(f"去重数据已加载: {len(self._seen)} 条")
        except Exception as e:
            logger.error(f"去重数据加载失败: {e}")

    def _cleanup(self, now: float) -> None:
        """清理过期条目。"""
        expired = [k for k, v in self._seen.items() if now - v >= self._ttl]
        for k in expired:
            del self._seen[k]
