"""
飞书事件路由 — 7 种事件类型统一分发

参考 Hermes feishu.py 的事件处理流水线：
验签 → 解密 → 去重 → 路由 → 处理
"""

import logging
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger("feishu.events.handler")

# 支持的事件类型
EVENT_TYPE_MESSAGE = "im.message.receive_v1"
EVENT_TYPE_MESSAGE_READ = "im.message.message_read_v1"
EVENT_TYPE_CARD_ACTION = "card.action.trigger"
EVENT_TYPE_BOT_ADDED = "im.chat.member.bot.added_v1"
EVENT_TYPE_BOT_REMOVED = "im.chat.member.bot.deleted_v1"
EVENT_TYPE_USER_ADDED = "im.chat.member.user.added_v1"
EVENT_TYPE_CHAT_DISBANDED = "im.chat.disbanded_v1"

ALL_EVENT_TYPES = [
    EVENT_TYPE_MESSAGE,
    EVENT_TYPE_MESSAGE_READ,
    EVENT_TYPE_CARD_ACTION,
    EVENT_TYPE_BOT_ADDED,
    EVENT_TYPE_BOT_REMOVED,
    EVENT_TYPE_USER_ADDED,
    EVENT_TYPE_CHAT_DISBANDED,
]

# 事件处理回调类型
EventHandler = Callable[[Dict[str, Any]], Coroutine[Any, Any, Optional[Dict[str, Any]]]]


class FeishuEventRouter:
    """
    飞书事件路由器。

    统一处理来自 Webhook/WebSocket 的事件，根据事件类型分发到对应处理器。
    支持链式注册多个处理器（同一事件类型可注册多个，按顺序执行）。
    """

    def __init__(self):
        # event_type → handler list
        self._handlers: Dict[str, List[EventHandler]] = {}
        self._processed_count: int = 0
        self._error_count: int = 0

    def on(self, event_type: str, handler: EventHandler) -> "FeishuEventRouter":
        """
        注册事件处理器。

        支持链式调用：router.on("im.message.receive_v1", handler1).on("card.action.trigger", handler2)
        """
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(handler)
        logger.debug(f"注册事件处理器: {event_type} (共 {len(self._handlers[event_type])} 个)")
        return self

    def off(self, event_type: str, handler: Optional[EventHandler] = None) -> None:
        """
        移除事件处理器。

        如果不指定 handler，移除该事件类型的所有处理器。
        """
        if handler is None:
            self._handlers.pop(event_type, None)
        elif event_type in self._handlers:
            self._handlers[event_type] = [h for h in self._handlers[event_type] if h is not handler]

    async def dispatch(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        分发事件到对应处理器。

        Args:
            event: 飞书事件 JSON（已解密、已去重）

        Returns:
            处理结果（如果有）；卡片事件需返回更新后的卡片 JSON
        """
        # 提取事件类型
        event_type = self._extract_event_type(event)
        if not event_type:
            logger.warning(f"无法识别事件类型: {list(event.keys())}")
            return None

        handlers = self._handlers.get(event_type, [])
        if not handlers:
            logger.debug(f"事件 {event_type} 无注册处理器，跳过")
            return None

        self._processed_count += 1
        result = None

        for handler in handlers:
            try:
                result = await handler(event)
            except Exception as e:
                self._error_count += 1
                logger.error(f"事件处理异常 [{event_type}]: {e}", exc_info=True)

        return result

    async def handle_webhook_request(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """
        处理 Webhook HTTP 请求体。

        自动识别以下类型：
        1. URL 验证请求（type=url_verification）
        2. 事件回调（type=event_callback）
        3. 卡片交互回调
        """
        req_type = body.get("type", "")

        # URL 验证（飞书配置回调地址时的验证请求）
        if req_type == "url_verification":
            challenge = body.get("challenge", "")
            logger.info("处理 URL 验证请求")
            return {"challenge": challenge}

        # 事件回调
        if req_type == "event_callback":
            result = await self.dispatch(body)
            return result or {"code": 0, "msg": "ok"}

        # 卡片交互回调（无 type 字段，通过 action 字段识别）
        if "action" in body or "token" in body:
            result = await self.dispatch(body)
            return result or {}

        logger.warning(f"未知请求类型: {req_type}")
        return {"code": 0, "msg": "ok"}

    @property
    def stats(self) -> Dict[str, Any]:
        """返回处理统计"""
        return {
            "registered_types": list(self._handlers.keys()),
            "handler_count": sum(len(h) for h in self._handlers.values()),
            "processed_count": self._processed_count,
            "error_count": self._error_count,
        }

    @staticmethod
    def _extract_event_type(event: Dict[str, Any]) -> Optional[str]:
        """从事件 JSON 提取事件类型"""
        # 标准事件回调格式
        header = event.get("header", {})
        if header.get("event_type"):
            return header["event_type"]

        # 兼容旧版格式
        event_body = event.get("event", {})
        if event_body.get("type"):
            return event_body["type"]

        # 卡片交互回调
        if "action" in event:
            return EVENT_TYPE_CARD_ACTION

        return None
