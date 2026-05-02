"""
帧处理适配器 — Playwright 渲染 + ffmpeg 合成单帧视频段。

T1.2a 从 Pixelle services/frame_processor.py 迁移。
导入路径：pixelle_video.* → app.*

注意：
  - frame_html / template_util 尚未迁移，保留延迟导入 + TODO
  - ProgressEvent / Storyboard 已迁移至 app.models / app.core
"""

from typing import Callable, Optional

import httpx
from loguru import logger

from app.models.progress import ProgressEvent
from app.core.storyboard import Storyboard, StoryboardFrame, StoryboardConfig


class FrameProcessor:
    """帧处理器 — 单帧完整管线：TTS → 媒体生成 → 合成 → 视频段"""

    def __init__(self, mini_core):
        """
        Args:
            mini_core: MiniCore 实例（持有 tts / media / video 等子服务）
        """
        self.core = mini_core

    async def __call__(
        self,
        frame: StoryboardFrame,
        storyboard: "Storyboard",
        config: StoryboardConfig,
        total_frames: int = 1,
        progress_callback: Optional[Callable[[ProgressEvent], None]] = None,
    ) -> StoryboardFrame:
        """
        处理单帧完整管线。

        Steps:
            1. 生成音频 (TTS)
            2. 生成媒体 (image/video)
            3. 合成帧 (HTML 模板叠加)
            4. 创建视频段 (image+audio / overlay+audio)
        """
        logger.info(f"Processing frame {frame.index}...")
        frame_num = frame.index + 1

        has_existing_media = frame.image_path is not None or frame.video_path is not None
        needs_generation = frame.image_prompt is not None

        try:
            # Step 1: TTS
            if not frame.audio_path:
                if progress_callback:
                    progress_callback(ProgressEvent(
                        event_type="frame_step", progress=0.0,
                        frame_current=frame_num, frame_total=total_frames,
                        step=1, action="audio",
                    ))
                await self._step_generate_audio(frame, config)
            else:
                logger.debug(f"  1/4: Using existing audio: {frame.audio_path}")

            # Step 2: 媒体生成
            if needs_generation:
                if progress_callback:
                    progress_callback(ProgressEvent(
                        event_type="frame_step", progress=0.25,
                        frame_current=frame_num, frame_total=total_frames,
                        step=2, action="media",
                    ))
                await self._step_generate_media(frame, config)
            elif has_existing_media:
                logger.debug(f"  2/4: Using existing media")
            else:
                frame.image_path = None
                frame.media_type = None

            # Step 3: 合成
            if progress_callback:
                progress_callback(ProgressEvent(
                    event_type="frame_step",
                    progress=0.50 if (needs_generation or has_existing_media) else 0.33,
                    frame_current=frame_num, frame_total=total_frames,
                    step=3, action="compose",
                ))
            await self._step_compose_frame(frame, storyboard, config)

            # Step 4: 视频段
            if progress_callback:
                progress_callback(ProgressEvent(
                    event_type="frame_step",
                    progress=0.75 if (needs_generation or has_existing_media) else 0.67,
                    frame_current=frame_num, frame_total=total_frames,
                    step=4, action="video",
                ))
            await self._step_create_video_segment(frame, config)

            logger.info(f"Frame {frame.index} completed")
            return frame

        except Exception as e:
            logger.error(f"Failed to process frame {frame.index}: {e}")
            raise

    # ------------------------------------------------------------------
    # Step 1: TTS
    # ------------------------------------------------------------------

    async def _step_generate_audio(
        self, frame: StoryboardFrame, config: StoryboardConfig
    ):
        from app.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(config.task_id, frame.index, "audio")

        tts_params = {
            "text": frame.narration,
            "inference_mode": config.tts_inference_mode,
            "output_path": output_path,
            "index": frame.index + 1,
        }

        if config.tts_inference_mode == "local":
            if config.voice_id:
                tts_params["voice"] = config.voice_id
            if config.tts_speed is not None:
                tts_params["speed"] = config.tts_speed
        else:
            if config.tts_workflow:
                tts_params["workflow"] = config.tts_workflow
            if config.voice_id:
                tts_params["voice"] = config.voice_id
            if config.tts_speed is not None:
                tts_params["speed"] = config.tts_speed
            if config.ref_audio:
                tts_params["ref_audio"] = config.ref_audio

        audio_path = await self.core.tts(**tts_params)
        frame.audio_path = audio_path
        frame.duration = await self._get_audio_duration(audio_path)
        logger.debug(f"  Audio generated: {audio_path} ({frame.duration:.2f}s)")

    # ------------------------------------------------------------------
    # Step 2: 媒体生成
    # ------------------------------------------------------------------

    async def _step_generate_media(
        self, frame: StoryboardFrame, config: StoryboardConfig
    ):
        workflow_name = config.media_workflow or ""
        is_video_workflow = "video_" in workflow_name.lower()
        media_type = "video" if is_video_workflow else "image"

        media_params = {
            "prompt": frame.image_prompt,
            "workflow": config.media_workflow,
            "media_type": media_type,
            "width": config.media_width,
            "height": config.media_height,
            "index": frame.index + 1,
        }

        if is_video_workflow and frame.duration:
            media_params["duration"] = frame.duration

        media_result = await self.core.media(**media_params)
        frame.media_type = media_result.media_type

        if media_result.is_image:
            local_path = await self._download_media(
                media_result.url, frame.index, config.task_id, "image"
            )
            frame.image_path = local_path
        elif media_result.is_video:
            local_path = await self._download_media(
                media_result.url, frame.index, config.task_id, "video"
            )
            frame.video_path = local_path
            frame.duration = media_result.duration or await self._get_video_duration(local_path)
        else:
            raise ValueError(f"Unknown media type: {media_result.media_type}")

    # ------------------------------------------------------------------
    # Step 3: 合成 — HTML 模板渲染
    # ------------------------------------------------------------------

    async def _step_compose_frame(
        self,
        frame: StoryboardFrame,
        storyboard: "Storyboard",
        config: StoryboardConfig,
    ):
        from app.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(config.task_id, frame.index, "composed")
        composed_path = await self._compose_frame_html(frame, storyboard, config, output_path)
        frame.composed_image_path = composed_path

    async def _compose_frame_html(
        self,
        frame: StoryboardFrame,
        storyboard: "Storyboard",
        config: StoryboardConfig,
        output_path: str,
    ) -> str:
        # TODO T1.4+: 迁移 frame_html.HTMLFrameGenerator 和 template_util
        # 当前使用延迟导入占位，实际运行需要这些模块就绪
        from app.core.frame_html import HTMLFrameGenerator  # type: ignore  # noqa: F401
        from app.utils.template_util import resolve_template_path  # type: ignore  # noqa: F401

        template_path = resolve_template_path(config.frame_template)
        content_metadata = storyboard.content_metadata if storyboard else None

        ext = {"index": frame.index + 1}
        if config.template_params:
            ext.update(config.template_params)

        generator = HTMLFrameGenerator(template_path)
        media_path = frame.video_path if frame.media_type == "video" else frame.image_path

        composed_path = await generator.generate_frame(
            title=storyboard.title,
            text=frame.narration,
            image=media_path,
            ext=ext,
            output_path=output_path,
        )
        return composed_path

    # ------------------------------------------------------------------
    # Step 4: 视频段
    # ------------------------------------------------------------------

    async def _step_create_video_segment(
        self, frame: StoryboardFrame, config: StoryboardConfig
    ):
        from app.utils.os_util import get_task_frame_path
        from app.core.video_adapter import VideoService

        output_path = get_task_frame_path(config.task_id, frame.index, "segment")
        video_service = VideoService()

        if frame.media_type == "video":
            temp_overlay = get_task_frame_path(config.task_id, frame.index, "video") + "_overlay.mp4"
            video_service.overlay_image_on_video(
                video=frame.video_path,
                overlay_image=frame.composed_image_path,
                output=temp_overlay,
                scale_mode="contain",
            )
            segment_path = video_service.merge_audio_video(
                video=temp_overlay, audio=frame.audio_path,
                output=output_path, replace_audio=True, audio_volume=1.0,
            )
            import os
            if os.path.exists(temp_overlay):
                os.unlink(temp_overlay)
        elif frame.media_type == "image" or frame.media_type is None:
            segment_path = video_service.create_video_from_image(
                image=frame.composed_image_path,
                audio=frame.audio_path,
                output=output_path,
                fps=config.video_fps,
            )
        else:
            raise ValueError(f"Unknown media type: {frame.media_type}")

        frame.video_segment_path = segment_path
        logger.debug(f"  Video segment created: {segment_path}")

    # ------------------------------------------------------------------
    # 辅助方法
    # ------------------------------------------------------------------

    async def _get_audio_duration(self, audio_path: str) -> float:
        try:
            import ffmpeg
            probe = ffmpeg.probe(audio_path)
            return float(probe["format"]["duration"])
        except Exception as e:
            logger.warning(f"Failed to get audio duration: {e}, using estimate")
            import os
            file_size = os.path.getsize(audio_path)
            return max(1.0, file_size / 2000)

    async def _download_media(
        self, url: str, frame_index: int, task_id: str, media_type: str
    ) -> str:
        from app.utils.os_util import get_task_frame_path

        output_path = get_task_frame_path(task_id, frame_index, media_type)
        timeout = httpx.Timeout(connect=10.0, read=60, write=60, pool=60)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            response.raise_for_status()
            with open(output_path, "wb") as f:
                f.write(response.content)
        return output_path

    async def _get_video_duration(self, video_path: str) -> float:
        try:
            import ffmpeg
            probe = ffmpeg.probe(video_path)
            return float(probe["format"]["duration"])
        except Exception as e:
            logger.warning(f"Failed to get video duration: {e}")
            return 1.0
