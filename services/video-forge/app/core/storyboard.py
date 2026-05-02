"""
分镜数据模型 — Storyboard / Frame / Config 等 Pydantic dataclass。

从 Pixelle models/storyboard.py 迁移。
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class StoryboardConfig:
    """分镜配置参数"""

    # 必填参数
    media_width: int
    media_height: int

    # 任务隔离
    task_id: Optional[str] = None

    n_storyboard: int = 5
    min_narration_words: int = 5
    max_narration_words: int = 20
    min_image_prompt_words: int = 30
    max_image_prompt_words: int = 60

    # 视频帧率
    video_fps: int = 30

    # TTS 参数
    tts_inference_mode: str = "local"
    voice_id: Optional[str] = None
    tts_workflow: Optional[str] = None
    tts_speed: Optional[float] = None
    ref_audio: Optional[str] = None

    # 媒体工作流
    media_workflow: Optional[str] = None

    # 帧模板
    frame_template: str = "1080x1920/default.html"
    template_params: Optional[Dict[str, Any]] = None


@dataclass
class StoryboardFrame:
    """单帧分镜"""

    index: int
    narration: str
    image_prompt: str

    # 生成资源路径
    audio_path: Optional[str] = None
    media_type: Optional[str] = None
    image_path: Optional[str] = None
    video_path: Optional[str] = None
    composed_image_path: Optional[str] = None
    video_segment_path: Optional[str] = None

    # 元数据
    duration: float = 0.0
    created_at: Optional[datetime] = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()


@dataclass
class ContentMetadata:
    """内容元数据 — 用于可视化显示与旁白生成"""

    title: str
    author: Optional[str] = None
    subtitle: Optional[str] = None
    genre: Optional[str] = None
    summary: Optional[str] = None
    publication_year: Optional[str] = None
    cover_url: Optional[str] = None


@dataclass
class Storyboard:
    """完整分镜脚本"""

    title: str
    config: StoryboardConfig
    frames: List[StoryboardFrame] = field(default_factory=list)

    content_metadata: Optional[ContentMetadata] = None

    final_video_path: Optional[str] = None
    total_duration: float = 0.0

    created_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.now()

    @property
    def is_completed(self) -> bool:
        return all(f.video_segment_path is not None for f in self.frames)

    @property
    def progress(self) -> float:
        if not self.frames:
            return 0.0
        completed = sum(1 for f in self.frames if f.video_segment_path is not None)
        return completed / len(self.frames)


@dataclass
class VideoGenerationResult:
    """视频生成结果"""

    video_path: str
    storyboard: Storyboard
    duration: float
    file_size: int
    created_at: datetime = field(default_factory=datetime.now)
