"""
Super Agent IM Gateway - 网关状态持久化

功能：
- 进程启动时写入 PID + 启动时间
- 每次健康巡检后更新状态文件
- 进程意外退出后，下次启动可读取上次状态恢复上下文
- 支持 API 端点查询历史状态

设计决策：使用独立 JSON 文件而非 SQLite，避免跨进程锁竞争。
"""

import json
import os
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from structured_logger import create_logger

logger = create_logger("gateway.state")

# 状态文件路径（统一存储到 data/ 目录，避免触发 Uvicorn reload）
_STATE_DIR = Path(__file__).parent / "data"
_STATE_FILE = _STATE_DIR / "gateway_state.json"


@dataclass
class AdapterState:
    """单个适配器的持久化状态"""
    platform: str
    status: str = "not_running"  # connected / disconnected / reconnecting / error / stopped / not_running
    connected_at: Optional[str] = None  # ISO8601
    last_event_at: Optional[str] = None  # ISO8601
    last_error: Optional[str] = None
    restart_count: int = 0
    manually_stopped: bool = False


@dataclass
class GatewayState:
    """网关状态持久化管理"""
    pid: int = 0
    started_at: str = ""  # ISO8601
    adapters: dict[str, dict] = field(default_factory=dict)  # platform -> AdapterState dict
    last_health_check: str = ""  # ISO8601
    restart_counts: dict[str, int] = field(default_factory=dict)  # platform -> 累计重启次数
    last_saved_at: str = ""  # ISO8601

    def to_dict(self) -> dict:
        """转为可序列化字典"""
        return asdict(self)


class StateManager:
    """
    网关状态管理器

    负责状态的读写和生命周期管理。
    所有写操作都是原子性的（先写临时文件再 rename）。
    """

    def __init__(self, state_file: Path = _STATE_FILE):
        self._state_file = state_file
        self._state = GatewayState()
        self._dirty = False

    @property
    def state(self) -> GatewayState:
        return self._state

    def initialize(self) -> None:
        """进程启动时初始化状态"""
        # 确保 data 目录存在
        self._state_file.parent.mkdir(parents=True, exist_ok=True)
        # 尝试加载上次状态
        previous = self._load()
        if previous:
            old_pid = previous.get("pid", 0)
            old_started = previous.get("started_at", "")
            logger.info("检测到上次运行状态",
                        old_pid=old_pid,
                        old_started_at=old_started,
                        adapters=list(previous.get("adapters", {}).keys()))
            # 保留历史重启计数
            self._state.restart_counts = previous.get("restart_counts", {})

        # 写入当前进程信息
        self._state.pid = os.getpid()
        self._state.started_at = _now_iso()
        self._state.adapters = {}
        self._state.last_health_check = ""
        self._save()
        logger.info("网关状态已初始化", pid=self._state.pid)

    def update_adapter(self, platform: str, **kwargs: Any) -> None:
        """更新单个适配器的状态"""
        if platform not in self._state.adapters:
            self._state.adapters[platform] = asdict(AdapterState(platform=platform))

        adapter_state = self._state.adapters[platform]
        for key, value in kwargs.items():
            if key in adapter_state:
                adapter_state[key] = value

        self._dirty = True

    def record_adapter_connected(self, platform: str) -> None:
        """记录适配器已连接"""
        self.update_adapter(platform,
                            status="connected",
                            connected_at=_now_iso(),
                            last_error=None,
                            manually_stopped=False)
        self.flush()

    def record_adapter_disconnected(self, platform: str, error: Optional[str] = None, manual: bool = False) -> None:
        """记录适配器已断开"""
        status = "stopped" if manual else ("error" if error else "disconnected")
        self.update_adapter(platform,
                            status=status,
                            last_error=error,
                            manually_stopped=manual)
        self.flush()

    def record_adapter_reconnecting(self, platform: str, attempt: int) -> None:
        """记录适配器正在重连"""
        self.update_adapter(platform, status="reconnecting")
        # 累加全局重启计数
        self._state.restart_counts[platform] = self._state.restart_counts.get(platform, 0) + 1
        self._dirty = True

    def record_adapter_event(self, platform: str) -> None:
        """记录适配器收到事件（更新 last_event_at）"""
        self.update_adapter(platform, last_event_at=_now_iso())
        # 事件频率高，不立即 flush，由巡检周期或定时器触发

    def record_health_check(self) -> None:
        """记录健康巡检完成"""
        self._state.last_health_check = _now_iso()
        self._dirty = True
        self.flush()

    def get_adapter_state(self, platform: str) -> Optional[dict]:
        """获取单个适配器状态"""
        return self._state.adapters.get(platform)

    def get_snapshot(self) -> dict:
        """获取完整状态快照（用于 API 返回）"""
        return {
            "pid": self._state.pid,
            "started_at": self._state.started_at,
            "uptime_seconds": _uptime_seconds(self._state.started_at),
            "adapters": self._state.adapters,
            "last_health_check": self._state.last_health_check,
            "restart_counts": self._state.restart_counts,
        }

    def flush(self) -> None:
        """将脏数据写入磁盘"""
        if self._dirty or True:  # 关键节点始终写入
            self._save()
            self._dirty = False

    def cleanup(self) -> None:
        """进程关闭时更新状态"""
        for platform, adapter in self._state.adapters.items():
            if adapter.get("status") == "connected":
                adapter["status"] = "not_running"
        self._save()
        logger.info("网关状态已清理")

    # ── 内部方法 ─────────────────────────────────────────

    def _save(self) -> None:
        """原子写入状态文件"""
        self._state.last_saved_at = _now_iso()
        data = self._state.to_dict()
        tmp_file = self._state_file.with_suffix(".tmp")
        try:
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            # 原子替换（Windows 需要先删除目标文件）
            if os.name == "nt" and self._state_file.exists():
                self._state_file.unlink()
            tmp_file.rename(self._state_file)
        except Exception as e:
            logger.error("状态文件写入失败", error=str(e))
            # 降级: 直接写入
            try:
                with open(self._state_file, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
            except Exception as e2:
                logger.error("状态文件降级写入也失败", error=str(e2))

    def _load(self) -> Optional[dict]:
        """从文件加载状态"""
        if not self._state_file.exists():
            return None
        try:
            with open(self._state_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning("状态文件读取失败", error=str(e))
            return None


# ─── 工具函数 ────────────────────────────────────────────────

def _now_iso() -> str:
    """当前 UTC 时间的 ISO8601 字符串"""
    return datetime.now(timezone.utc).isoformat()


def _uptime_seconds(started_at: str) -> float:
    """计算运行时长（秒）"""
    if not started_at:
        return 0.0
    try:
        start = datetime.fromisoformat(started_at)
        now = datetime.now(timezone.utc)
        return (now - start).total_seconds()
    except Exception:
        return 0.0
