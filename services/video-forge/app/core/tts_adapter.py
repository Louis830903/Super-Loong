"""
TTS 适配器 — 封装 edge-tts / ComfyKit TTS 工作流。

T1.2a 从 Pixelle services/tts_service.py 迁移。
导入路径：pixelle_video.* → app.*
"""

import os
import uuid
from pathlib import Path
from typing import Optional

from comfykit import ComfyKit
from loguru import logger

from app.core.comfy_base_service import ComfyBaseService
from app.utils.tts_util import edge_tts, speed_to_rate


class TTSService(ComfyBaseService):
    """
    TTS 服务 — 支持本地 Edge TTS 与 ComfyUI 工作流两种推理模式。

    用法:
        audio_path = await tts_service(text="你好", inference_mode="local")
    """

    WORKFLOW_PREFIX = "tts_"
    DEFAULT_WORKFLOW = None
    WORKFLOWS_DIR = "workflows"

    def __init__(self, config: dict, core=None):
        """
        Args:
            config: 完整应用配置
            core: MiniCore 实例（用于获取共享 ComfyKit）
        """
        super().__init__(config, service_name="tts", core=core)

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------

    async def __call__(
        self,
        text: str,
        workflow: Optional[str] = None,
        comfyui_url: Optional[str] = None,
        runninghub_api_key: Optional[str] = None,
        voice: Optional[str] = None,
        speed: Optional[float] = None,
        inference_mode: Optional[str] = None,
        output_path: Optional[str] = None,
        **params,
    ) -> str:
        """
        生成语音。

        Args:
            text: 待转语音的文本
            inference_mode: "local" (Edge TTS) / "comfyui"
            voice: 语音 ID
            speed: 语速倍率
            output_path: 输出路径（自动生成如省略）
        """
        mode = inference_mode or self.config.get("inference_mode", "local")

        if mode == "local":
            return await self._call_local_tts(
                text=text, voice=voice, speed=speed, output_path=output_path
            )
        else:
            workflow_info = self._resolve_workflow(workflow=workflow)
            return await self._call_comfyui_workflow(
                workflow_info=workflow_info,
                text=text,
                comfyui_url=comfyui_url,
                runninghub_api_key=runninghub_api_key,
                voice=voice,
                speed=speed,
                output_path=output_path,
                **params,
            )

    # ------------------------------------------------------------------
    # 本地 Edge TTS
    # ------------------------------------------------------------------

    async def _call_local_tts(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: Optional[float] = None,
        output_path: Optional[str] = None,
    ) -> str:
        """本地 Edge TTS 推理。"""
        local_config = self.config.get("local", {})
        final_voice = voice or local_config.get("voice", "zh-CN-YunjianNeural")
        final_speed = speed if speed is not None else local_config.get("speed", 1.2)
        rate = speed_to_rate(final_speed)

        logger.info(f"Using local Edge TTS: voice={final_voice}, speed={final_speed}x (rate={rate})")

        if not output_path:
            unique_id = uuid.uuid4().hex
            output_path = f"output/{unique_id}.mp3"
            Path("output").mkdir(parents=True, exist_ok=True)

        try:
            await edge_tts(
                text=text, voice=final_voice, rate=rate, output_path=output_path
            )
            logger.info(f"Generated audio (local Edge TTS): {output_path}")
            return output_path
        except Exception as e:
            logger.error(f"Local TTS generation error: {e}")
            raise

    # ------------------------------------------------------------------
    # ComfyUI 工作流
    # ------------------------------------------------------------------

    async def _call_comfyui_workflow(
        self,
        workflow_info: dict,
        text: str,
        comfyui_url: Optional[str] = None,
        runninghub_api_key: Optional[str] = None,
        voice: Optional[str] = None,
        speed: float = 1.0,
        output_path: Optional[str] = None,
        **params,
    ) -> str:
        """ComfyUI 工作流推理。"""
        logger.info(f"Using workflow: {workflow_info['key']}")

        workflow_params = {"text": text}
        if voice is not None:
            workflow_params["voice"] = voice
        if speed is not None and speed != 1.0:
            workflow_params["speed"] = speed
        workflow_params.update(params)

        try:
            kit = await self.core._get_or_create_comfykit()

            if workflow_info["source"] == "runninghub" and "workflow_id" in workflow_info:
                workflow_input = workflow_info["workflow_id"]
            else:
                workflow_input = workflow_info["path"]

            result = await kit.execute(workflow_input, workflow_params)

            if result.status != "completed":
                raise Exception(f"TTS generation failed: {result.msg or 'Unknown error'}")

            audio_path = None
            if hasattr(result, "audios") and result.audios:
                audio_path = result.audios[0]
            elif hasattr(result, "files") and result.files:
                audio_path = result.files[0]
            elif hasattr(result, "outputs") and result.outputs:
                for key, value in result.outputs.items():
                    if isinstance(value, str) and any(
                        value.endswith(ext) for ext in [".mp3", ".wav", ".flac"]
                    ):
                        audio_path = value
                        break

            if not audio_path:
                logger.error(f"No audio file generated. Result: {result.__dict__}")
                raise Exception("No audio file generated by workflow")

            # 如果需要下载到本地
            if output_path and audio_path.startswith(("http://", "https://")):
                import httpx

                os.makedirs(os.path.dirname(output_path), exist_ok=True)
                async with httpx.AsyncClient() as client:
                    response = await client.get(audio_path)
                    response.raise_for_status()
                    with open(output_path, "wb") as f:
                        f.write(response.content)
                logger.info(f"Generated audio (ComfyUI): {output_path}")
                return output_path

            logger.info(f"Generated audio (ComfyUI): {audio_path}")
            return audio_path
        except Exception as e:
            logger.error(f"TTS generation error: {e}")
            raise
