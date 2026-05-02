"""
图片/视频生成适配器 — 从 Pixelle services/media.py 迁移。

通过 ComfyKit 执行 image_/video_ 工作流，自动检测输出类型。
导入路径已从 pixelle_video.* 替换为 app.core / app.models。
"""

import os
import ssl
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import aiohttp
import certifi
from comfykit import ComfyKit
from loguru import logger

from app.core.comfy_base_service import ComfyBaseService
from app.core.runninghub_standard_client import (
    RunningHubStandardClient,
    classify_results,
)
from app.models.media import MediaResult
from app.utils.os_util import (
    get_output_path,
    list_resource_dirs,
    list_resource_files,
    get_resource_path,
)


class MediaService(ComfyBaseService):
    """
    媒体生成服务 — 支持 image_ 和 video_ 工作流。

    通过 ComfyKit 执行 RunningHub / selfhost 工作流，返回 MediaResult。
    """

    WORKFLOW_PREFIX = ""  # _scan_workflows 会同时匹配 image_ 和 video_
    DEFAULT_WORKFLOW = None
    WORKFLOWS_DIR = "workflows"

    def __init__(self, config: dict, core=None):
        super().__init__(config, service_name="image", core=core)

    # ------------------------------------------------------------------
    # 默认工作流访问器（修复：MediaService 只认 image 段的预先存在问题）
    # ------------------------------------------------------------------
    # service_name 固定为 "image"，导致 self.config 只拿到 comfyui.image 段，
    # 视频调用方若不显式传 workflow，会错误地回退到图片默认工作流。
    # 这里额外暴露 video/image 两段的默认工作流，供路由层按 media_type 回填。

    @property
    def image_default_workflow(self) -> Optional[str]:
        """comfyui.image.default_workflow（文生图默认工作流 key）。"""
        return (self.global_config.get("image") or {}).get("default_workflow")

    @property
    def video_default_workflow(self) -> Optional[str]:
        """comfyui.video.default_workflow（视频默认工作流 key）。"""
        return (self.global_config.get("video") or {}).get("default_workflow")

    def _scan_workflows(self):
        """扫描 image_ 和 video_ 前缀的工作流（覆盖父类单前缀逻辑）。"""
        workflows = []
        source_dirs = list_resource_dirs("workflows")
        if not source_dirs:
            logger.warning("未找到工作流源目录")
            return workflows

        for source_name in source_dirs:
            workflow_files = list_resource_files("workflows", source_name)
            matching_files = [
                f for f in workflow_files
                if (f.startswith("image_") or f.startswith("video_")) and f.endswith(".json")
            ]
            for filename in matching_files:
                try:
                    file_path = Path(get_resource_path("workflows", source_name, filename))
                    workflow_info = self._parse_workflow_file(file_path, source_name)
                    workflows.append(workflow_info)
                    logger.debug(f"发现工作流: {workflow_info['key']}")
                except Exception as e:
                    logger.error(f"解析工作流 {source_name}/{filename} 失败: {e}")

        return sorted(workflows, key=lambda w: w["key"])

    async def __call__(
        self,
        prompt: str,
        workflow: Optional[str] = None,
        media_type: str = "image",
        comfyui_url: Optional[str] = None,
        runninghub_api_key: Optional[str] = None,
        width: Optional[int] = None,
        height: Optional[int] = None,
        duration: Optional[float] = None,
        negative_prompt: Optional[str] = None,
        steps: Optional[int] = None,
        seed: Optional[int] = None,
        cfg: Optional[float] = None,
        sampler: Optional[str] = None,
        **params,
    ) -> MediaResult:
        """
        生成图片或视频。

        Args:
            prompt: 生成提示词
            media_type: "image" 或 "video"
            workflow: 工作流 key（默认走配置）
            其余参数透传给工作流
        """
        workflow_info = self._resolve_workflow(workflow=workflow)

        workflow_params = {"prompt": prompt}
        if width is not None:
            workflow_params["width"] = width
        if height is not None:
            workflow_params["height"] = height
        if duration is not None:
            workflow_params["duration"] = duration
            if media_type == "video":
                logger.info(f"📏 目标视频时长: {duration:.2f}s")
        if negative_prompt is not None:
            workflow_params["negative_prompt"] = negative_prompt
        if steps is not None:
            workflow_params["steps"] = steps
        if seed is not None:
            workflow_params["seed"] = seed
        if cfg is not None:
            workflow_params["cfg"] = cfg
        if sampler is not None:
            workflow_params["sampler"] = sampler
        workflow_params.update(params)

        logger.debug(f"工作流参数: {workflow_params}")

        try:
            # T1.4（新增）：RunningHub 标准模型 API 模式分支
            # 通过 workflow JSON 的 mode 字段识别，走独立 Bearer REST 客户端，
            # 与 comfykit 路径互不干扰，保留旧工作流可用。
            if workflow_info.get("mode") == "standard_api":
                return await self._run_standard_api(
                    prompt=prompt,
                    workflow_info=workflow_info,
                    workflow_params=workflow_params,
                    media_type=media_type,
                    runninghub_api_key=runninghub_api_key,
                )

            # 通过 MiniCore 获取共享 ComfyKit 实例（T1.2b 接线）
            kit = await self.core._get_or_create_comfykit()

            if workflow_info["source"] == "runninghub" and "workflow_id" in workflow_info:
                workflow_input = workflow_info["workflow_id"]
                logger.info(f"执行 RunningHub 工作流: {workflow_input}")
            else:
                workflow_input = workflow_info["path"]
                logger.info(f"执行 selfhost 工作流: {workflow_input}")

            result = await kit.execute(workflow_input, workflow_params)

            if result.status != "completed":
                error_msg = result.msg or "未知错误"
                logger.error(f"媒体生成失败: {error_msg}")
                raise Exception(f"媒体生成失败: {error_msg}")

            if media_type == "video":
                if not result.videos:
                    raise Exception("未生成视频")
                video_url = result.videos[0]
                logger.info(f"✅ 生成视频: {video_url}")
                dur = getattr(result, "duration", None)
                return MediaResult(media_type="video", url=video_url, duration=dur)
            else:
                if not result.images:
                    raise Exception("未生成图片")
                image_url = result.images[0]
                logger.info(f"✅ 生成图片: {image_url}")
                return MediaResult(media_type="image", url=image_url)

        except Exception as e:
            logger.error(f"媒体生成错误: {e}")
            raise

    # ------------------------------------------------------------------
    # T1.4：RunningHub 标准模型 API 执行路径
    # ------------------------------------------------------------------

    async def _run_standard_api(
        self,
        prompt: str,
        workflow_info: Dict[str, Any],
        workflow_params: Dict[str, Any],
        media_type: str,
        runninghub_api_key: Optional[str] = None,
    ) -> MediaResult:
        """
        执行 RunningHub 标准模型 API（/openapi/v2/<endpoint>，Bearer 鉴权）。

        流程：
        1) 按 workflow_info.defaults + param_map 组装请求体（param_map 把
           上游 snake_case 参数名映射到 API 字段名）。
        2) 若 workflow 声明 requires_image_input 且当前缺 imageUrl，
           自动先跑 image_source_workflow 生成底图并回填（图→视频串联，
           对 t5 Agent 透明）。
        3) 调 RunningHubStandardClient.run 提交+轮询+拿 results。
        4) 按 output_media 从 classify_results 结果桶里取首个 URL。
        """
        endpoint = workflow_info.get("endpoint")
        if not endpoint:
            raise ValueError(
                f"standard_api 工作流缺 endpoint: {workflow_info.get('key')}"
            )

        # 1) 组装请求体：defaults 兜底，workflow_params 经 param_map 覆盖
        body: Dict[str, Any] = dict(workflow_info.get("defaults", {}) or {})
        param_map: Dict[str, str] = workflow_info.get("param_map", {}) or {}
        for src_key, api_key in param_map.items():
            if src_key in workflow_params and workflow_params[src_key] is not None:
                v = workflow_params[src_key]
                # wan-2.5-preview duration 字段文档要求字符串（"5"/"10"）
                if api_key == "duration" and not isinstance(v, str):
                    try:
                        v = str(int(float(v)))
                    except (TypeError, ValueError):
                        v = str(v)
                body[api_key] = v

        # 2) 图→视频串联：声明 requires_image_input 且 body 缺 imageUrl
        if workflow_info.get("requires_image_input") and not body.get("imageUrl"):
            source_wf = workflow_info.get("image_source_workflow")
            if not source_wf:
                raise ValueError(
                    f"视频工作流 {workflow_info.get('key')} 声明 requires_image_input "
                    f"但未配置 image_source_workflow"
                )
            logger.info(f"🔗 图→视频串联：先跑 {source_wf} 生成底图")
            image_result = await self(
                prompt=prompt,
                workflow=source_wf,
                media_type="image",
                runninghub_api_key=runninghub_api_key,
            )
            if not image_result or not image_result.url:
                raise Exception("串联图片生成失败，无法继续视频合成")
            body["imageUrl"] = image_result.url
            logger.info(f"🔗 串联底图就绪: {image_result.url}")

        # 3) 提交 + 轮询
        api_key = (
            runninghub_api_key
            or self.global_config.get("runninghub_api_key")
            or os.getenv("RUNNINGHUB_API_KEY")
        )
        client = RunningHubStandardClient(api_key=api_key)
        try:
            logger.info(
                f"🚀 调用标准 API: {endpoint}  body_keys={list(body.keys())}"
            )
            results = await client.run(endpoint, body)
        finally:
            await client.close()

        # 4) 按 output_media 抽取目标 URL + outputType（用于精确推导落盘后缀）
        output_media = workflow_info.get("output_media") or media_type or "image"
        target_item = self._pick_result(results, output_media)
        if target_item is None:
            raise Exception(
                f"标准 API 未返回 {output_media} 结果, results={results}"
            )
        remote_url: str = target_item.get("url") or ""
        out_type_hint: str = (target_item.get("outputType") or "").lower()

        # 5) 自动落盘到 output/standard_api/<YYYYMMDD>/<HHMMSS>_<shortid>.<ext>
        #    下载失败仅记错误，不让整个任务失败（远程 URL 仍可用）
        local_path: Optional[str] = None
        try:
            local = await self._download_to_output(
                remote_url, output_media, out_type_hint
            )
            local_path = str(local)
            logger.info(f"💾 已落盘: {local_path}")
        except Exception as e:
            logger.error(f"❌ 本地落盘失败（远程 URL 仍可用）: {e}")

        if output_media == "video":
            logger.info(f"✅ 生成视频: {remote_url}")
            # duration 从请求体取（API 响应未必回传）
            dur: Optional[float] = None
            dur_val = body.get("duration")
            if dur_val is not None:
                try:
                    dur = float(dur_val)
                except (TypeError, ValueError):
                    dur = None
            return MediaResult(
                media_type="video",
                url=remote_url,
                duration=dur,
                local_path=local_path,
            )

        logger.info(f"✅ 生成图片: {remote_url}")
        return MediaResult(
            media_type="image",
            url=remote_url,
            local_path=local_path,
        )

    # ------------------------------------------------------------------
    # T1.4 内部工具：结果选取 + 自动落盘
    # ------------------------------------------------------------------

    @staticmethod
    def _pick_result(
        results: list, output_media: str
    ) -> Optional[Dict[str, Any]]:
        """
        按 output_media 从 results 里挑首个匹配项（保留 outputType 信息用于落盘）。

        优先精确匹配 outputType 后缀；找不到再退回 classify_results 分桶结果。
        """
        image_exts = {"png", "jpg", "jpeg", "gif", "webp"}
        video_exts = {"mp4", "avi", "mov", "mkv", "webm"}
        want = video_exts if output_media == "video" else image_exts

        for item in results or []:
            if not isinstance(item, dict):
                continue
            out_type = (item.get("outputType") or "").lower()
            url = item.get("url")
            if url and out_type in want:
                return item

        # fallback：靠分桶兜底（outputType 不规范时）
        buckets = classify_results(results or [])
        urls_bucket = buckets["videos"] if output_media == "video" else buckets["images"]
        if urls_bucket:
            return {"url": urls_bucket[0], "outputType": ""}
        return None

    async def _download_to_output(
        self,
        url: str,
        media_type: str,
        output_type_hint: str = "",
    ) -> Path:
        """
        把远程 URL 下载到 output/standard_api/<YYYYMMDD>/<HHMMSS>_<shortid>.<ext>。

        后缀推导：outputType → URL 路径后缀 → 按 media_type 兜底（mp4/png）。
        """
        if not url:
            raise ValueError("下载 URL 为空")

        # 1) 推导后缀
        ext = ""
        if output_type_hint:
            ext = "." + output_type_hint.lstrip(".").lower()
        if not ext:
            url_ext = Path(urlparse(url).path).suffix
            if url_ext:
                ext = url_ext.lower()
        if not ext:
            ext = ".mp4" if media_type == "video" else ".png"

        # 2) 目标路径（按日期分桶，避免 output/ 扁平爆炸）
        now = datetime.now()
        date_dir = now.strftime("%Y%m%d")
        filename = f"{now.strftime('%H%M%S')}_{uuid.uuid4().hex[:8]}{ext}"
        target_dir = Path(get_output_path("standard_api", date_dir))
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / filename

        # 3) 流式下载（certifi SSL，Windows 兼容；大视频走 65KB chunk）
        ssl_ctx = ssl.create_default_context(cafile=certifi.where())
        connector = aiohttp.TCPConnector(ssl=ssl_ctx)
        timeout = aiohttp.ClientTimeout(total=300)
        async with aiohttp.ClientSession(
            connector=connector, timeout=timeout, trust_env=True
        ) as sess:
            async with sess.get(url) as resp:
                if resp.status != 200:
                    raise Exception(f"下载失败 HTTP {resp.status}: {url}")
                with open(target_path, "wb") as f:
                    async for chunk in resp.content.iter_chunked(65536):
                        f.write(chunk)

        return target_path
