"""
OS 工具函数 — video-forge 简化版。

将 Pixelle 的 os_util.py 简化为 video-forge 微服务的固定目录结构。
资源搜索策略：先查 data/ 自定义目录，再查项目根目录下的默认目录。
"""

import os
from pathlib import Path
from typing import Literal


def get_video_forge_root() -> str:
    """获取 video-forge 项目根目录（main.py 所在目录）。"""
    # VIDEO_FORGE_ROOT 环境变量优先，否则使用当前工作目录
    env_root = os.environ.get("VIDEO_FORGE_ROOT")
    if env_root and Path(env_root).exists():
        return str(Path(env_root).resolve())
    return str(Path.cwd())


def get_root_path(*paths: str) -> str:
    """获取相对于项目根目录的路径。"""
    root = get_video_forge_root()
    return os.path.join(root, *paths) if paths else root


def get_data_path(*paths: str) -> str:
    """获取 data/ 目录下的路径（自定义资源优先级更高）。"""
    data_path = get_root_path("data")
    os.makedirs(data_path, exist_ok=True)
    return os.path.join(data_path, *paths) if paths else data_path


def get_output_path(*paths: str) -> str:
    """获取 output/ 目录下的路径。"""
    output_path = get_root_path("output")
    os.makedirs(output_path, exist_ok=True)
    return os.path.join(output_path, *paths) if paths else output_path


def get_temp_path(*paths: str) -> str:
    """获取 temp/ 目录下的路径。"""
    temp_path = get_root_path("temp")
    os.makedirs(temp_path, exist_ok=True)
    return os.path.join(temp_path, *paths) if paths else temp_path


def get_resource_path(
    resource_type: Literal["bgm", "templates", "workflows"],
    *paths: str,
) -> str:
    """
    获取资源文件路径，支持自定义覆盖。

    搜索优先级：data/{resource_type}/*paths > {resource_type}/*paths
    """
    custom_path = get_data_path(resource_type, *paths)
    default_path = get_root_path(resource_type, *paths)

    if os.path.exists(custom_path):
        return custom_path
    if os.path.exists(default_path):
        return default_path

    raise FileNotFoundError(
        f"资源未找到: {os.path.join(resource_type, *paths)}\n"
        f"  已搜索: {custom_path} (自定义) / {default_path} (默认)"
    )


def list_resource_files(
    resource_type: Literal["bgm", "templates", "workflows"],
    subdir: str = "",
) -> list[str]:
    """列出资源目录下的文件（合并 default + custom，custom 优先覆盖同名）。"""
    files: dict[str, str] = {}

    default_dir = Path(get_root_path(resource_type, subdir)) if subdir else Path(get_root_path(resource_type))
    custom_dir = Path(get_data_path(resource_type, subdir)) if subdir else Path(get_data_path(resource_type))

    for d in (default_dir, custom_dir):
        if d.exists() and d.is_dir():
            for item in d.iterdir():
                if item.is_file():
                    files[item.name] = str(item)

    return sorted(files.keys())


def list_resource_dirs(
    resource_type: Literal["bgm", "templates", "workflows"],
) -> list[str]:
    """列出资源目录下的子目录名（合并 default + custom）。"""
    dirs: set[str] = set()

    default_dir = Path(get_root_path(resource_type))
    custom_dir = Path(get_data_path(resource_type))

    for d in (default_dir, custom_dir):
        if d.exists() and d.is_dir():
            for item in d.iterdir():
                if item.is_dir():
                    dirs.add(item.name)

    return sorted(dirs)


def resource_exists(
    resource_type: Literal["bgm", "templates", "workflows"],
    *paths: str,
) -> bool:
    """检查资源文件是否存在。"""
    custom_path = get_data_path(resource_type, *paths)
    default_path = get_root_path(resource_type, *paths)
    return os.path.exists(custom_path) or os.path.exists(default_path)


def get_task_path(task_id: str, *paths: str) -> str:
    """
    获取任务目录下的路径。

    Args:
        task_id: 任务 ID（由 super-agent 下发）
        *paths: 子路径

    Returns:
        绝对路径 output/{task_id}/[*paths]
    """
    task_dir = get_output_path(task_id)
    if paths:
        return os.path.join(task_dir, *paths)
    return task_dir


def get_task_frame_path(
    task_id: str,
    frame_index: int,
    file_type: Literal["audio", "image", "video", "composed", "segment"],
) -> str:
    """
    获取帧文件路径：output/{task_id}/frames/{01}_{file_type}.{ext}

    Args:
        task_id: 任务 ID
        frame_index: 帧索引（0-based，文件名从 01 开始）
        file_type: 文件类型

    Returns:
        绝对路径
    """
    ext_map = {
        "audio": "mp3",
        "image": "png",
        "video": "mp4",
        "composed": "png",
        "segment": "mp4",
    }
    filename = f"{frame_index + 1:02d}_{file_type}.{ext_map[file_type]}"
    frame_dir = get_task_path(task_id, "frames")
    os.makedirs(frame_dir, exist_ok=True)
    return os.path.join(frame_dir, filename)
