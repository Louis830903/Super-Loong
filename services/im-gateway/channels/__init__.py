"""
渠道插件自动注册

启动时调用 register_all_channels(registry) 注册所有已实现的渠道。
新增渠道只需在此导入并调用 register 即可。
"""

from core.registry import ChannelRegistry


def register_all_channels(registry: ChannelRegistry) -> None:
    """注册所有渠道插件到 Registry"""
    # 逐一导入渠道 plugin 模块，避免未安装依赖的渠道阻断其他渠道注册
    _safe_register(registry, "channels.dingtalk.plugin", "create_plugin")
    _safe_register(registry, "channels.wecom.plugin", "create_plugin")
    _safe_register(registry, "channels.feishu.plugin", "create_plugin")
    _safe_register(registry, "channels.weixin.plugin", "create_plugin")


def _safe_register(registry: ChannelRegistry, module_path: str, factory_fn: str) -> None:
    """安全注册：单个渠道导入失败不阻断其他渠道"""
    try:
        import importlib
        mod = importlib.import_module(module_path)
        factory = getattr(mod, factory_fn)
        plugin = factory()
        registry.register(plugin)
    except ImportError as e:
        import logging
        logging.getLogger("gateway.channels").warning(
            "渠道 %s 依赖缺失，跳过注册: %s", module_path, e
        )
    except Exception as e:
        import logging
        logging.getLogger("gateway.channels").error(
            "渠道 %s 注册失败: %s", module_path, e
        )
