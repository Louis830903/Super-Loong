"""
MiniCore — 轻量核心路由（替代 PixelleVideoCore 在微服务场景的作用）。

设计要点：
  - 持有 ComfyKit 单例（懒初始化 + 配置变更检测 + 自动重建）
  - 提供 media / tts / video / frame_processor 子服务的统一入口
  - 不含任何 LLM 调用逻辑（LLM 由 super-agent 侧处理）
  - 从 config.yaml 加载配置（非 Pixelle config_manager）
"""

import hashlib
import json
from pathlib import Path
from typing import Optional

import yaml
from comfykit import ComfyKit
from loguru import logger


class MiniCore:
    """
    video-forge 微服务的轻量核心。

    替代 Pixelle PixelleVideoCore，只保留 ComfyKit 单例池 + 子服务路由。
    所有需要 ComfyKit 的子服务通过 ``await self.core._get_or_create_comfykit()``
    获取共享实例。

    Usage::

        core = MiniCore("config.yaml")
        await core.initialize()

        audio = await core.tts(text="你好")
        media = await core.media(prompt="a cat")

        await core.cleanup()
    """

    def __init__(self, config_path: str = "config.yaml") -> None:
        """
        Args:
            config_path: YAML 配置文件路径（相对或绝对）。
        """
        self.config_path = str(Path(config_path).resolve())
        self.config: dict = self._load_config(self.config_path)
        self._initialized = False

        # ComfyKit 懒初始化
        self._comfykit: Optional[ComfyKit] = None
        self._comfykit_config_hash: Optional[str] = None

        # 子服务占位（initialize() 时赋值）
        self.tts = None                    # TTSService
        self.media = None                  # MediaService
        self.video = None                  # VideoService
        self.frame_processor = None        # FrameProcessor

    # ------------------------------------------------------------------
    # 配置加载
    # ------------------------------------------------------------------

    @staticmethod
    def _load_config(config_path: str) -> dict:
        """从 YAML 文件加载配置；文件不存在则返回空字典。"""
        p = Path(config_path)
        if not p.exists():
            logger.warning(f"配置文件不存在: {config_path}，使用空配置")
            return {}
        with open(p, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        logger.info(f"已加载配置: {config_path}")
        return data

    def reload_config(self) -> dict:
        """热重载配置（运行时调用以感知外部改动）。"""
        self.config = self._load_config(self.config_path)
        return self.config

    # ------------------------------------------------------------------
    # ComfyKit 单例管理（懒初始化 + 配置变更检测）
    # ------------------------------------------------------------------

    def _get_comfykit_config(self) -> dict:
        """从 config 中提取 ComfyKit 连接参数。"""
        # 每次调用都重读最新配置以支持热重载
        self.config = self._load_config(self.config_path)
        comfyui_cfg = self.config.get("comfyui", {})

        kit_cfg: dict = {}
        if comfyui_cfg.get("comfyui_url"):
            kit_cfg["comfyui_url"] = comfyui_cfg["comfyui_url"]
        if comfyui_cfg.get("comfyui_api_key"):
            kit_cfg["api_key"] = comfyui_cfg["comfyui_api_key"]
        if comfyui_cfg.get("runninghub_api_key"):
            kit_cfg["runninghub_api_key"] = comfyui_cfg["runninghub_api_key"]
        instance_type = comfyui_cfg.get("runninghub_instance_type")
        if instance_type and str(instance_type).strip():
            kit_cfg["runninghub_instance_type"] = instance_type
        return kit_cfg

    @staticmethod
    def _compute_config_hash(cfg: dict) -> str:
        """计算配置字典的 MD5 哈希（用于变更检测）。"""
        return hashlib.md5(
            json.dumps(cfg, sort_keys=True).encode()
        ).hexdigest()

    async def _get_or_create_comfykit(self) -> ComfyKit:
        """
        获取或创建 ComfyKit 共享实例。

        - 首次调用时懒创建
        - 配置变更时自动关闭旧实例并重建
        """
        current_cfg = self._get_comfykit_config()
        current_hash = self._compute_config_hash(current_cfg)

        if self._comfykit is None or self._comfykit_config_hash != current_hash:
            # 关闭旧实例
            if self._comfykit is not None:
                logger.info("ComfyUI 配置已变更，重建 ComfyKit 实例...")
                try:
                    await self._comfykit.close()
                except Exception as e:
                    logger.warning(f"关闭旧 ComfyKit 实例失败: {e}")
                self._comfykit = None

            logger.info("创建 ComfyKit 实例...")
            logger.debug(f"ComfyKit config: {current_cfg}")
            self._comfykit = ComfyKit(**current_cfg)
            self._comfykit_config_hash = current_hash
            logger.info("ComfyKit 实例已就绪")

        return self._comfykit

    @property
    def comfykit_ready(self) -> bool:
        """ComfyKit 是否已初始化（不触发懒创建）。"""
        return self._comfykit is not None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def initialize(self) -> None:
        """
        初始化所有子服务（ComfyKit 本身仍为懒加载）。
        """
        if self._initialized:
            logger.warning("MiniCore 已初始化，跳过重复调用")
            return

        logger.info("正在初始化 MiniCore...")

        # 延迟导入避免循环依赖
        from app.core.tts_adapter import TTSService
        from app.core.media_adapter import MediaService
        from app.core.video_adapter import VideoService
        from app.core.frame_adapter import FrameProcessor

        self.tts = TTSService(self.config, core=self)
        self.media = MediaService(self.config, core=self)
        self.video = VideoService()
        self.frame_processor = FrameProcessor(self)

        self._initialized = True
        logger.info("MiniCore 初始化完成（tts / media / video / frame_processor）")

    async def cleanup(self) -> None:
        """清理资源（关闭 ComfyKit 会话）。"""
        if self._comfykit:
            logger.info("正在关闭 ComfyKit 会话...")
            try:
                await self._comfykit.close()
                logger.info("ComfyKit 会话已关闭")
            except Exception as e:
                logger.error(f"关闭 ComfyKit 失败: {e}")
            finally:
                self._comfykit = None
                self._comfykit_config_hash = None

    # ------------------------------------------------------------------
    # 异步上下文管理器
    # ------------------------------------------------------------------

    async def __aenter__(self) -> "MiniCore":
        await self.initialize()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.cleanup()

    # ------------------------------------------------------------------
    # 调试
    # ------------------------------------------------------------------

    def __repr__(self) -> str:
        return (
            f"<MiniCore initialized={self._initialized} "
            f"comfykit_ready={self.comfykit_ready}>"
        )
