"""入站消息处理管道 — 统一接收、去重、Session 解析、能力注入、转发给 Agent Bridge

G6 四级管道：MessageEvent → 去重(dedup) → 重试检测(G7) → Session解析(G1) → 能力注入(G8) → Bridge转发(+session metadata)
"""

import asyncio
import logging
import mimetypes
import os
import time
from typing import Optional, TYPE_CHECKING

from core.types import MessageEvent, ChannelCapabilities, SessionKeyStrategy, MediaPayload

if TYPE_CHECKING:
    from core.dedup import MessageDeduplicator
    from core.session_manager import SessionManager

logger = logging.getLogger("gateway.pipeline")

# G7: 重试检测窗口（秒）— 用户在此时间内发送相似消息视为重试
_RETRY_WINDOW_S = 60


class MessagePipeline:
    """
    消息处理管道（G6 四级管道）

    处理流程：
    1. 去重 — 基于 channel_id:msg_id 去重
    2. 重试检测(G7) — 60s 内相似消息触发 nudge 标记
    3. Session 解析 — 通过 SessionManager 关联/创建 session
    4. 能力注入 — 将 ChannelCapabilities 附加到 metadata
    5. Bridge 转发 — 调用 bridge.send_message() 发送到 Agent API
    """

    def __init__(
        self,
        bridge,
        dedup: "MessageDeduplicator",
        session_manager: Optional["SessionManager"] = None,
        key_strategy: SessionKeyStrategy = SessionKeyStrategy.PER_USER_CHAT,
        registry=None,
        agent_router=None,
    ):
        self._bridge = bridge
        self._dedup = dedup
        self._session_manager = session_manager
        self._key_strategy = key_strategy
        self._registry = registry  # 用于获取 outbound_adapter 发送回复
        self._agent_router = agent_router  # 三级规则链 Agent 路由器
        # G7: 最近消息缓存 — user_key → (text, timestamp)
        self._recent_messages: dict[str, tuple[str, float]] = {}
        self._max_cache_size = 10000  # P2-03: 缓存上限保护，防止内存泄漏
        self._last_cleanup = time.monotonic()

    async def process(
        self,
        channel_id: str,
        event: MessageEvent,
        capabilities: Optional[ChannelCapabilities] = None,
    ) -> None:
        """
        处理入站消息

        Args:
            channel_id: 渠道标识（weixin/wecom/dingtalk/feishu）
            event: 统一消息事件
            capabilities: 渠道能力声明（G8 能力适配用）
        """
        # ── 1. 去重 ──
        dedup_key = f"{channel_id}:{event.msg_id}" if event.msg_id else ""
        if dedup_key and self._dedup.is_duplicate(dedup_key):
            logger.debug("消息去重: %s", dedup_key)
            return

        # ── 2. 重试检测（G7）──
        is_retry = self._detect_retry(channel_id, event)

        # ── 2.5 Agent 路由解析（三级规则链）──
        agent_id = ""
        if self._agent_router:
            agent_id = self._agent_router.resolve(
                platform=channel_id,
                chat_id=event.source.chat_id,
                user_id=event.source.user_id,
            )

        # ── 3. Session 解析（G1）──
        session = None
        if self._session_manager:
            session = self._session_manager.resolve_session(
                platform=channel_id,
                user_id=event.source.user_id,
                chat_id=event.source.chat_id,
                thread_id=event.source.thread_id,
                key_strategy=self._key_strategy,
                agent_id=agent_id,
            )

        # ── 4. 构建 metadata（含能力声明 G8 + platform G5）──
        metadata: dict = {
            "msg_type": event.msg_type.value,
            "media_urls": event.media_urls,
            "is_group": event.source.is_group,
            "sender_name": event.source.sender_name,
            "platform": channel_id,  # G5: 确保 bridge 传递 platform 字段
        }

        # G7: 重试标记
        if is_retry:
            metadata["is_retry"] = True
            # 异步通知进化引擎
            asyncio.create_task(self._report_retry_nudge(channel_id, event))

        # G8: 能力适配 — 附加渠道能力到 metadata
        if capabilities:
            metadata["capabilities"] = {
                "media": capabilities.media,
                "threads": capabilities.threads,
                "block_streaming": capabilities.block_streaming,
                "edit": capabilities.edit,
                "reactions": capabilities.reactions,
            }

        # G1: 附加 session 信息
        if session:
            metadata["session_key"] = session.session_key
            metadata["turn_count"] = session.turn_count

        # B-8: 传递 Phase A 附件处理器产出的图片数据
        if event.raw and isinstance(event.raw, dict) and "_images" in event.raw:
            metadata["_images"] = event.raw["_images"]

        # ── 5. 转发给 Agent Bridge（使用路由解析的 agent_id）──
        # 非文本消息（图片/文件/音频）的 text 为空，需生成描述性占位文本
        # 确保下游 API 校验通过（message.min(1)），且 Agent 知道用户发了什么
        effective_text = event.text
        if not effective_text or not effective_text.strip():
            if event.media_urls:
                _type_labels = {
                    "image": "图片", "file": "文件", "audio": "语音",
                }
                label = _type_labels.get(event.msg_type.value, event.msg_type.value)
                effective_text = f"[用户发送了{label}]"

        reply_text = await self._bridge.send_message(
            platform=channel_id,
            chat_id=event.source.chat_id,
            user_id=event.source.user_id,
            text=effective_text,
            metadata=metadata,
            agent_id=agent_id,  # 传入路由解析后的 agent_id
        )

        # ── 6. [新增] 通过 OutboundAdapter 将回复发送回 IM 平台 ──
        if reply_text and self._registry:
            await self._send_reply(
                channel_id,
                event.source.chat_id,
                reply_text,
                thread_id=event.source.thread_id,
                msg_id=event.msg_id,
            )

    # ── G7: 重试检测辅助方法 ──────────────────────────────

    def _detect_retry(self, channel_id: str, event: MessageEvent) -> bool:
        """
        G7: 检测用户重试 — 60s 内来自同一用户的相似消息视为重试

        检测逻辑：
        - 按 channel:user:chat 作为 key 跟踪最近一条消息
        - 新消息到达时，与缓存中的前条消息比较文本相似度
        - 超过阈值则标记为重试，前条视为失败
        """
        if not event.text or not event.text.strip():
            return False

        user_key = f"{channel_id}:{event.source.user_id}:{event.source.chat_id}"
        now = time.monotonic()
        is_retry = False

        prev = self._recent_messages.get(user_key)
        if prev:
            prev_text, prev_ts = prev
            elapsed = now - prev_ts
            if elapsed < _RETRY_WINDOW_S and self._text_similar(event.text, prev_text):
                is_retry = True
                logger.info(
                    "G7 重试检测: user=%s channel=%s 在 %.0fs 内发送相似消息",
                    event.source.user_id, channel_id, elapsed,
                )

        # 更新缓存
        self._recent_messages[user_key] = (event.text, now)

        # 定期清理过期条目（每 120s 清理一次，防止内存泄漏）
        if now - self._last_cleanup > 120:
            self._cleanup_stale(now)

        return is_retry

    @staticmethod
    def _text_similar(a: str, b: str) -> bool:
        """
        文本相似度检测 — 完全匹配或高度相似

        策略：
        1. 原文完全相同 → True
        2. 标准化后相同（忽略大小写/首尾空格）→ True
        3. 字符级相似度 > 80% → True（容忍用户微调消息后重发）
        """
        if a == b:
            return True

        a_norm = a.strip().lower()
        b_norm = b.strip().lower()
        if a_norm == b_norm:
            return True

        # 长度差异过大直接不相似
        if not a_norm or not b_norm:
            return False
        shorter = min(len(a_norm), len(b_norm))
        longer = max(len(a_norm), len(b_norm))
        if shorter / longer < 0.7:
            return False

        # 字符级相似度（简化版 — 逐字符比较取公共前缀+后缀占比）
        common = sum(1 for x, y in zip(a_norm, b_norm) if x == y)
        return common / longer > 0.8

    def _cleanup_stale(self, now: float) -> None:
        """清理过期的重试检测缓存条目"""
        # P2-03: 缓存超限时强制清理最旧条目
        if len(self._recent_messages) > self._max_cache_size:
            sorted_keys = sorted(
                self._recent_messages, key=lambda k: self._recent_messages[k][1]
            )
            for k in sorted_keys[: len(sorted_keys) // 2]:
                del self._recent_messages[k]
            logger.warning("G7 缓存超限强制清理: %d → %d", self._max_cache_size, len(self._recent_messages))
        stale_keys = [
            k for k, (_, ts) in self._recent_messages.items()
            if now - ts > _RETRY_WINDOW_S * 2
        ]
        for k in stale_keys:
            del self._recent_messages[k]
        self._last_cleanup = now
        if stale_keys:
            logger.debug("G7 清理过期缓存: %d 条", len(stale_keys))

    async def _report_retry_nudge(
        self, channel_id: str, event: MessageEvent
    ) -> None:
        """
        G7: 异步通知进化引擎用户重试（nudge）

        对齐 POST /api/evolution/interactions，type=retry_detected
        非关键路径，失败静默。
        """
        try:
            client = getattr(self._bridge, "_client", None)
            if not client:
                return
            await client.post(
                "/api/evolution/interactions",
                json={
                    "type": "retry_detected",
                    "platform": channel_id,
                    "userId": event.source.user_id,
                    "chatId": event.source.chat_id,
                    "message": event.text[:200] if event.text else "",
                },
                timeout=5.0,
            )
            logger.debug("G7 nudge 已发送: user=%s", event.source.user_id)
        except Exception:
            pass  # G7: 静默失败

    # ── 出站回复发送 ────────────────────────────────────

    async def _send_reply(self, channel_id: str, chat_id: str, reply_text: str,
                          thread_id: str = "", msg_id: str = ""):
        """将 Agent 回复通过 OutboundAdapter 发送回 IM 平台（含 1 次重试）"""
        plugin = self._registry.get(channel_id)
        if not plugin or not plugin.outbound_adapter:
            logger.warning("渠道 %s 无 outbound_adapter，无法回复", channel_id)
            return

        # 提取 MEDIA: 标记（bridge.py 的后向兼容格式）
        lines = reply_text.split("\n")
        text_lines = []
        media_paths = []
        for line in lines:
            if line.startswith("MEDIA:"):
                media_paths.append(line[6:])
            else:
                text_lines.append(line)

        clean_text = "\n".join(text_lines).rstrip()

        # 发送文本回复（含 1 次重试）
        if clean_text:
            result = None
            for attempt in range(2):
                try:
                    result = await plugin.outbound_adapter.send_text(
                        chat_id, clean_text,
                        thread_id=thread_id,
                        msg_id=msg_id,
                    )
                    if result.success:
                        logger.info(
                            "回复已发送: channel=%s, chat=%s, msg_id=%s",
                            channel_id, chat_id, result.message_id,
                        )
                        break
                    else:
                        logger.error(
                            "回复发送失败: channel=%s, error=%s (attempt=%d)",
                            channel_id, result.error, attempt + 1,
                        )
                except Exception as e:
                    logger.error(
                        "回复发送异常: channel=%s, error=%s (attempt=%d)",
                        channel_id, e, attempt + 1,
                    )
                    result = None
                # 第一次失败后等待 1s 再重试
                if attempt == 0:
                    await asyncio.sleep(1.0)

        # 发送媒体附件
        for path in media_paths:
            try:
                mime, _ = mimetypes.guess_type(path)
                mime = mime or "application/octet-stream"
                kind = "image" if mime.startswith("image/") else "file"
                payload = MediaPayload(
                    path=path, kind=kind, mime_type=mime,
                    filename=os.path.basename(path),
                )
                await plugin.outbound_adapter.send_media(chat_id, payload)
            except Exception as e:
                logger.error("媒体发送异常: channel=%s, path=%s, error=%s", channel_id, path, e)
