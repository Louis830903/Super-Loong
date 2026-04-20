"""
⚠️ DEPRECATED — 本文件为孤岛代码，未被任何模块导入或注册。

飞书完整适配器 — 整合所有增强模块（原设计）

将 cards、events、batching、dedup、rich_text、security、connection 等模块
组装为统一的飞书适配器门面，供 IM Gateway 注册使用。

当前架构已迁移至 OpenClaw 插件体系：
- 入站: feishu/gateway.py (FeishuGateway → GatewayAdapter)
- 出站: feishu/outbound.py (FeishuOutbound → OutboundAdapter)
- 注册: feishu/plugin.py (FeishuPlugin → ChannelPlugin)

本文件保留仅供参考，计划在后续版本中移除。
"""

import logging
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger("feishu.adapter")


class FeishuEnhancedAdapter:
    """
    飞书增强适配器 — 聚合所有新增模块的统一门面。

    用法示例：
        adapter = FeishuEnhancedAdapter()
        adapter.setup(send_fn=my_send_function, config=channel_config)

        # 卡片构建
        card = adapter.cards.build_text_card("标题", "内容")

        # 消息批处理
        await adapter.batcher.enqueue(chat_id, "hello")

        # 消息去重
        if adapter.dedup.is_duplicate(event_id):
            return  # 跳过重复消息

        # 事件路由
        result = await adapter.event_router.dispatch(event)

        # 富文本
        post = adapter.rich_text.markdown_to_post("# Hello")
    """

    def __init__(self):
        self._send_fn: Optional[Callable] = None
        self._config: Dict[str, Any] = {}
        self._initialized = False

        # 延迟初始化的子模块
        self._batcher = None
        self._dedup = None
        self._event_router = None
        self._card_action_handler = None
        self._rate_limiter = None
        self._connection_manager = None

    def setup(
        self,
        send_fn: Callable[[str, str], Coroutine[Any, Any, None]],
        config: Optional[Dict[str, Any]] = None,
    ) -> "FeishuEnhancedAdapter":
        """
        初始化适配器。

        Args:
            send_fn: 消息发送函数 (chat_id, content) → None
            config: 渠道配置
        """
        self._send_fn = send_fn
        self._config = config or {}
        self._initialized = True
        self._init_modules()
        logger.info("飞书增强适配器初始化完成")
        return self

    def _init_modules(self) -> None:
        """初始化所有子模块"""
        # 消息批处理
        from .batching import MessageBatcher
        self._batcher = MessageBatcher(self._send_fn)

        # 消息去重
        from .dedup import MessageDeduplicator
        self._dedup = MessageDeduplicator()

        # 事件路由
        from .events.handler import FeishuEventRouter
        self._event_router = FeishuEventRouter()

        # 卡片交互回调
        from .events.card_action import FeishuCardActionHandler
        self._card_action_handler = FeishuCardActionHandler()

        # 速率限制
        from .security import RateLimiter
        self._rate_limiter = RateLimiter()

        # 注册卡片交互事件到路由器
        from .events.handler import EVENT_TYPE_CARD_ACTION
        self._event_router.on(EVENT_TYPE_CARD_ACTION, self._card_action_handler.handle)

    @property
    def batcher(self):
        """消息批处理器"""
        return self._batcher

    @property
    def dedup(self):
        """消息去重器"""
        return self._dedup

    @property
    def event_router(self):
        """事件路由器"""
        return self._event_router

    @property
    def card_action_handler(self):
        """卡片交互回调处理器"""
        return self._card_action_handler

    @property
    def rate_limiter(self):
        """速率限制器"""
        return self._rate_limiter

    # ── 便捷方法 ──

    async def send_text(self, chat_id: str, text: str, *, batch: bool = True) -> None:
        """
        发送文本消息。

        Args:
            chat_id: 目标会话 ID
            text: 文本内容
            batch: 是否启用批处理（默认启用）
        """
        if batch and self._batcher:
            await self._batcher.enqueue(chat_id, text)
        elif self._send_fn:
            await self._send_fn(chat_id, text)

    async def send_card(self, chat_id: str, card: Dict[str, Any]) -> None:
        """发送卡片消息（不走批处理）"""
        if self._send_fn:
            import json
            await self._send_fn(chat_id, json.dumps(card))

    async def send_approval(
        self,
        chat_id: str,
        title: str,
        command: str,
        description: str = "",
        request_id: str = "",
    ) -> None:
        """发送执行审批卡片"""
        from .cards.approval import build_approval_card
        card = build_approval_card(title, command, description, request_id=request_id)
        await self.send_card(chat_id, card)

    async def send_rich_text(
        self,
        chat_id: str,
        markdown: str,
        title: str = "",
    ) -> None:
        """发送富文本消息（Markdown → 飞书 post 格式）"""
        from .rich_text import markdown_to_post
        post = markdown_to_post(markdown, title)
        await self.send_card(chat_id, post)

    def check_webhook_signature(
        self,
        timestamp: str,
        nonce: str,
        body: str,
        signature: str,
    ) -> bool:
        """验证 Webhook 签名"""
        from .security import verify_webhook_signature
        encrypt_key = self._config.get("credentials", {}).get("encrypt_key", "")
        return verify_webhook_signature(timestamp, nonce, body, signature, encrypt_key)

    def check_rate_limit(self, key: str) -> bool:
        """检查速率限制"""
        if self._rate_limiter:
            return self._rate_limiter.is_allowed(key)
        return True

    async def handle_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        处理飞书事件的统一入口。

        自动完成：验签 → 去重 → 路由 → 处理
        """
        # 去重检查
        event_id = event.get("header", {}).get("event_id", "")
        if event_id and self._dedup and self._dedup.is_duplicate(event_id):
            logger.debug(f"跳过重复事件: {event_id}")
            return {"code": 0, "msg": "duplicate"}

        # 路由分发
        if self._event_router:
            return await self._event_router.dispatch(event)

        return None

    async def shutdown(self) -> None:
        """优雅关闭"""
        if self._batcher:
            await self._batcher.flush_all()
        logger.info("飞书增强适配器已关闭")
