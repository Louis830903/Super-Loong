"""
分析路由 — /forge/analyse-image

接口契约（Spec §4.1）：
  POST /forge/analyse-image → 同步 {description, tags}

注意：ImageAnalysisService 尚未完整迁移（T1.4+ 补齐），
当前路由通过 core._get_or_create_comfykit() 直接调用分析工作流。
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from loguru import logger

router = APIRouter(tags=["analysis"])


class AnalyseImageRequest(BaseModel):
    """图片分析请求。"""
    image_path: str = Field(..., description="待分析图片路径或 URL")
    workflow: str | None = Field(None, description="分析工作流")


@router.post("/analyse-image")
async def forge_analyse_image(req: AnalyseImageRequest, request: Request):
    """图片分析 — 通过 ComfyUI 工作流返回结构化描述。"""
    core = request.app.state.core
    if not core:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化")

    try:
        kit = await core._get_or_create_comfykit()
        workflow_input = req.workflow or "runninghub/analyse_image.json"

        result = await kit.execute(workflow_input, {"image": req.image_path})

        if result.status != "completed":
            raise Exception(f"分析失败: {result.msg or 'Unknown'}")

        # 从 result 提取文本描述
        description = None
        if hasattr(result, "texts") and result.texts:
            description = result.texts[0]
        elif hasattr(result, "outputs") and result.outputs:
            for key, value in result.outputs.items():
                if isinstance(value, str):
                    description = value
                    break

        return {
            "description": description or "",
            "raw_outputs": getattr(result, "outputs", {}),
        }
    except Exception as e:
        logger.error(f"forge_analyse_image error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
