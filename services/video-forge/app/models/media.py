"""
媒体生成结果模型 — 从 Pixelle models/media.py 迁移。
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field


class MediaResult(BaseModel):
    """
    媒体生成结果。

    Attributes:
        media_type: 生成的媒体类型 ("image" 或 "video")
        url: 生成的媒体文件的 URL 或本地路径
        duration: 时长（秒），仅视频有效
        local_path: 本地落盘绝对路径（standard_api 自动落盘后写入，可选）
    """

    media_type: Literal["image", "video"] = Field(description="媒体类型")
    url: str = Field(description="媒体文件 URL 或路径")
    duration: Optional[float] = Field(None, description="时长（秒），仅视频有效")
    local_path: Optional[str] = Field(
        None, description="本地落盘绝对路径（standard_api 自动落盘）"
    )

    @property
    def is_image(self) -> bool:
        return self.media_type == "image"

    @property
    def is_video(self) -> bool:
        return self.media_type == "video"
