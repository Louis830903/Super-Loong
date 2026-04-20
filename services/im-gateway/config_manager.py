"""
Super Agent IM Gateway - 配置管理器

对标 OpenClaw 的分层配置策略：
1. 默认值（代码内置）
2. 配置文件（gateway_config.json）
3. 环境变量覆盖（.env）
4. 运行时 API 动态修改

功能：
- 启动时校验必需配置项（缺失时明确报错）
- 支持运行时通过 API 修改巡检间隔等参数
- 配置变更自动记录审计日志
"""

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

from structured_logger import create_logger

logger = create_logger("gateway.config")

# 配置文件路径（与 gateway_state.json 同目录）
_CONFIG_DIR = Path(__file__).parent
_CONFIG_FILE = _CONFIG_DIR / "gateway_config.json"


@dataclass
class GatewayConfig:
    """网关配置 — 所有可调参数的单一来源"""

    # ── 网络 ──────────────────────────────────────────────
    port: int = 8642
    api_url: str = "http://localhost:3001"
    api_key: str = ""
    cors_origins: list = field(default_factory=lambda: ["http://localhost:3000", "http://localhost:5173"])

    # ── 健康巡检 ─────────────────────────────────────────
    health_check_interval_minutes: int = 5
    stale_event_threshold_minutes: int = 30
    startup_grace_seconds: int = 60
    connect_grace_seconds: int = 120

    # ── 重连与重启 ───────────────────────────────────────
    max_restarts_per_hour: int = 10
    backoff_base_ms: int = 5000
    backoff_max_ms: int = 300_000  # 5 分钟
    backoff_factor: float = 2.0
    backoff_jitter: float = 0.1
    max_reconnect_attempts: int = 10

    # ── Bridge 重试 ──────────────────────────────────────
    bridge_max_retries: int = 3
    bridge_timeout: float = 120.0

    # ── 日志 ─────────────────────────────────────────────
    log_format: str = "text"  # "json" / "text"
    log_level: str = "INFO"

    # ── 功能开关 ─────────────────────────────────────────
    weclaw_enabled: bool = True

    def to_dict(self) -> dict:
        """转为可序列化字典（脱敏 api_key）"""
        d = asdict(self)
        if d.get("api_key"):
            v = d["api_key"]
            d["api_key"] = f"{v[:4]}***{v[-4:]}" if len(v) > 8 else "***"
        return d


# ─── 环境变量映射 ────────────────────────────────────────────
# 键: GatewayConfig 字段名, 值: 环境变量名
_ENV_MAP: dict[str, str] = {
    "port": "IM_GATEWAY_PORT",
    "api_url": "SUPER_AGENT_API_URL",
    "api_key": "SUPER_AGENT_API_KEY",
    "cors_origins": "CORS_ORIGINS",
    "health_check_interval_minutes": "HEALTH_CHECK_INTERVAL_MINUTES",
    "stale_event_threshold_minutes": "STALE_EVENT_THRESHOLD_MINUTES",
    "startup_grace_seconds": "STARTUP_GRACE_SECONDS",
    "connect_grace_seconds": "CONNECT_GRACE_SECONDS",
    "max_restarts_per_hour": "MAX_RESTARTS_PER_HOUR",
    "backoff_base_ms": "BACKOFF_BASE_MS",
    "backoff_max_ms": "BACKOFF_MAX_MS",
    "max_reconnect_attempts": "MAX_RECONNECT_ATTEMPTS",
    "bridge_max_retries": "BRIDGE_MAX_RETRIES",
    "bridge_timeout": "BRIDGE_TIMEOUT",
    "log_format": "LOG_FORMAT",
    "log_level": "LOG_LEVEL",
    "weclaw_enabled": "WECLAW_ENABLED",
}


def _parse_env_value(field_name: str, env_value: str, default: Any) -> Any:
    """根据字段默认值的类型，将环境变量字符串转换为正确的 Python 类型"""
    if isinstance(default, bool):
        return env_value.lower() in ("true", "1", "yes")
    elif isinstance(default, int):
        try:
            return int(env_value)
        except ValueError:
            logger.warning("环境变量类型错误", field=field_name, value=env_value, expected="int")
            return default
    elif isinstance(default, float):
        try:
            return float(env_value)
        except ValueError:
            logger.warning("环境变量类型错误", field=field_name, value=env_value, expected="float")
            return default
    elif isinstance(default, list):
        # 逗号分隔列表
        return [s.strip() for s in env_value.split(",") if s.strip()]
    return env_value


