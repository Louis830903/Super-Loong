"""
GET /health — 健康检查端点。

供 super-agent 侧 video-forge-supervisor.ts 每 10 秒轮询。
返回体：{ status: "ok", comfykit_ready: bool }
超出 3 次失败则 supervisor 标记不可用。
"""

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check(request: Request):
    """
    返回服务健康状态。

    comfykit_ready 表示 ComfyKit 单例是否已懒初始化完成。
    """
    core = getattr(request.app.state, "core", None)
    comfykit_ready = core.comfykit_ready if core else False

    return {
        "status": "ok",
        "comfykit_ready": comfykit_ready,
    }
