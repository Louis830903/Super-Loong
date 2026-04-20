"""
飞书执行审批卡片 — Approve/Deny 按钮 + 状态更新回调

参考 Hermes feishu.py send_exec_approval() 实现。
"""

from typing import Any, Dict, Optional
from .builder import build_button_card


def build_approval_card(
    title: str,
    command: str,
    description: str = "",
    *,
    request_id: str = "",
) -> Dict[str, Any]:
    """
    构建执行审批卡片。

    展示待审批的命令/操作，提供 Approve/Deny 两个按钮。
    """
    content_lines = []
    if description:
        content_lines.append(description)
    content_lines.append(f"**待执行命令：**\n```\n{command}\n```")

    buttons = [
        {"text": "✅ 批准执行", "value": f"approve:{request_id}", "type": "primary"},
        {"text": "❌ 拒绝", "value": f"deny:{request_id}", "type": "danger"},
    ]

    return build_button_card(
        title=f"🔐 {title}",
        content="\n".join(content_lines),
        buttons=buttons,
        color="orange",
    )


def build_approval_result_card(
    title: str,
    command: str,
    approved: bool,
    operator: str = "",
    result: str = "",
) -> Dict[str, Any]:
    """
    构建审批结果卡片（更新原卡片状态）。
    """
    status = "✅ 已批准" if approved else "❌ 已拒绝"
    color = "green" if approved else "red"

    content_lines = [
        f"**状态：** {status}",
    ]
    if operator:
        content_lines.append(f"**操作人：** {operator}")
    content_lines.append(f"**命令：**\n```\n{command}\n```")
    if result:
        content_lines.append(f"**执行结果：**\n{result}")

    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": f"🔐 {title}"},
                "template": color,
            },
            "elements": [
                {"tag": "markdown", "content": "\n".join(content_lines)},
            ],
        },
    }
