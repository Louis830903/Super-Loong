"""
视频处理适配器 — 封装 ffmpeg concat / add-bgm / merge-audio 等。

T1.2a 从 Pixelle services/video.py 迁移。
关键改动：
  - 删除模块级 check_ffmpeg() 调用，改为 __init__ 内懒检测
  - 导入路径 pixelle_video.utils.os_util → app.utils.os_util
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import List, Literal, Optional

import ffmpeg
from loguru import logger

from app.utils.os_util import (
    get_resource_path,
    get_temp_path,
    list_resource_files,
    resource_exists,
)


def check_ffmpeg() -> None:
    """检查系统是否安装了 ffmpeg，未找到则抛 RuntimeError。"""
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "FFmpeg not found. Please install it:\n"
            "  macOS: brew install ffmpeg\n"
            "  Ubuntu/Debian: apt-get install ffmpeg\n"
            "  Windows: https://ffmpeg.org/download.html"
        )


# ⚠️ 不再在模块导入时自动执行 check_ffmpeg()
# 由 VideoService.__init__ 在首次实例化时懒检测


class VideoService:
    """
    视频合成器 — 封装常见视频处理任务。

    基于 ffmpeg-python，在保持画质的同时（stream copy）完成：
    - 视频拼接 (concat)
    - 音视频合并 (merge_audio_video)
    - 添加背景音乐 (add_bgm)
    - 图片转视频 (create_video_from_image)
    - 图层叠加 (overlay_image_on_video)
    """

    def __init__(self) -> None:
        """实例化时懒检测 ffmpeg / ffprobe 可用性。未找到仅警告，实际调用时再报错。"""
        ffmpeg_path = shutil.which("ffmpeg")
        ffprobe_path = shutil.which("ffprobe")
        self._ffmpeg_available = ffmpeg_path is not None
        self._ffprobe_available = ffprobe_path is not None
        logger.info(
            f"VideoService init | ffmpeg={ffmpeg_path} | ffprobe={ffprobe_path} "
            f"| PATH(head)={(os.environ.get('PATH') or '')[:300]}"
        )
        if not self._ffmpeg_available:
            logger.warning("FFmpeg 未找到，请确保 bootstrap 已下载 ffmpeg 并注入 PATH。")
        if not self._ffprobe_available:
            logger.warning("FFprobe 未找到，ffmpeg.probe() 将失败（WinError 2 常因此）。")

    def _ensure_ffmpeg(self) -> None:
        """内部方法：在需要 ffmpeg / ffprobe 时调用，未安装则报错。"""
        if not self._ffmpeg_available:
            self._ffmpeg_available = shutil.which("ffmpeg") is not None
        if not self._ffprobe_available:
            self._ffprobe_available = shutil.which("ffprobe") is not None
        if not self._ffmpeg_available:
            check_ffmpeg()  # 这会抛 RuntimeError
        if not self._ffprobe_available:
            raise RuntimeError(
                "FFprobe not found on PATH. bootstrap 应下载 ffprobe 并前置到 PATH。"
                f" 当前 PATH head: {(os.environ.get('PATH') or '')[:300]}"
            )

    # ------------------------------------------------------------------
    # 拼接
    # ------------------------------------------------------------------

    def concat_videos(
        self,
        videos: List[str],
        output: str,
        method: Literal["demuxer", "filter"] = "demuxer",
        bgm_path: Optional[str] = None,
        bgm_volume: float = 0.2,
        bgm_mode: Literal["once", "loop"] = "loop",
    ) -> str:
        """
        拼接多段视频为一段。

        Args:
            videos: 待拼接视频路径列表
            output: 输出路径
            method: "demuxer"（快，不重编码）/ "filter"（兼容不同编码）
            bgm_path: 背景音乐路径（可选）
            bgm_volume: BGM 音量 0.0–1.0
            bgm_mode: "once" / "loop"
        """
        self._ensure_ffmpeg()
        if not videos:
            raise ValueError("Videos list cannot be empty")

        if len(videos) == 1:
            logger.info(f"Only one video provided, copying to {output}")
            shutil.copy(videos[0], output)
            return output

        logger.info(f"Concatenating {len(videos)} videos using {method} method")

        if bgm_path:
            temp_output = output.replace(".mp4", "_no_bgm.mp4")
            concat_result = (
                self._concat_demuxer(videos, temp_output)
                if method == "demuxer"
                else self._concat_filter(videos, temp_output)
            )
            logger.info(f"Adding BGM: {bgm_path} (volume={bgm_volume}, mode={bgm_mode})")
            final_result = self._add_bgm_to_video(
                video=concat_result,
                bgm_path=bgm_path,
                output=output,
                volume=bgm_volume,
                mode=bgm_mode,
            )
            if os.path.exists(temp_output):
                os.unlink(temp_output)
            return final_result
        else:
            if method == "demuxer":
                return self._concat_demuxer(videos, output)
            else:
                return self._concat_filter(videos, output)

    def _concat_demuxer(self, videos: List[str], output: str) -> str:
        """Concat demuxer 模式：快速无重编码。"""
        with tempfile.NamedTemporaryFile(
            mode="w", delete=False, suffix=".txt", encoding="utf-8"
        ) as f:
            for video in videos:
                abs_path = Path(video).absolute()
                escaped_path = str(abs_path).replace("'", "'\\''")
                f.write(f"file '{escaped_path}'\n")
            filelist = f.name

        try:
            logger.debug(f"Created filelist: {filelist}")
            (
                ffmpeg.input(filelist, format="concat", safe=0)
                .output(output, c="copy")
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            logger.success(f"Videos concatenated successfully: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            logger.error(f"FFmpeg concat error: {error_msg}")
            raise RuntimeError(f"Failed to concatenate videos: {error_msg}")
        finally:
            if os.path.exists(filelist):
                os.unlink(filelist)

    def _concat_filter(self, videos: List[str], output: str) -> str:
        """Concat filter 模式：兼容不同编码，需重编码。"""
        try:
            n = len(videos)
            stream_spec = "".join([f"[{i}:v][{i}:a]" for i in range(n)])
            filter_complex = f"{stream_spec}concat=n={n}:v=1:a=1[v][a]"

            cmd = ["ffmpeg"]
            for video in videos:
                cmd.extend(["-i", video])
            cmd.extend([
                "-filter_complex", filter_complex,
                "-map", "[v]",
                "-map", "[a]",
                "-y",
                output,
            ])

            subprocess.run(cmd, capture_output=True, text=True, check=True)
            logger.success(f"Videos concatenated successfully: {output}")
            return output
        except subprocess.CalledProcessError as e:
            error_msg = e.stderr if e.stderr else str(e)
            logger.error(f"FFmpeg concat filter error: {error_msg}")
            raise RuntimeError(f"Failed to concatenate videos: {error_msg}")

    # ------------------------------------------------------------------
    # 时长探测
    # ------------------------------------------------------------------

    def _get_video_duration(self, video: str) -> float:
        try:
            probe = ffmpeg.probe(video)
            return float(probe["format"]["duration"])
        except Exception as e:
            logger.warning(f"Failed to get video duration: {e}")
            return 0.0

    def _get_audio_duration(self, audio: str) -> float:
        try:
            probe = ffmpeg.probe(audio)
            return float(probe["format"]["duration"])
        except Exception as e:
            logger.warning(f"Failed to get audio duration: {e}, using estimate")
            file_size = os.path.getsize(audio)
            return max(1.0, file_size / 2000)

    def has_audio_stream(self, video: str) -> bool:
        """检测视频是否包含音频流。"""
        try:
            probe = ffmpeg.probe(video)
            audio_streams = [s for s in probe.get("streams", []) if s["codec_type"] == "audio"]
            has_audio = len(audio_streams) > 0
            logger.debug(f"Video {video} has_audio={has_audio}")
            return has_audio
        except Exception as e:
            logger.warning(f"Failed to probe video audio streams: {e}, assuming no audio")
            return False

    # ------------------------------------------------------------------
    # 合并音视频
    # ------------------------------------------------------------------

    def merge_audio_video(
        self,
        video: str,
        audio: str,
        output: str,
        replace_audio: bool = True,
        audio_volume: float = 1.0,
        video_volume: float = 0.0,
        pad_strategy: str = "freeze",
        auto_adjust_duration: bool = True,
        duration_tolerance: float = 0.3,
    ) -> str:
        """
        智能合并音频与视频，自动处理时长差异。

        - video < audio → 补帧 (freeze/black)
        - video > audio（容差内）→ 保持原样
        - video > audio（超出容差）→ 裁剪
        """
        self._ensure_ffmpeg()
        video_duration = self._get_video_duration(video)
        audio_duration = self._get_audio_duration(audio)
        logger.info(f"Video duration: {video_duration:.2f}s, Audio duration: {audio_duration:.2f}s")

        if auto_adjust_duration:
            diff = video_duration - audio_duration
            if diff < 0:
                logger.warning(f"Video shorter than audio by {abs(diff):.2f}s, padding required")
                video = self._pad_video_to_duration(video, audio_duration, pad_strategy)
                video_duration = audio_duration
            elif diff > duration_tolerance:
                logger.info(f"Video longer than audio by {diff:.2f}s, trimming")
                video = self._trim_video_to_duration(video, audio_duration)
                video_duration = audio_duration
            else:
                logger.info(f"Duration acceptable (diff={diff:.2f}s)")

        target_duration = max(video_duration, audio_duration)
        video_has_audio = self.has_audio_stream(video)

        input_video = ffmpeg.input(video)
        video_stream = input_video.video

        # 如果音频更长，补帧
        if audio_duration > video_duration:
            pad_duration = audio_duration - video_duration
            if pad_strategy == "freeze":
                video_stream = video_stream.filter("tpad", stop_mode="clone", stop_duration=pad_duration)
            else:
                probe = ffmpeg.probe(video)
                video_info = next(s for s in probe["streams"] if s["codec_type"] == "video")
                w, h = int(video_info["width"]), int(video_info["height"])
                fps_str = video_info["r_frame_rate"]
                fps_num, fps_den = map(int, fps_str.split("/"))
                fps = fps_num / fps_den if fps_den != 0 else 30
                black_input = ffmpeg.input(
                    f"color=c=black:s={w}x{h}:r={fps}", f="lavfi", t=pad_duration
                )
                video_stream = ffmpeg.concat(video_stream, black_input.video, v=1, a=0)

        input_audio = ffmpeg.input(audio)
        audio_stream = input_audio.audio.filter("volume", audio_volume)

        if video_duration > audio_duration:
            audio_stream = audio_stream.filter("apad", whole_dur=target_duration)

        try:
            if not video_has_audio or replace_audio:
                (
                    ffmpeg.output(
                        video_stream, audio_stream, output,
                        vcodec="libx264", acodec="aac", audio_bitrate="192k",
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True)
                )
            else:
                mixed_audio = ffmpeg.filter(
                    [input_video.audio.filter("volume", video_volume), audio_stream],
                    "amix", inputs=2, duration="longest",
                )
                (
                    ffmpeg.output(
                        video_stream, mixed_audio, output,
                        vcodec="libx264", acodec="aac", audio_bitrate="192k",
                    )
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True)
                )
            logger.success(f"Audio merged successfully: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            raise RuntimeError(f"Failed to merge audio and video: {error_msg}")

    # ------------------------------------------------------------------
    # 图层叠加
    # ------------------------------------------------------------------

    def overlay_image_on_video(
        self,
        video: str,
        overlay_image: str,
        output: str,
        scale_mode: str = "contain",
    ) -> str:
        """在视频上叠加透明图片（HTML 渲染的模板层）。"""
        self._ensure_ffmpeg()
        logger.info(f"Overlaying image on video (scale_mode={scale_mode})")
        try:
            overlay_probe = ffmpeg.probe(overlay_image)
            overlay_stream = next(s for s in overlay_probe["streams"] if s["codec_type"] == "video")
            ow, oh = int(overlay_stream["width"]), int(overlay_stream["height"])

            input_video = ffmpeg.input(video)
            input_overlay = ffmpeg.input(overlay_image)

            if scale_mode == "contain":
                scaled = (
                    input_video
                    .filter("scale", ow, oh, force_original_aspect_ratio="decrease")
                    .filter("pad", ow, oh, "(ow-iw)/2", "(oh-ih)/2", color="black")
                )
            elif scale_mode == "cover":
                scaled = (
                    input_video
                    .filter("scale", ow, oh, force_original_aspect_ratio="increase")
                    .filter("crop", ow, oh)
                )
            else:
                scaled = input_video.filter("scale", ow, oh)

            output_stream = ffmpeg.overlay(scaled, input_overlay)
            (
                ffmpeg.output(
                    output_stream, output,
                    vcodec="libx264", pix_fmt="yuv420p", preset="medium", crf=23,
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            logger.success(f"Image overlaid on video: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            raise RuntimeError(f"Failed to overlay image on video: {error_msg}")

    # ------------------------------------------------------------------
    # 图片转视频
    # ------------------------------------------------------------------

    def create_video_from_image(
        self,
        image: str,
        audio: str,
        output: str,
        fps: int = 30,
    ) -> str:
        """用静态图片 + 音频生成视频（时长 = 音频时长）。"""
        self._ensure_ffmpeg()
        logger.info("Creating video from image and audio")
        try:
            probe = ffmpeg.probe(audio)
            audio_duration = float(probe["format"]["duration"])

            input_image = ffmpeg.input(image, loop=1, framerate=fps)
            input_audio = ffmpeg.input(audio)

            (
                ffmpeg.output(
                    input_image, input_audio, output,
                    t=audio_duration,
                    vcodec="libx264", acodec="aac", pix_fmt="yuv420p",
                    audio_bitrate="192k", preset="medium", crf=23,
                    **{"b:v": "2M"},
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            logger.success(f"Video created from image: {output} ({audio_duration:.3f}s)")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            raise RuntimeError(f"Failed to create video from image: {error_msg}")

    # ------------------------------------------------------------------
    # 背景音乐
    # ------------------------------------------------------------------

    def add_bgm(
        self,
        video: str,
        bgm: str,
        output: str,
        bgm_volume: float = 0.3,
        loop: bool = True,
        fade_in: float = 0.0,
        fade_out: float = 0.0,
    ) -> str:
        """为视频添加背景音乐。"""
        self._ensure_ffmpeg()
        logger.info(f"Adding BGM to video (volume={bgm_volume}, loop={loop})")
        try:
            input_video = ffmpeg.input(video)
            bgm_input = ffmpeg.input(bgm, stream_loop=-1 if loop else 0)
            bgm_audio = bgm_input.audio.filter("volume", bgm_volume)

            if fade_in > 0:
                bgm_audio = bgm_audio.filter("afade", type="in", duration=fade_in)

            mixed_audio = ffmpeg.filter(
                [input_video.audio, bgm_audio],
                "amix", inputs=2, duration="first",
            )
            (
                ffmpeg.output(
                    input_video.video, mixed_audio, output,
                    vcodec="copy", acodec="aac", audio_bitrate="192k",
                )
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True)
            )
            logger.success(f"BGM added successfully: {output}")
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            raise RuntimeError(f"Failed to add BGM: {error_msg}")

    # ------------------------------------------------------------------
    # 内部辅助
    # ------------------------------------------------------------------

    def _add_bgm_to_video(
        self,
        video: str,
        bgm_path: str,
        output: str,
        volume: float = 0.2,
        mode: Literal["once", "loop"] = "loop",
    ) -> str:
        """内部方法：解析 BGM 路径后添加背景音乐。"""
        resolved_bgm = self._resolve_bgm_path(bgm_path)
        return self.add_bgm(
            video=video, bgm=resolved_bgm, output=output,
            bgm_volume=volume, loop=(mode == "loop"), fade_in=0.0,
        )

    def _get_unique_temp_path(self, prefix: str, original_filename: str) -> str:
        """生成唯一临时文件路径：temp/{prefix}_{uuid8}_{filename}。"""
        unique_id = uuid.uuid4().hex[:8]
        return get_temp_path(f"{prefix}_{unique_id}_{original_filename}")

    def _resolve_bgm_path(self, bgm_path: str) -> str:
        """
        解析 BGM 路径（文件名或自定义路径）。

        搜索顺序：直接路径 → data/bgm/{filename} → bgm/{filename}
        """
        if os.path.exists(bgm_path):
            return os.path.abspath(bgm_path)

        if resource_exists("bgm", bgm_path):
            return get_resource_path("bgm", bgm_path)

        available_bgm = self._list_available_bgm()
        available_msg = f"\n  Available: {', '.join(available_bgm)}" if available_bgm else ""
        raise FileNotFoundError(
            f"BGM file not found: '{bgm_path}'\n"
            f"  Tried: {os.path.abspath(bgm_path)} / data/bgm/{bgm_path} / bgm/{bgm_path}"
            f"{available_msg}"
        )

    def _list_available_bgm(self) -> list[str]:
        """列出可用 BGM 文件（合并 bgm/ 与 data/bgm/）。"""
        try:
            all_files = list_resource_files("bgm")
            audio_ext = (".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac")
            return sorted([f for f in all_files if f.lower().endswith(audio_ext)])
        except Exception as e:
            logger.warning(f"Failed to list BGM files: {e}")
            return []

    def _trim_video_to_duration(self, video: str, target_duration: float) -> str:
        """裁剪视频至指定时长。"""
        output = self._get_unique_temp_path("trimmed", os.path.basename(video))
        try:
            (
                ffmpeg.input(video, t=target_duration)
                .output(output, vcodec="copy", acodec="copy")
                .overwrite_output()
                .run(capture_stdout=True, capture_stderr=True, quiet=True)
            )
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            raise RuntimeError(f"Failed to trim video: {error_msg}")

    def _pad_video_to_duration(
        self, video: str, target_duration: float, pad_strategy: str = "freeze"
    ) -> str:
        """补帧至指定时长（freeze 冻结末帧 / black 黑屏填充）。"""
        output = self._get_unique_temp_path("padded", os.path.basename(video))
        video_duration = self._get_video_duration(video)
        pad_duration = target_duration - video_duration

        if pad_duration <= 0:
            return video

        try:
            input_video = ffmpeg.input(video)
            video_stream = input_video.video

            if pad_strategy == "freeze":
                video_stream = video_stream.filter("tpad", stop_mode="clone", stop_duration=pad_duration)
                (
                    ffmpeg.output(video_stream, output, vcodec="libx264", preset="fast", crf=23)
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True, quiet=True)
                )
            else:
                probe = ffmpeg.probe(video)
                vi = next(s for s in probe["streams"] if s["codec_type"] == "video")
                w, h = int(vi["width"]), int(vi["height"])
                fps_num, fps_den = map(int, vi["r_frame_rate"].split("/"))
                fps = fps_num / fps_den if fps_den != 0 else 30
                black_input = ffmpeg.input(
                    f"color=c=black:s={w}x{h}:r={fps}", f="lavfi", t=pad_duration
                )
                video_stream = ffmpeg.concat(video_stream, black_input.video, v=1, a=0)
                (
                    ffmpeg.output(video_stream, output, vcodec="libx264", preset="fast", crf=23)
                    .overwrite_output()
                    .run(capture_stdout=True, capture_stderr=True, quiet=True)
                )
            return output
        except ffmpeg.Error as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            raise RuntimeError(f"Failed to pad video: {error_msg}")
