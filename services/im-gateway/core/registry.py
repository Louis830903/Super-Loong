"""
渠道注册表 — 替代 if-elif 工厂

对标 OpenClaw defineBundledChannelEntry() 声明式注册机制。
所有渠道插件通过 register() 注册到单例 Registry，
server.py 启动时调用 register_all_channels() 完成注册。
"""

from typing import Optional

from core.contracts import ChannelPlugin


class ChannelRegistry:
    """渠道注册表 — 单例模式"""

    _instance: Optional["ChannelRegistry"] = None

    def __init__(self):
        self._plugins: dict[str, ChannelPlugin] = {}

    @classmethod
    def get_instance(cls) -> "ChannelRegistry":
        """获取全局单例"""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        """重置单例（测试用）"""
        cls._instance = None

    def register(self, plugin: ChannelPlugin) -> None:
        """注册渠道插件"""
        if plugin.id in self._plugins:
            raise ValueError(f"渠道 '{plugin.id}' 已注册，不允许重复注册")
        self._plugins[plugin.id] = plugin

    def unregister(self, channel_id: str) -> bool:
        """注销渠道插件，返回是否成功"""
        return self._plugins.pop(channel_id, None) is not None

    def get(self, channel_id: str) -> Optional[ChannelPlugin]:
        """获取渠道插件"""
        return self._plugins.get(channel_id)

    def has(self, channel_id: str) -> bool:
        """检查渠道是否已注册"""
        return channel_id in self._plugins

    def list_ids(self) -> list[str]:
        """列出所有已注册渠道 ID"""
        return list(self._plugins.keys())

    def list_schemas(self) -> list[dict]:
        """列出所有渠道的配置 Schema（给前端 API）"""
        return [p.config_schema.to_dict() for p in self._plugins.values()]

    def list_plugins(self) -> list[ChannelPlugin]:
        """列出所有渠道插件"""
        return list(self._plugins.values())

    def count(self) -> int:
        """已注册渠道数量"""
        return len(self._plugins)
