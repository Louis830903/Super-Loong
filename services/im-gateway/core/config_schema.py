"""
配置 Schema — Schema 驱动的渠道配置定义

对标 OpenClaw ChannelConfigSchema = Zod Schema + UI Hints，
后端声明配置字段，前端自动渲染表单。
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class FieldType(str, Enum):
    """配置字段类型"""
    STRING = "string"
    SECRET = "secret"       # 密码/密钥，UI 显示为密码框
    NUMBER = "number"
    BOOLEAN = "boolean"
    SELECT = "select"       # 下拉选择
    URL = "url"


@dataclass
class FieldSchema:
    """单个配置字段的 Schema"""
    key: str                           # 字段标识
    label: str                         # 显示名称（中文）
    field_type: FieldType              # 字段类型
    required: bool = True              # 是否必填
    default: Any = None                # 默认值
    placeholder: str = ""              # 占位提示
    help_text: str = ""                # 帮助文本
    options: list[dict] = field(default_factory=list)  # SELECT 类型的选项
    group: str = "basic"               # 分组：basic/advanced
    order: int = 0                     # 排序

    def to_dict(self) -> dict:
        """序列化为前端可用的字典"""
        return {
            "key": self.key,
            "label": self.label,
            "type": self.field_type.value,
            "required": self.required,
            "default": self.default,
            "placeholder": self.placeholder,
            "help_text": self.help_text,
            "options": self.options,
            "group": self.group,
            "order": self.order,
        }


@dataclass
class ChannelConfigSchema:
    """渠道配置 Schema — 前端据此自动渲染表单"""
    channel_id: str
    channel_label: str
    fields: list[FieldSchema]
    docs_url: str = ""
    setup_guide: str = ""              # Markdown 格式的配置指引

    def to_dict(self) -> dict:
        """序列化给前端 API"""
        return {
            "channel_id": self.channel_id,
            "channel_label": self.channel_label,
            "docs_url": self.docs_url,
            "setup_guide": self.setup_guide,
            "fields": [
                f.to_dict()
                for f in sorted(self.fields, key=lambda x: x.order)
            ],
        }

    def get_required_keys(self) -> list[str]:
        """获取所有必填字段的 key 列表"""
        return [f.key for f in self.fields if f.required]

    def validate_credentials(self, credentials: dict) -> Optional[str]:
        """
        基于 Schema 校验凭证完整性

        Returns:
            None 表示通过，否则返回第一个错误信息
        """
        for f in self.fields:
            if f.required and not credentials.get(f.key):
                return f"缺少必填配置: {f.label} ({f.key})"
        return None
