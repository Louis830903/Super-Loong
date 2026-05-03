"""
POST /admin/reload-config — 运行时热更新配置端点。

供 super-agent 侧 Node.js 在用户通过 Web UI 修改 API Key 后调用，
实现无需重启 Python 子进程即可生效的热更新机制。

设计要点：
  - 接收 { "runninghub_api_key": "..." } 更新 ConfigStore 中的值
  - 同步设置 os.environ["RUNNINGHUB_API_KEY"] 供 _prepare_comfykit_config() 等读取
  - 强制重置 ComfyKit 缓存，下次请求时自动重建（带新 Key）
  - 不修改 config.yaml 文件（避免覆盖其他手动配置）
"""

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from loguru import logger

router = APIRouter(tags=["admin"])


class ReloadConfigRequest(BaseModel):
    """热更新配置请求体。

    当前仅支持 runninghub_api_key 一个字段，
    后续可扩展其他配置项（如 comfyui_url 等）。
    """
    runninghub_api_key: str | None = Field(
        None,
        min_length=1,
        description="RunningHub API Key（空字符串=清除 Key）",
    )


@router.post("/admin/reload-config")
async def reload_config(body: ReloadConfigRequest, request: Request) -> dict[str, Any]:
    """
    热更新 RunningHub API Key，无需重启 Python 子进程。

    调用时机：用户在 Web UI「设置 → 服务配置 → RunningHub AI」页面
    修改 API Key 并保存后，Node.js 侧通过此端点通知 Python 服务。

    流程：
      1. 将新 Key 写入 app.state.core.config（内存配置，后续请求即时感知）
      2. 更新 os.environ["RUNNINGHUB_API_KEY"]（供 _prepare_comfykit_config() 等回退）
      3. 重置 ComfyKit 单例缓存（下次请求自动用新 Key 重建）
    """
    core = getattr(request.app.state, "core", None)
    if core is None:
        raise HTTPException(status_code=503, detail="MiniCore 未初始化，请稍后重试")

    new_key = body.runninghub_api_key

    # Step 1: 更新内存配置
    comfyui_cfg: dict = core.config.setdefault("comfyui", {})
    old_key = comfyui_cfg.get("runninghub_api_key", "")
    comfyui_cfg["runninghub_api_key"] = new_key or ""

    # 打印更新日志时脱敏处理（只显示前后各4位）
    def _mask_key(key: str) -> str:
        if not key:
            return "(空)"
        if len(key) <= 8:
            return "*" * len(key)
        return key[:4] + "****" + key[-4:]

    logger.info(
        f"RunningHub API Key 热更新: {_mask_key(old_key)} → {_mask_key(new_key or '')}"
    )

    # Step 2: 同步到 os.environ（供 comfy_base_service._prepare_comfykit_config() 等回退读取）
    if new_key:
        os.environ["RUNNINGHUB_API_KEY"] = new_key
    else:
        # 清除 Key 时也要清理环境变量
        os.environ.pop("RUNNINGHUB_API_KEY", None)

    # Step 3: 强制重置 ComfyKit 缓存（下次请求自动重建，带新 Key）
    await core.reset_comfykit()

    return {
        "status": "ok",
        "message": "RunningHub API Key 已热更新，ComfyKit 缓存已重置",
        "runninghub_api_key": _mask_key(new_key or ""),
    }