def _load_from_file() -> dict:
    """从 gateway_config.json 加载配置"""
    if not _CONFIG_FILE.exists():
        return {}
    try:
        with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        logger.info("配置文件已加载", path=str(_CONFIG_FILE))
        return data
    except Exception as e:
        logger.warning("配置文件加载失败，使用默认值", error=str(e))
        return {}


def _save_to_file(config: GatewayConfig) -> None:
    """将配置保存到 gateway_config.json"""
    try:
        data = asdict(config)
        # 不持久化敏感字段
        data.pop("api_key", None)
        with open(_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("配置文件已保存", path=str(_CONFIG_FILE))
    except Exception as e:
        logger.error("配置文件保存失败", error=str(e))


def load_config() -> GatewayConfig:
    """
    分层加载配置：默认值 → 配置文件 → 环境变量

    优先级：环境变量 > 配置文件 > 默认值
    """
    config = GatewayConfig()
    defaults = asdict(config)

    # 层 2: 配置文件覆盖
    file_data = _load_from_file()
    for key, value in file_data.items():
        if hasattr(config, key):
            setattr(config, key, value)

    # 层 3: 环境变量覆盖（最高优先级）
    for field_name, env_name in _ENV_MAP.items():
        env_value = os.environ.get(env_name)
        if env_value is not None:
            default = defaults.get(field_name)
            parsed = _parse_env_value(field_name, env_value, default)
            setattr(config, field_name, parsed)

    # 兼容旧环境变量名
    if not config.api_key:
        config.api_key = os.environ.get("SUPER_AGENT_API_KEY", "")
    default_agent = os.environ.get("DEFAULT_AGENT_ID", "")

    logger.info("配置加载完成",
                port=config.port,
                api_url=config.api_url,
                log_format=config.log_format,
                health_interval=config.health_check_interval_minutes)

    return config


def update_config(config: GatewayConfig, updates: dict[str, Any]) -> list[str]:
    """
    运行时动态更新配置（通过 API 调用）

    Args:
        config: 当前配置实例
        updates: 要更新的字段字典

    Returns:
        变更记录列表（用于审计日志）
    """
    changes: list[str] = []
    # 不允许运行时修改的字段
    immutable_fields = {"port", "api_url", "api_key"}

    for key, new_value in updates.items():
        if key in immutable_fields:
            logger.warning("拒绝运行时修改不可变字段", field=key)
            continue
        if not hasattr(config, key):
            logger.warning("忽略未知配置字段", field=key)
            continue

        old_value = getattr(config, key)
        if old_value != new_value:
            setattr(config, key, new_value)
            change_msg = f"{key}: {old_value} → {new_value}"
            changes.append(change_msg)
            logger.info("配置已更新", field=key, old=old_value, new=new_value)

    # 持久化变更
    if changes:
        _save_to_file(config)

    return changes


def validate_config(config: GatewayConfig) -> list[str]:
    """
    校验配置有效性

    Returns:
        错误信息列表，为空表示校验通过
    """
    errors: list[str] = []

    if config.port < 1 or config.port > 65535:
        errors.append(f"port 超出有效范围: {config.port}")

    if config.health_check_interval_minutes < 1:
        errors.append(f"health_check_interval_minutes 必须 >= 1: {config.health_check_interval_minutes}")

    if config.max_restarts_per_hour < 0:
        errors.append(f"max_restarts_per_hour 不能为负: {config.max_restarts_per_hour}")

    if config.backoff_base_ms < 100:
        errors.append(f"backoff_base_ms 过小 (最低 100ms): {config.backoff_base_ms}")

    if config.bridge_timeout < 5.0:
        errors.append(f"bridge_timeout 过短 (最低 5s): {config.bridge_timeout}")

    if config.log_format not in ("json", "text"):
        errors.append(f"log_format 必须是 'json' 或 'text': {config.log_format}")

    if errors:
        for err in errors:
            logger.error("配置校验失败", detail=err)

    return errors
