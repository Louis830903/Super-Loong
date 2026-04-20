"""
企微 Markdown 消息格式化

企微消息支持有限的 Markdown 子集，本模块提供适配转换：
- 企微 Markdown 限制：不支持表格、不支持 HTML、链接格式不同
- 标准 Markdown → 企微兼容格式
"""

import re
import logging
from typing import List

logger = logging.getLogger("wecom.markdown")

# 企微 Markdown 限制
WECOM_MAX_LENGTH = 4096


def format_markdown(text: str, *, max_length: int = WECOM_MAX_LENGTH) -> str:
    """
    将标准 Markdown 转换为企微兼容的 Markdown 格式。

    转换规则：
    1. 链接 [text](url) → <a href="url">text</a>（企微卡片支持）
    2. 图片 ![alt](url) → 移除（企微 Markdown 不支持内联图片）
    3. 表格 → 文本替代
    4. 代码块保持不变（企微支持）
    5. 超长截断
    """
    if len(text) > max_length:
        text = text[:max_length - 20] + "\n\n... (内容已截断)"

    # 移除图片标记（企微 Markdown 不支持）
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"[\1]", text)

    # 转换 HTML 表格（如果有）
    text = _convert_tables(text)

    return text


def format_text_message(text: str) -> dict:
    """构建企微文本消息体"""
    return {
        "msgtype": "text",
        "text": {"content": text},
    }


def format_markdown_message(text: str) -> dict:
    """构建企微 Markdown 消息体"""
    return {
        "msgtype": "markdown",
        "markdown": {"content": format_markdown(text)},
    }


def split_long_message(text: str, max_length: int = WECOM_MAX_LENGTH) -> List[str]:
    """
    拆分长消息为多条。

    优先在段落边界（空行）拆分，其次在行边界拆分。
    """
    if len(text) <= max_length:
        return [text]

    parts = []
    remaining = text

    while remaining:
        if len(remaining) <= max_length:
            parts.append(remaining)
            break

        # 在段落边界拆分（双换行）
        split_pos = remaining.rfind("\n\n", 0, max_length)
        if split_pos == -1 or split_pos < max_length // 3:
            # 在行边界拆分
            split_pos = remaining.rfind("\n", 0, max_length)
        if split_pos == -1 or split_pos < max_length // 3:
            # 强制截断
            split_pos = max_length

        parts.append(remaining[:split_pos])
        remaining = remaining[split_pos:].lstrip("\n")

    return parts


def _convert_tables(text: str) -> str:
    """
    将 Markdown 表格转换为企微兼容的纯文本格式。

    企微 Markdown 不支持表格，转为缩进文本。
    """
    lines = text.split("\n")
    result = []
    in_table = False
    headers = []

    for line in lines:
        stripped = line.strip()

        # 检测表格行
        if "|" in stripped and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]

            # 分隔行（--- 行），跳过
            if all(re.match(r"^[-:]+$", c) for c in cells if c):
                in_table = True
                continue

            if not in_table:
                # 表头
                headers = cells
                in_table = True
                continue

            # 数据行：转为 "字段: 值" 格式
            pairs = []
            for i, cell in enumerate(cells):
                header = headers[i] if i < len(headers) else f"列{i+1}"
                pairs.append(f"{header}: {cell}")
            result.append("  ".join(pairs))
            continue

        # 非表格行
        if in_table:
            in_table = False
            headers = []
        result.append(line)

    return "\n".join(result)
