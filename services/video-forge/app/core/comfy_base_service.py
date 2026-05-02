"""
ComfyUI 基础服务 — 从 Pixelle services/comfy_base_service.py 迁移。

提供工作流扫描、解析、解析等通用功能，MediaService / TTSService 继承此类。
导入路径已从 pixelle_video.* 替换为 app.utils.os_util。
"""

import json
import os
from pathlib import Path
from typing import Optional, List, Dict, Any

from comfykit import ComfyKit
from loguru import logger

from app.utils.os_util import (
    get_resource_path,
    list_resource_files,
    list_resource_dirs,
)


class ComfyBaseService:
    """
    ComfyUI 工作流服务基类。

    子类需定义：
    - WORKFLOW_PREFIX: 工作流文件前缀（如 "image_"、"tts_"）
    - DEFAULT_WORKFLOW: 默认工作流文件名
    - WORKFLOWS_DIR: 工作流目录名（默认 "workflows"）
    """

    WORKFLOW_PREFIX: str = ""
    DEFAULT_WORKFLOW: str = ""
    WORKFLOWS_DIR: str = "workflows"

    def __init__(self, config: dict, service_name: str, core=None):
        """
        Args:
            config: 完整应用配置 dict
            service_name: 配置中的服务名（如 "tts"、"image"）
            core: MiniCore 实例（用于获取共享 ComfyKit）
        """
        comfyui_config = config.get("comfyui", {})
        self.config = comfyui_config.get(service_name, {})
        self.global_config = comfyui_config
        self.service_name = service_name
        self._workflows_cache: Optional[List[str]] = None
        self.core = core

    def _scan_workflows(self) -> List[Dict[str, Any]]:
        """扫描 workflows/{source}/*.json 文件。"""
        workflows = []
        source_dirs = list_resource_dirs("workflows")
        if not source_dirs:
            logger.warning("未找到工作流源目录")
            return workflows

        for source_name in source_dirs:
            workflow_files = list_resource_files("workflows", source_name)
            matching_files = [
                f for f in workflow_files
                if f.startswith(self.WORKFLOW_PREFIX) and f.endswith(".json")
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

    def _parse_workflow_file(self, file_path: Path, source: str) -> Dict[str, Any]:
        """解析工作流 JSON 文件，提取元数据。"""
        with open(file_path, "r", encoding="utf-8") as f:
            content = json.load(f)

        workflow_info = {
            "name": file_path.name,
            "display_name": f"{file_path.name} - {source.title()}",
            "source": source,
            "path": str(file_path),
            "key": f"{source}/{file_path.name}",
        }

        if "source" in content and "workflow_id" in content:
            workflow_info["workflow_id"] = content["workflow_id"]

        # T1.4（新增）：识别 RunningHub 标准 API 模式字段
        # standard_api 模式通过 Bearer + /openapi/v2/<endpoint> 直接调用模型 API，
        # 无需 ComfyUI workflow_id，与现有 comfykit 路径互不干扰。
        if content.get("mode") == "standard_api":
            workflow_info["mode"] = "standard_api"
            workflow_info["endpoint"] = content.get("endpoint", "")
            workflow_info["defaults"] = content.get("defaults", {}) or {}
            # 图生视频类工作流：声明依赖 imageUrl，缺失时由 media_adapter 先跑图片工作流串联
            if content.get("requires_image_input"):
                workflow_info["requires_image_input"] = True
                workflow_info["image_source_workflow"] = content.get(
                    "image_source_workflow"
                )
            # 参数映射：把 media_adapter 统一字段映射到该模型 API 的请求字段名
            # 如 {"prompt":"prompt","image_url":"imageUrl","duration":"duration"}
            workflow_info["param_map"] = content.get("param_map", {}) or {}
            # 结果媒体类型（用于 media_adapter 按类型抽取 url）
            workflow_info["output_media"] = content.get("output_media", "image")

        return workflow_info

    def _get_default_workflow(self) -> str:
        """从配置获取默认工作流（必须配置，无兜底）。"""
        default_workflow = self.config.get("default_workflow")
        if not default_workflow:
            raise ValueError(
                f"未配置 {self.service_name} 的默认工作流。"
                f"请在 config.yaml 的 '{self.service_name}' 段设置 'default_workflow'。"
                f"可用工作流: {', '.join(self.available)}"
            )
        return default_workflow

    def _resolve_workflow(self, workflow: Optional[str] = None) -> Dict[str, Any]:
        """解析工作流 key 到完整信息 dict。"""
        if workflow is None:
            workflow = self._get_default_workflow()

        available_workflows = self._scan_workflows()
        for wf_info in available_workflows:
            if wf_info["key"] == workflow:
                logger.info(f"🎬 使用 {self.service_name} 工作流: {workflow}")
                return wf_info

        available_keys = [wf["key"] for wf in available_workflows]
        available_str = ", ".join(available_keys) if available_keys else "无"
        raise ValueError(f"工作流 '{workflow}' 未找到。可用: {available_str}")

    def _prepare_comfykit_config(
        self,
        comfyui_url: Optional[str] = None,
        runninghub_api_key: Optional[str] = None,
        runninghub_instance_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """构建 ComfyKit 配置 dict。"""
        kit_config = {}
        kit_config["comfyui_url"] = (
            comfyui_url
            or self.global_config.get("comfyui_url")
            or os.getenv("COMFYUI_BASE_URL")
            or "http://127.0.0.1:8188"
        )
        final_rh_key = (
            runninghub_api_key
            or self.global_config.get("runninghub_api_key")
            or os.getenv("RUNNINGHUB_API_KEY")
        )
        if final_rh_key:
            kit_config["runninghub_api_key"] = final_rh_key
        final_instance_type = (
            runninghub_instance_type
            or self.global_config.get("runninghub_instance_type")
            or os.getenv("RUNNINGHUB_INSTANCE_TYPE")
        )
        if final_instance_type and final_instance_type.strip():
            kit_config["runninghub_instance_type"] = final_instance_type
        return kit_config

    def list_workflows(self) -> List[Dict[str, Any]]:
        """列出所有可用工作流及其元数据。"""
        return self._scan_workflows()

    @property
    def available(self) -> List[str]:
        """返回可用工作流 key 列表。"""
        return [wf["key"] for wf in self.list_workflows()]

    def __repr__(self) -> str:
        default = self._get_default_workflow()
        available = ", ".join(self.available) if self.available else "无"
        return f"<{self.__class__.__name__} default={default!r} available=[{available}]>"
