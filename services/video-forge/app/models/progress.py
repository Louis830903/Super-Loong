"""
进度事件模型 — 视频生成管线的结构化进度回调。

从 Pixelle models/progress.py 迁移。
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class ProgressEvent:
    """
    结构化进度事件

    Attributes:
        event_type: 事件类型 ("generating_narrations" / "frame_step" / "concatenating")
        progress: 进度 0.0–1.0
        frame_current: 当前帧号 (1-based)
        frame_total: 总帧数
        step: 帧内步骤 (1-4)
        action: 操作名 ("audio" / "media" / "compose" / "video")
    """

    event_type: str
    progress: float

    frame_current: Optional[int] = None
    frame_total: Optional[int] = None
    step: Optional[int] = None
    action: Optional[str] = None
    extra_info: Optional[str] = None

    def __post_init__(self):
        if not 0.0 <= self.progress <= 1.0:
            raise ValueError(f"Progress must be between 0.0 and 1.0, got {self.progress}")
