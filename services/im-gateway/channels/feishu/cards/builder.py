"""
飞书互动卡片构建器 — 支持按钮、表单、多列布局

参考 Hermes feishu.py _build_markdown_post_payload() 实现。
"""

from typing import Any, Dict, List, Optional


def build_text_card(title: str, content: str, *, color: str = "blue") -> Dict[str, Any]:
    """构建纯文本卡片"""
    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": color,
            },
            "elements": [
                {"tag": "markdown", "content": content}
            ],
        },
    }


def build_button_card(
    title: str,
    content: str,
    buttons: List[Dict[str, str]],
    *,
    color: str = "blue",
) -> Dict[str, Any]:
    """
    构建带按钮的互动卡片。

    buttons 格式: [{"text": "按钮文本", "value": "回调值", "type": "primary|danger|default"}]
    """
    button_elements = []
    for btn in buttons:
        button_elements.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": btn["text"]},
            "type": btn.get("type", "default"),
            "value": {"action": btn.get("value", btn["text"])},
        })

    elements: List[Dict[str, Any]] = [
        {"tag": "markdown", "content": content},
        {"tag": "hr"},
        {
            "tag": "action",
            "actions": button_elements,
        },
    ]

    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": color,
            },
            "elements": elements,
        },
    }


def build_multi_column_card(
    title: str,
    columns: List[List[Dict[str, Any]]],
    *,
    color: str = "blue",
) -> Dict[str, Any]:
    """
    构建多列布局卡片。

    columns: [[左列元素], [右列元素]]
    每个元素: {"tag": "markdown", "content": "..."}
    """
    column_set = {
        "tag": "column_set",
        "flex_mode": "bisect",
        "background_style": "default",
        "columns": [],
    }

    for col_elements in columns:
        column_set["columns"].append({
            "tag": "column",
            "width": "weighted",
            "weight": 1,
            "elements": col_elements,
        })

    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": color,
            },
            "elements": [column_set],
        },
    }


def build_form_card(
    title: str,
    fields: List[Dict[str, Any]],
    submit_text: str = "提交",
    *,
    color: str = "blue",
) -> Dict[str, Any]:
    """
    构建表单卡片。

    fields 格式: [{"label": "姓名", "name": "name", "type": "input|select", "placeholder": "..."}]
    """
    form_elements: List[Dict[str, Any]] = []

    for field in fields:
        if field.get("type") == "select":
            form_elements.append({
                "tag": "select_static",
                "placeholder": {"tag": "plain_text", "content": field.get("placeholder", "请选择")},
                "options": [
                    {"text": {"tag": "plain_text", "content": opt}, "value": opt}
                    for opt in field.get("options", [])
                ],
            })
        else:
            form_elements.append({
                "tag": "input",
                "name": field.get("name", ""),
                "placeholder": {"tag": "plain_text", "content": field.get("placeholder", "请输入")},
                "label": {"tag": "plain_text", "content": field.get("label", "")},
            })

    form_elements.append({
        "tag": "button",
        "text": {"tag": "plain_text", "content": submit_text},
        "type": "primary",
        "value": {"action": "form_submit"},
    })

    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": color,
            },
            "elements": [
                {
                    "tag": "form",
                    "name": "main_form",
                    "elements": form_elements,
                }
            ],
        },
    }
