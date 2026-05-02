"""
合成路由 — /forge/compose-frame, /forge/concat, /forge/add-bgm

接口契约（Spec §4.1）：
  POST /forge/compose-frame  → 同步 {video_segment_path, duration}
  POST /forge/concat         → 同步 {output_path}
  POST /forge/add-bgm        → 同步 {output_path}
"""

import os
import shutil
import traceback
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from loguru import logger

from app.utils.os_util import get_output_path

router = APIRouter(tags=["compose"])


class ComposeFrameRequest(BaseModel):
    """帧合成请求。"""
    image_path: str = Field(..., description="帧图片路径")
    audio_path: str = Field(..., description="帧音频路径")
    output_path: str | None = Field(None, description="输出路径（自动生成如省略）")
    fps: int = Field(30, ge=1, le=120, description="帧率")


class ConcatRequest(BaseModel):
    """视频拼接请求。"""
    segments: list[str] = Field(..., min_length=1, description="待拼接的视频段路径列表")
    output: str | None = Field(None, description="输出路径")
    method: str = Field("demuxer", description="拼接方式: demuxer / filter")
    bgm_path: str | None = Field(None, description="BGM 路径（可选）")
    bgm_volume: float = Field(0.2, ge=0.0, le=1.0)


class AddBgmRequest(BaseModel):
    """BGM 叠加请求。"""
    video_path: str = Field(..., description="视频文件路径")
    bgm_path: str = Field(..., description="BGM 文件路径")
    output: str | None = Field(None, description="输出路径")
    volume: float = Field(0.3, ge=0.0, le=1.0, description="BGM 音量")
    loop: bool = Field(True, description="是否循环 BGM")


@router.post("/compose-frame")
async def forge_compose_frame(req: ComposeFrameRequest, request: Request):
    """帧合成 — 图片 + 音频 → 单帧视频段（静态图 + 旁白音频）。"""
    core = request.app.state.core
    if not core or not core.video:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    try:
        output = req.output_path or get_output_path(f"compose_{uuid.uuid4().hex[:8]}.mp4")
        # 诊断：记录输入文件存在性 + ffmpeg/ffprobe 可执行文件探测 + PATH
        logger.info(
            f"[compose-frame] image={req.image_path} "
            f"exists={os.path.exists(req.image_path)} | "
            f"audio={req.audio_path} exists={os.path.exists(req.audio_path)} | "
            f"ffmpeg={shutil.which('ffmpeg')} | ffprobe={shutil.which('ffprobe')}"
        )
        segment_path = core.video.create_video_from_image(
            image=req.image_path,
            audio=req.audio_path,
            output=output,
            fps=req.fps,
        )
        return {"video_segment_path": segment_path}
    except Exception as e:
        # 诊断：WinError 2 无 traceback 无法定位具体哪一次 spawn 失败，这里强制打印完整调用栈
        tb = traceback.format_exc()
        logger.error(
            f"forge_compose_frame error: {e}\n"
            f"  ffmpeg_in_path={shutil.which('ffmpeg')}\n"
            f"  ffprobe_in_path={shutil.which('ffprobe')}\n"
            f"  PATH(head)={(os.environ.get('PATH') or '')[:500]}\n"
            f"  traceback:\n{tb}"
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/concat")
async def forge_concat(req: ConcatRequest, request: Request):
    """视频拼接 — 多段 → 一个视频。"""
    core = request.app.state.core
    if not core or not core.video:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    try:
        output = req.output or get_output_path(f"concat_{uuid.uuid4().hex[:8]}.mp4")
        result_path = core.video.concat_videos(
            videos=req.segments,
            output=output,
            method=req.method,
            bgm_path=req.bgm_path,
            bgm_volume=req.bgm_volume,
        )
        return {"output_path": result_path}
    except Exception as e:
        logger.error(f"forge_concat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/add-bgm")
async def forge_add_bgm(req: AddBgmRequest, request: Request):
    """BGM 叠加 — 视频 + 背景音乐。"""
    core = request.app.state.core
    if not core or not core.video:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    try:
        output = req.output or get_output_path(f"bgm_{uuid.uuid4().hex[:8]}.mp4")
        result_path = core.video.add_bgm(
            video=req.video_path,
            bgm=req.bgm_path,
            output=output,
            bgm_volume=req.volume,
            loop=req.loop,
        )
        return {"output_path": result_path}
    except Exception as e:
        logger.error(f"forge_add_bgm error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
