"""
渠道配置持久化 — JSON 文件存储

管理各渠道的运行时配置（凭证、设置），
替代原来通过环境变量传入的配置方式。

持久化路径：{im-gateway}/data/channel_configs.json
原子写入：先写临时文件再 rename（与 gateway_state.py 策略一致）
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

from core.types import ChannelConfig

logger = logging.getLogger("gateway.config_persistence")

# 默认存储路径（im-gateway 目录下的 data/）
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_CONFIG_FILE = _DATA_DIR / "channel_configs.json"


class ConfigPersistence:
    """
    渠道配置持久化管理器

    职责：
    - 保存/加载各渠道的 ChannelConfig
    - 原子写入防止数据损坏
    - 敏感字段不做额外加密（依赖文件系统权限）
    """

    def __init__(self, config_file: Path = _CONFIG_FILE):
        self._config_file = config_file
        self._configs: dict[str, dict] = {}  # channel_id -> serialized config
        self._ensure_data_dir()

    def _ensure_data_dir(self) -> None:
        """确保 data 目录存在"""
        self._config_file.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> dict[str, ChannelConfig]:
        """
        从 JSON 文件加载所有渠道配置

        Returns:
            channel_id -> ChannelConfig 字典
        """
        if not self._config_file.exists():
            logger.info("配置文件不存在，返回空配置: %s", self._config_file)
            return {}

        try:
            with open(self._config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._configs = data
            result = {}
            for channel_id, cfg_dict in data.items():
                result[channel_id] = ChannelConfig(
                    channel_id=cfg_dict.get("channel_id", channel_id),
                    account_id=cfg_dict.get("account_id", "default"),
                    credentials=cfg_dict.get("credentials", {}),
                    settings=cfg_dict.get("settings", {}),
                    enabled=cfg_dict.get("enabled", True),
                )
            logger.info("已加载 %d 个渠道配置", len(result))
            return result
        except Exception as e:
            logger.error("加载渠道配置失败: %s", e)
            return {}

    def save(self, channel_id: str, config: ChannelConfig) -> None:
        """保存单个渠道配置"""
        self._configs[channel_id] = {
            "channel_id": config.channel_id,
            "account_id": config.account_id,
            "credentials": config.credentials,
            "settings": config.settings,
            "enabled": config.enabled,
        }
        self._flush()
        logger.info("渠道配置已保存: %s", channel_id)

    def remove(self, channel_id: str) -> bool:
        """删除渠道配置"""
        if channel_id in self._configs:
            del self._configs[channel_id]
            self._flush()
            logger.info("渠道配置已删除: %s", channel_id)
            return True
        return False

    def get(self, channel_id: str) -> Optional[ChannelConfig]:
        """获取单个渠道配置"""
        cfg_dict = self._configs.get(channel_id)
        if not cfg_dict:
            return None
        return ChannelConfig(
            channel_id=cfg_dict.get("channel_id", channel_id),
            account_id=cfg_dict.get("account_id", "default"),
            credentials=cfg_dict.get("credentials", {}),
            settings=cfg_dict.get("settings", {}),
            enabled=cfg_dict.get("enabled", True),
        )

    def list_channel_ids(self) -> list[str]:
        """列出所有已配置的渠道 ID"""
        return list(self._configs.keys())

    def _flush(self) -> None:
        """原子写入：先写临时文件再 rename"""
        tmp_file = self._config_file.with_suffix(".tmp")
        try:
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(self._configs, f, ensure_ascii=False, indent=2)
            # Windows 需要先删除目标文件
            if self._config_file.exists():
                os.unlink(self._config_file)
            os.rename(tmp_file, self._config_file)
        except Exception as e:
            logger.error("写入配置文件失败: %s", e)
            if tmp_file.exists():
                try:
                    os.unlink(tmp_file)
                except OSError:
                    pass

    def migrate_from_env(self, env_configs: dict[str, dict[str, str]]) -> int:
        """
        从环境变量配置迁移到 JSON（5.3 配置迁移路径）

        Args:
            env_configs: {channel_id: {key: value}} 从环境变量解析出的配置

        Returns:
            成功迁移的渠道数量
        """
        migrated = 0
        for channel_id, creds in env_configs.items():
            if channel_id not in self._configs:
                self._configs[channel_id] = {
                    "channel_id": channel_id,
                    "account_id": "default",
                    "credentials": creds,
                    "settings": {},
                    "enabled": True,
                }
                migrated += 1
                logger.info("环境变量配置已迁移: %s", channel_id)
        if migrated:
            self._flush()
            logger.info("配置迁移完成: %d 个渠道", migrated)
        return migrated

