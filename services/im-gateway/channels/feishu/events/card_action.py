"""
飞书卡片按钮点击回调处理

参考 Hermes feishu.py 的审批回调逻辑：
- 解析 action.value 中的操作类型（approve/deny）
- 更新原卡片状态
- 触发后续动作
"""

import logging
from typing import Any, Callable, Coroutine, Dict, Optional

logger = logging.getLogger("feishu.events.card_action")

# 回调处理函数类型
ActionCallback = Callable[[str, str, Dict[str, Any]], Coroutine[Any, Any, None]]


class FeishuCardActionHandler:
    """
    飞书卡片交互回调处理器。

    处理用户点击卡片按钮后的回调事件，支持：
    1. 审批操作（approve/deny）
    2. 自定义按钮回调
    3. 表单提交回调
    """

    def __init__(self):
        # action_prefix → callback
        self._callbacks: Dict[str, ActionCallback] = {}

    def register(self, action_prefix: str, callback: ActionCallback) -> None:
        """
        注册按钮回调。

        action_prefix 对应 card builder 中 button value 的前缀。
        例如 "approve:" → 匹配 "approve:req_123"
        """
        self._callbacks[action_prefix] = callback
        logger.debug(f"注册卡片回调: {action_prefix}")

    async def handle(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        处理卡片交互事件。

        Args:
            event: 飞书卡片交互回调 JSON

        Returns:
            更新后的卡片 JSON（如果需要更新卡片内容）
        """
        action = event.get("action", {})
        action_value = action.get("value", "")

        # value 可能是字典（表单提交）或字符串（按钮点击）
        if isinstance(action_value, dict):
            return await self._handle_form_submit(event, action_value)

        # 按钮点击：匹配 action_prefix
        for prefix, callback in self._callbacks.items():
            if isinstance(action_value, str) and action_value.startswith(prefix):
                # 提取操作参数（前缀之后的部分）
                param = action_value[len(prefix):]
                operator = self._extract_operator(event)
                try:
                    await callback(prefix.rstrip(":"), param, {
                        "operator": operator,
                        "action": action,
                        "event": event,
                    })
                    logger.info(f"卡片回调成功: {prefix} param={param} operator={operator}")
                except Exception as e:
                    logger.error(f"卡片回调异常: {prefix} {e}", exc_info=True)
                return None

        logger.debug(f"未匹配的卡片操作: {action_value}")
        return None

    async def _handle_form_submit(
        self, event: Dict[str, Any], form_data: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """处理表单提交回调"""
        # 表单回调使用 "form:" 前缀
        callback = self._callbacks.get("form:")
        if callback:
            operator = self._extract_operator(event)
            try:
                await callback("form", "", {
                    "operator": operator,
                    "form_data": form_data,
                    "event": event,
                })
            except Exception as e:
                logger.error(f"表单回调异常: {e}", exc_info=True)
        return None

    @staticmethod
    def _extract_operator(event: Dict[str, Any]) -> str:
        """从事件中提取操作人信息"""
        # 卡片回调中的操作人
        open_id = event.get("open_id", "")
        if open_id:
            return open_id

        # 兼容 v2 格式
        operator = event.get("operator", {})
        if isinstance(operator, dict):
            return operator.get("open_id", "")

        return ""
