"""
媒体生成路由 — /forge/image, /forge/video, /forge/tts

接口契约（Spec §4.1）：
  POST /forge/image          → 同步返回 {url, media_type, duration}
  POST /forge/video          → 异步 Job {job_id, status:"queued"}
  GET  /forge/video/jobs/:id → 轮询 {status, progress, output?, error?}
  POST /forge/tts            → 同步返回 {audio_path, duration}
"""

import asyncio
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from loguru import logger

router = APIRouter(tags=["media"])


# ==================== 内存 Job 存储 ====================

# 简单的内存字典，Phase 1 足够（无需持久化）
_video_jobs: dict[str, dict[str, Any]] = {}


# ==================== 请求/响应模型 ====================

class ImageRequest(BaseModel):
    """图片生成请求。"""
    prompt: str = Field(..., min_length=1, description="图片描述")
    workflow: str | None = Field(None, description="工作流文件路径")
    width: int | None = Field(None, ge=256, le=2048)
    height: int | None = Field(None, ge=256, le=2048)


class VideoRequest(BaseModel):
    """视频生成请求（异步 Job 模式）。"""
    prompt: str = Field(..., min_length=1, description="视频主题描述")
    workflow: str | None = Field(None, description="工作流文件路径")
    duration: float | None = Field(None, ge=1, le=120)
    width: int | None = Field(None, ge=256, le=2048)
    height: int | None = Field(None, ge=256, le=2048)


class TTSRequest(BaseModel):
    """TTS 请求。"""
    text: str = Field(..., min_length=1, description="待转语音文本")
    voice: str | None = Field(None, description="发音人标识")
    speed: float | None = Field(None, ge=0.5, le=3.0, description="语速倍率")
    inference_mode: str | None = Field(None, description="推理模式: local / comfyui")
    output_path: str | None = Field(None, description="输出路径（自动生成如省略）")


# ==================== 路由 ====================

# RunningHub 审核失败的关键词集合（大小写不敏感匹配）
# 来源：runninghub 平台 errorCode=805 / exception_type=audit.RHAuditException
# 命中其一即判定为审核失败 → 返回 422 让上游重写 prompt，而不是盲目 retry
_AUDIT_KEYWORDS = (
    "rhauditexception",
    "audit.rhaudit",
    "porn",
    "\u8272\u60c5",           # 色情
    "\u8c29\u9a82",           # 谩骂
    "\u6050\u6016\u4e3b\u4e49",  # 恐怖主义
    "\u4ee4\u4eba\u53cd\u611f",  # 令人反感
    "\u4e0d\u5b89\u5168\u6216\u4e0d\u9002\u5b9c",  # 不安全或不适宜
    "runninghub\u5e73\u53f0\u7981\u6b62",  # RunningHub平台禁止
    "errorcode: 805",
    "errorcode=805",
    "errorcode\":\"805\"",
    "errorcode\": \"805\"",
)


def _is_audit_error(msg: str) -> bool:
    """判断错误信息是否为 RunningHub 内容审核失败。"""
    if not msg:
        return False
    lower = msg.lower()
    return any(kw in lower for kw in _AUDIT_KEYWORDS)


@router.post("/image")
async def forge_image(req: ImageRequest, request: Request):
    """生成图片（同步，典型 3-30s）。"""
    core = request.app.state.core
    if not core or not core.media:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    try:
        result = await core.media(
            prompt=req.prompt,
            workflow=req.workflow,
            media_type="image",
            width=req.width or 1024,
            height=req.height or 1024,
        )
        return {
            "url": result.url,
            "media_type": result.media_type,
            "duration": result.duration,
            "is_image": result.is_image,
            "local_path": result.local_path,
        }
    except Exception as e:
        err_msg = str(e)
        logger.error(f"forge_image error: {err_msg}")
        # 审核失败：返回 422 + 顶层 code 字段（core forgeRequest 直接解析 parsed.code）
        if _is_audit_error(err_msg):
            return JSONResponse(
                status_code=422,
                content={
                    "code": "AUDIT_REJECTED",
                    "detail": (
                        "RunningHub \u5185\u5bb9\u5ba1\u6838\u62d2\u7edd\uff1a"
                        "prompt \u53ef\u80fd\u5305\u542b\u88ab\u8bef\u5224\u4e3a\u654f\u611f\u7684\u63cf\u8ff0"
                        "\uff08\u5982\u8eab\u4f53\u8fd1\u666f/\u88f8\u8db3/\u76ae\u80a4\u7eb9\u7406/\u8863\u7269\u51cc\u4e71\u7b49\uff09"
                        f"\u3002\u539f\u59cb\u9519\u8bef\uff1a{err_msg}"
                    ),
                    "raw": err_msg,
                },
            )
        raise HTTPException(status_code=500, detail=err_msg)


@router.post("/video")
async def forge_video(req: VideoRequest, request: Request):
    """创建异步视频生成任务（返回 job_id，后台执行）。"""
    core = request.app.state.core
    if not core or not core.media:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    job_id = f"vj_{uuid.uuid4().hex[:12]}"
    _video_jobs[job_id] = {
        "status": "queued",
        "progress": 0.0,
        "output": None,
        "error": None,
        "created_at": datetime.now().isoformat(),
    }

    # 后台任务
    asyncio.create_task(_run_video_job(core, job_id, req))
    return {"job_id": job_id, "status": "queued"}


@router.get("/video/jobs/{job_id}")
async def forge_video_status(job_id: str):
    """轮询异步视频任务状态。"""
    job = _video_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "output": job["output"],
        "error": job["error"],
    }


@router.post("/tts")
async def forge_tts(req: TTSRequest, request: Request):
    """文本转语音（同步，典型 2-10s）。"""
    core = request.app.state.core
    if not core or not core.tts:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    try:
        audio_path = await core.tts(
            text=req.text,
            voice=req.voice,
            speed=req.speed,
            inference_mode=req.inference_mode,
            output_path=req.output_path,
        )
        # 尝试获取时长
        duration = 0.0
        try:
            from app.utils.tts_util import get_audio_duration
            duration = await get_audio_duration(audio_path)
        except Exception:
            pass

        return {
            "audio_path": audio_path,
            "duration": duration,
        }
    except Exception as e:
        logger.error(f"forge_tts error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== 后台任务 ====================

async def _run_video_job(core, job_id: str, req: VideoRequest) -> None:
    """后台执行视频生成任务。"""
    job = _video_jobs[job_id]
    try:
        job["status"] = "running"
        job["progress"] = 0.1

        # 修复：若调用方未显式传 workflow，按 media_type=video 回填视频默认工作流，
        # 避免 MediaService service_name="image" 导致误用图片默认（预先存在问题）。
        workflow = req.workflow or getattr(
            core.media, "video_default_workflow", None
        )

        result = await core.media(
            prompt=req.prompt,
            workflow=workflow,
            media_type="video",
            width=req.width or 1280,
            height=req.height or 720,
            duration=req.duration,
        )
        job["status"] = "completed"
        job["progress"] = 1.0
        job["output"] = {
            "url": result.url,
            "media_type": result.media_type,
            "duration": result.duration,
            "local_path": result.local_path,
        }
    except Exception as e:
        logger.error(f"Video job {job_id} failed: {e}")
        job["status"] = "failed"
        job["error"] = str(e)
