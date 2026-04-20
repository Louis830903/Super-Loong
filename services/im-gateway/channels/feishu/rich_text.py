"""
飞书富文本渲染 — Markdown → 飞书 post 格式

参考 Hermes feishu.py _build_markdown_post_payload() 实现。
飞书 post 消息格式文档：https://open.feishu.cn/document/common-capabilities/message-card

支持的转换：
- Markdown 标题 → post title
- **粗体** → bold 标签
- *斜体* → italic 标签
- `代码` → text 标签（monospace 样式不支持，保持原样）
- [链接](url) → a 标签
- 图片 → img 标签
- 代码块 → code_block 元素
"""

import re
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("feishu.rich_text")


def markdown_to_post(
    markdown: str,
    title: str = "",
    *,
    max_length: int = 30000,
) -> Dict[str, Any]:
    """
    将 Markdown 文本转换为飞书 post 富文本格式。

    Args:
        markdown: Markdown 格式文本
        title: 消息标题（可选）
        max_length: 最大字符数（超长截断）

    Returns:
        飞书 post 消息体
    """
    if len(markdown) > max_length:
        markdown = markdown[:max_length] + "\n\n... (内容过长，已截断)"

    lines = markdown.split("\n")
    content: List[List[Dict[str, Any]]] = []
    i = 0

    while i < len(lines):
        line = lines[i]

        # 代码块处理
        if line.strip().startswith("```"):
            code_lines = []
            lang = line.strip()[3:].strip()
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            i += 1  # 跳过结束的 ```

            code_text = "\n".join(code_lines)
            content.append([{"tag": "text", "text": f"[{lang}]\n{code_text}" if lang else code_text}])
            continue

        # 空行
        if not line.strip():
            i += 1
            continue

        # 标题行（转为加粗文本段落）
        heading_match = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading_match:
            heading_text = heading_match.group(2)
            content.append([{"tag": "text", "text": heading_text, "style": ["bold"]}])
            i += 1
            continue

        # 普通段落 — 解析内联元素
        elements = _parse_inline(line)
        if elements:
            content.append(elements)
        i += 1

    return {
        "msg_type": "post",
        "content": {
            "post": {
                "zh_cn": {
                    "title": title,
                    "content": content,
                },
            },
        },
    }


def markdown_to_card(
    markdown: str,
    title: str = "",
    *,
    color: str = "blue",
) -> Dict[str, Any]:
    """
    将 Markdown 文本转换为飞书消息卡片格式。

    飞书卡片原生支持 Markdown 子集，可直接使用 markdown 元素。
    """
    card: Dict[str, Any] = {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "elements": [
                {"tag": "markdown", "content": markdown},
            ],
        },
    }

    if title:
        card["card"]["header"] = {
            "title": {"tag": "plain_text", "content": title},
            "template": color,
        }

    return card


def _parse_inline(text: str) -> List[Dict[str, Any]]:
    """
    解析 Markdown 内联元素为飞书 post 元素列表。

    支持：**粗体**、*斜体*、`代码`、[链接](url)、![图片](url)
    """
    elements: List[Dict[str, Any]] = []
    pos = 0

    # 合并的正则：匹配图片、链接、粗体、斜体、行内代码
    pattern = re.compile(
        r"!\[([^\]]*)\]\(([^)]+)\)"   # 图片
        r"|\[([^\]]+)\]\(([^)]+)\)"    # 链接
        r"|\*\*(.+?)\*\*"             # 粗体
        r"|\*(.+?)\*"                  # 斜体
        r"|`([^`]+)`"                  # 行内代码
    )

    for match in pattern.finditer(text):
        # 匹配之前的普通文本
        if match.start() > pos:
            plain = text[pos:match.start()]
            if plain:
                elements.append({"tag": "text", "text": plain})

        if match.group(1) is not None or match.group(2) is not None:
            # 图片 ![alt](url)
            img_url = match.group(2)
            elements.append({"tag": "img", "image_key": img_url})
        elif match.group(3) is not None:
            # 链接 [text](url)
            elements.append({"tag": "a", "text": match.group(3), "href": match.group(4)})
        elif match.group(5) is not None:
            # 粗体
            elements.append({"tag": "text", "text": match.group(5), "style": ["bold"]})
        elif match.group(6) is not None:
            # 斜体
            elements.append({"tag": "text", "text": match.group(6), "style": ["italic"]})
        elif match.group(7) is not None:
            # 行内代码
            elements.append({"tag": "text", "text": match.group(7)})

        pos = match.end()

    # 剩余文本
    if pos < len(text):
        remaining = text[pos:]
        if remaining:
            elements.append({"tag": "text", "text": remaining})

    return elements
