"""
工作区隔离 — 为每个 VideoJob 创建独立的工作目录。

目录约定（Spec §4.5）：
  ~/.super-agent/media/outbound/video-jobs/{job_id}/
    ├── script.json               # WriterAgent 产出
    ├── storyboard.json           # StoryboardAgent 产出
    ├── frames/                   # 分帧图
    ├── audio/                    # TTS 旁白
    ├── segments/                 # 单帧合成视频
    └── final.mp4                 # 最终产物
"""

import os
from pathlib import Path
from loguru import logger

# 子目录列表（创建工作区时一次性生成）
_SUBDIRS = ["frames", "audio", "segments"]


def _media_root() -> Path:
    """
    解析媒体根目录：~/.super-agent/media/outbound/video-jobs/
    支持通过环境变量 SUPER_AGENT_MEDIA_ROOT 覆盖。
    """
    custom = os.environ.get("SUPER_AGENT_MEDIA_ROOT")
    if custom:
        return Path(custom) / "video-jobs"
    return Path.home() / ".super-agent" / "media" / "outbound" / "video-jobs"


def build_workspace_dir(job_id: str) -> Path:
    """
    为指定 job_id 创建工作目录及子目录。

    返回工作目录的 Path 对象。
    幂等：重复调用同一 job_id 不报错。
    """
    workspace = _media_root() / job_id

    # 创建主目录 + 子目录
    for subdir in _SUBDIRS:
        (workspace / subdir).mkdir(parents=True, exist_ok=True)

    logger.debug(f"工作区创建完成: {workspace}")
    return workspace


def get_workspace_dir(job_id: str) -> Path:
    """
    获取已有工作目录（不创建）。
    用于查询/读取场景。
    """
    return _media_root() / job_id


def get_final_output_path(job_id: str) -> Path:
    """最终产物路径：{workspace}/final.mp4"""
    return get_workspace_dir(job_id) / "final.mp4"


def estimate_cost(
    workflow: str,
    scenes: int,
    pricing_table: dict[str, float],
) -> float:
    """
    估算单个 VideoJob 的 RunningHub 成本。

    公式（Spec §4.5 闸门 1）：
      cost_estimate_cny = scenes × workflow_unit_price[workflow_id]

    Args:
        workflow: 工作流标识（如 runninghub/video_wan2.1_fusionx.json）
        scenes: 场景数（默认 6）
        pricing_table: 从 config.yaml pricing 段加载的单价字典

    Returns:
        预估成本（CNY）
    """
    default_price = pricing_table.get("_default", 1.0)
    unit_price = pricing_table.get(workflow, default_price)
    cost = scenes * unit_price
    logger.debug(
        f"成本估算: workflow={workflow}, scenes={scenes}, "
        f"unit_price={unit_price}, total={cost:.2f} CNY"
    )
    return cost
