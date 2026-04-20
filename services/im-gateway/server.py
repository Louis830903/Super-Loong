"""
Super Agent IM Gateway - FastAPI 主服务（OpenClaw 声明式插件架构 v2）

替代旧的 Hermes 适配器架构：
- ChannelRegistry 替代 if-elif 工厂
- ChannelPlugin 替代 adapter_manager 单体管理
- MessagePipeline 替代手工 message_handler
- ConfigPersistence 替代 env vars
- Session flush loop (G2) 激活进化引擎
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from typing import Dict, Any, Optional

from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
import traceback as _tb

# ── 基建模块：配置 + 日志 + 状态 ────────────────────
from config_manager import load_config, validate_config, GatewayConfig
from structured_logger import setup_logging, create_logger, new_trace_id
from gateway_state import StateManager
from health_monitor import HealthMonitor
from reconnect import ReconnectEngine
from bridge import AgentBridge, BridgeConfig

# ── 新架构：Registry + Pipeline + Persistence + AgentRouter ────
from core.registry import ChannelRegistry
from core.dedup import MessageDeduplicator
from core.message_pipeline import MessagePipeline
from core.config_persistence import ConfigPersistence
from core.session_manager import SessionManager
from core.agent_router import AgentRouter
from core.types import (
    ChannelConfig, MessageEvent, SessionKeyStrategy,
)
from core.attachment_processor import process_attachments, classify_attachment, cleanup_cache
from channels import register_all_channels

# ── 配置加载 + 日志初始化 ─────────────────────────
gateway_config: GatewayConfig = load_config()

errors = validate_config(gateway_config)
if errors:
    print(f"[FATAL] 配置校验失败: {errors}", file=sys.stderr)
    sys.exit(1)

setup_logging(log_format=gateway_config.log_format, level=gateway_config.log_level)
logger = create_logger("gateway.server")

# ── 全局实例 ───────────────────────────────────────
state_manager = StateManager()
reconnect_engine = ReconnectEngine(gateway_config)

bridge = AgentBridge(
    BridgeConfig(
        api_base_url=gateway_config.api_url,
        api_key=gateway_config.api_key,
        default_agent_id=os.environ.get("DEFAULT_AGENT_ID", ""),
        timeout=gateway_config.bridge_timeout,
        max_retries=gateway_config.bridge_max_retries,
    )
)

# ── 新架构实例 ────────────────────────────────────
registry = ChannelRegistry.get_instance()
config_persistence = ConfigPersistence()
dedup = MessageDeduplicator()
agent_router = AgentRouter(
    default_agent_id=os.environ.get("DEFAULT_AGENT_ID", ""),
)
session_manager = SessionManager(
    default_agent_id=os.environ.get("DEFAULT_AGENT_ID", ""),
)
pipeline = MessagePipeline(
    bridge=bridge,
    dedup=dedup,
    session_manager=session_manager,
    registry=registry,  # 用于出站回复发送
    agent_router=agent_router,  # 三级规则链路由
)

# 健康巡检（适配新架构，传入 registry + config_persistence）
health_monitor = HealthMonitor(
    gateway_config, state_manager,
    registry=registry,
    config_persistence=config_persistence,
)

# 活跃连接跟踪：channel_id -> ChannelConfig（当前已启动的渠道）
_active_channels: dict[str, ChannelConfig] = {}


# ── 虚拟 URI 解析（A-0-②）──────────────────────────

async def _resolve_media_urls(
    media_urls: list[str],
    media_types: list[str],
    msg_id: str = "",
    gateway: object = None,
) -> tuple[list[str], list[str]]:
    """
    将虚拟 URI（feishu://image/xxx、feishu://file/xxx）解析为本地临时文件路径。
    普通本地路径和 HTTP URL 原样保留。
    """
    resolved_urls: list[str] = []
    resolved_types: list[str] = []

    for i, url in enumerate(media_urls):
        mime = media_types[i] if i < len(media_types) else ""

        if url.startswith("feishu://"):
            # 解析: feishu://image/{key} | feishu://file/{key} | feishu://audio/{key}
            parts = url.replace("feishu://", "").split("/", 1)
            resource_type = parts[0]  # image | file | audio
            file_key = parts[1] if len(parts) > 1 else ""

            if not file_key or not gateway or not msg_id:
                logger.warning("无法解析飞书虚拟URI (缺少 file_key/gateway/msg_id): %s", url)
                continue

            if not hasattr(gateway, "download_resource"):
                logger.warning("网关不支持文件下载: %s", url)
                continue

            # download_resource 是同步方法（lark_oapi SDK），必须在线程池中执行
            try:
                loop = asyncio.get_running_loop()
                local_path = await loop.run_in_executor(
                    None,
                    gateway.download_resource,
                    msg_id,
                    file_key,
                    resource_type,
                )
                if local_path:
                    resolved_urls.append(local_path)
                    resolved_types.append(mime)
                else:
                    logger.warning("飞书资源下载失败: %s", url)
            except Exception as e:
                logger.error("飞书资源下载异常: %s — %s", url, e)
        else:
            # 本地文件路径或 HTTP URL，原样保留
            resolved_urls.append(url)
            resolved_types.append(mime)

    return resolved_urls, resolved_types


# ── 消息处理器：绑定到各渠道 InboundAdapter ──────────
async def _make_message_handler(channel_id: str):
    """为指定渠道创建消息处理回调"""
    plugin = registry.get(channel_id)
    if not plugin:
        return

    async def handler(event: MessageEvent):
        """渠道消息回调 → Pipeline 四级管道处理"""
        # 语音消息自动转文字
        voice_transcripts = []
        for i, url in enumerate(event.media_urls):
            mtype = event.media_types[i] if i < len(event.media_types) else ""
            if mtype.startswith("audio/"):
                logger.info(f"[{channel_id}] 转录语音: {url}")

                # 解析 feishu:// 协议 URL → 先通过飞书 API 下载到本地再转写
                actual_path = url
                if url.startswith("feishu://audio/"):
                    file_key = url.split("/")[-1]
                    gateway = plugin.gateway_adapter
                    if hasattr(gateway, "download_resource") and event.msg_id:
                        # download_resource 是同步方法（lark_oapi SDK），需在线程池中执行
                        loop = asyncio.get_running_loop()
                        local_path = await loop.run_in_executor(
                            None, gateway.download_resource, event.msg_id, file_key,
                        )
                        if local_path:
                            actual_path = local_path
                            logger.info(f"[{channel_id}] 飞书语音文件已下载: {local_path}")
                        else:
                            logger.warning(f"[{channel_id}] 飞书语音文件下载失败: {url}")
                            voice_transcripts.append(None)
                            continue
                    else:
                        logger.warning(f"[{channel_id}] 网关不支持文件下载或缺少 msg_id: {url}")
                        voice_transcripts.append(None)
                        continue

                transcript = await bridge.transcribe_audio(actual_path)
                voice_transcripts.append(transcript or None)

                # 清理下载的临时文件（转写完成后不再需要）
                if actual_path != url and os.path.isfile(actual_path):
                    try:
                        os.unlink(actual_path)
                    except OSError:
                        pass

        if voice_transcripts:
            parts = []
            for t in voice_transcripts:
                if t:
                    parts.append(f'[用户发送了一条语音消息，内容是: "{t}"]')
                else:
                    parts.append("[用户发送了一条语音消息，但转写失败]")
            prefix = "\n\n".join(parts)
            event.text = f"{prefix}\n\n{event.text}" if event.text else prefix

        # ── A-0-② + A-2: 统一附件处理（文档注入 + 图片 base64）────────
        if event.media_urls:
            # A-0-②: 先解析虚拟 URI（feishu://、weixin://）为本地路径
            resolved_urls, resolved_types = await _resolve_media_urls(
                event.media_urls, event.media_types,
                msg_id=event.msg_id,
                gateway=plugin.gateway_adapter,
            )

            # 过滤掉已经由 STT 处理的音频文件
            non_audio_urls = []
            non_audio_types = []
            for i, url in enumerate(resolved_urls):
                mtype = resolved_types[i] if i < len(resolved_types) else ""
                kind = classify_attachment(url, mtype)
                if kind != "audio":  # 音频已在上面的 STT 转写中处理
                    non_audio_urls.append(url)
                    non_audio_types.append(mtype)

            if non_audio_urls:
                enriched_text, images = await process_attachments(
                    non_audio_urls, non_audio_types, event.text,
                    api_base=bridge.config.api_base_url,
                )
                event.text = enriched_text
                # images 暂存到 event.raw 供 Phase B 图片视觉链路使用
                if images:
                    # event.raw 可能是飞书 SDK 对象（非 dict），不能用 ** 解包
                    if isinstance(event.raw, dict):
                        event.raw["_images"] = images
                    else:
                        event.raw = {"_images": images}

        logger.info(f"[{channel_id}] 消息: user={event.source.user_id} chat={event.source.chat_id} text={event.text[:50] if event.text else ''}...")

        try:
            await pipeline.process(channel_id, event, capabilities=plugin.capabilities)
        except Exception as exc:
            logger.error(f"[{channel_id}] Pipeline 处理异常: {exc}", exc_info=True)

    plugin.inbound_adapter.set_message_handler(handler)


async def _connect_channel(channel_id: str, config: ChannelConfig) -> bool:
    """连接指定渠道（内部统一逻辑）
    
    顶层 try/except 兜底：确保任何未预期异常都被捕获并记录到
    gateway_adapter.last_error，避免 Starlette 返回纯文本 500。
    """
    plugin = registry.get(channel_id)
    if not plugin:
        logger.error(f"渠道未注册: {channel_id}")
        return False

    try:
        # 配置验证
        error = plugin.config_adapter.validate(config.credentials)
        if error:
            logger.error(f"渠道 {channel_id} 配置无效: {error}")
            return False

        # 设置消息处理器
        await _make_message_handler(channel_id)

        # 配置 outbound（如果有 configure 方法）
        if hasattr(plugin.outbound_adapter, "configure"):
            plugin.outbound_adapter.configure(config)

        # 启动网关连接
        success = await plugin.gateway_adapter.start(config)
        if success:
            _active_channels[channel_id] = config
            logger.info(f"渠道 {channel_id} 已连接")
            # 延迟持久化：等 HTTP 响应完成后再写文件，避免 Uvicorn reload 中断响应
            asyncio.create_task(_deferred_save(channel_id, config))
        else:
            last_err = plugin.gateway_adapter.last_error or "未知错误"
            logger.warning(f"渠道 {channel_id} 连接失败: {last_err}")

        return success
    except Exception as e:
        # 兜底：将未预期异常记录到 last_error，防止冒泡为 Starlette 纯文本 500
        err_msg = f"连接过程中发生未预期异常: {type(e).__name__}: {e}"
        logger.error(f"渠道 {channel_id} {err_msg}", exc_info=True)
        try:
            plugin.gateway_adapter._last_error = err_msg
        except Exception:
            pass  # 安全设置 last_error，即使属性不存在也不崩溃
        return False


async def _deferred_save(channel_id: str, config: ChannelConfig):
    """延迟保存配置 — 等待 HTTP 响应完成后再写入文件"""
    await asyncio.sleep(1.0)
    try:
        config_persistence.save(channel_id, config)
    except Exception as e:
        logger.error(f"延迟保存渠道 {channel_id} 配置失败: {e}")


async def _disconnect_channel(channel_id: str) -> bool:
    """断开指定渠道"""
    plugin = registry.get(channel_id)
    if not plugin:
        return False

    await plugin.gateway_adapter.stop()
    _active_channels.pop(channel_id, None)

    # 生命周期钩子：on_account_removed
    if plugin.lifecycle_adapter:
        try:
            config = config_persistence.get(channel_id) or ChannelConfig(channel_id=channel_id)
            await plugin.lifecycle_adapter.on_account_removed(config)
        except Exception as e:
            logger.error(f"渠道 {channel_id} lifecycle on_account_removed 失败: {e}")

    # 关闭 outbound HTTP 客户端（防止连接泄漏）
    if hasattr(plugin.outbound_adapter, "close") and callable(plugin.outbound_adapter.close):
        try:
            await plugin.outbound_adapter.close()
        except Exception as e:
            logger.warning(f"渠道 {channel_id} outbound close 异常: {e}")

    logger.info(f"渠道 {channel_id} 已断开")
    return True


# ── 配置迁移：env vars → JSON（6.9）────────────────
def _migrate_env_configs() -> int:
    """从环境变量迁移配置到 JSON 持久化（仅首次）"""
    env_map: dict[str, dict[str, str]] = {}

    # 企业微信
    if os.environ.get("WECOM_BOT_ID"):
        env_map["wecom"] = {
            "corp_id": os.environ.get("WECOM_CORP_ID", ""),
            "app_secret": os.environ.get("WECOM_SECRET", ""),
            "agent_id": os.environ.get("WECOM_AGENT_ID", ""),
            "bot_id": os.environ.get("WECOM_BOT_ID", ""),
            "websocket_url": os.environ.get("WECOM_WEBSOCKET_URL", ""),
            "token": os.environ.get("WECOM_TOKEN", ""),
            "encoding_aes_key": os.environ.get("WECOM_ENCODING_AES_KEY", ""),
        }

    # 飞书
    if os.environ.get("FEISHU_APP_ID"):
        env_map["feishu"] = {
            "app_id": os.environ.get("FEISHU_APP_ID", ""),
            "app_secret": os.environ.get("FEISHU_APP_SECRET", ""),
            "verification_token": os.environ.get("FEISHU_VERIFICATION_TOKEN", ""),
            "encrypt_key": os.environ.get("FEISHU_ENCRYPT_KEY", ""),
            "mode": os.environ.get("FEISHU_MODE", "websocket"),
        }

    # 钉钉
    if os.environ.get("DINGTALK_CLIENT_ID"):
        env_map["dingtalk"] = {
            "app_key": os.environ.get("DINGTALK_CLIENT_ID", ""),
            "app_secret": os.environ.get("DINGTALK_CLIENT_SECRET", ""),
            "robot_code": os.environ.get("DINGTALK_ROBOT_CODE", ""),
        }

    # 微信
    if os.environ.get("WEIXIN_API_URL"):
        env_map["weixin"] = {
            "api_url": os.environ.get("WEIXIN_API_URL", ""),
            "api_token": os.environ.get("WEIXIN_API_TOKEN", ""),
        }

    if env_map:
        migrated = config_persistence.migrate_from_env(env_map)
        if migrated:
            logger.info(f"[迁移] {migrated} 个渠道配置已从环境变量迁移到 JSON")
        return migrated
    return 0


async def _auto_connect_from_persistence():
    """从持久化配置自动连接渠道（替代旧的 auto_connect_platforms）"""
    saved_configs = config_persistence.load()
    for channel_id, config in saved_configs.items():
        if not config.enabled:
            continue
        plugin = registry.get(channel_id)
        if not plugin:
            logger.warning(f"持久化配置中的渠道 {channel_id} 未注册，跳过")
            continue
        if not plugin.config_adapter.is_configured(config.credentials):
            logger.warning(f"渠道 {channel_id} 凭证不完整，跳过自动连接")
            continue
        try:
            logger.info(f"自动连接渠道: {channel_id} ({plugin.label})")
            await _connect_channel(channel_id, config)
        except Exception as e:
            logger.error(f"自动连接渠道 {channel_id} 失败: {e}")


# ── G2: Session Flush Loop ────────────────────────
async def _session_flush_loop():
    """每分钟检查空闲 session → POST /api/evolution/flush（G2）"""
    while True:
        await asyncio.sleep(60)
        try:
            idle_sessions = session_manager.get_idle_sessions()
            for s in idle_sessions:
                try:
                    if bridge.is_ready:
                        await bridge.proxy_post(
                            "/api/evolution/flush",
                            json={
                                "agentId": s.agent_id,
                                "messages": [],
                            },
                            timeout=10.0,
                        )
                        logger.info(f"Session flush 完成: {s.session_key} (turns={s.turn_count})")
                except Exception as e:
                    logger.warning(f"Session flush 失败: {s.session_key}, error={e}")
                session_manager.remove_session(s.session_key)
        except Exception as e:
            logger.error(f"Flush loop 异常: {e}")

_flush_task: Optional[asyncio.Task] = None


# ── 应用生命周期 ──────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动 → 运行 → 优雅关闭"""
    global _flush_task

    # ── 启动序列 ───────────────────────────────────
    # 1. 状态持久化初始化
    state_manager.initialize()

    # 2. 注册所有渠道插件
    register_all_channels(registry)
    logger.info(f"已注册 {registry.count()} 个渠道插件: {registry.list_ids()}")

    # 3. 启动桥接器（正式启动协议：等待 API + 获取 Agent + 后台重试）
    # 注入回调：后台获取 Agent 成功时同步到 SessionManager 和 AgentRouter
    def _on_agent_ready(agent_id: str):
        session_manager._default_agent_id = agent_id
        agent_router.default_agent_id = agent_id
        logger.info(f"SessionManager + AgentRouter 默认 Agent 已同步: {agent_id}")
    bridge._on_agent_ready = _on_agent_ready
    await bridge.start()

    # 同步 Bridge 获取到的 Agent ID 到 SessionManager 和 AgentRouter
    if bridge.config.default_agent_id:
        if not session_manager._default_agent_id:
            session_manager._default_agent_id = bridge.config.default_agent_id
        if not agent_router.default_agent_id:
            agent_router.default_agent_id = bridge.config.default_agent_id
        logger.info(f"SessionManager + AgentRouter 默认 Agent 已从 Bridge 同步: {bridge.config.default_agent_id}")

    # 4. 配置迁移（env → JSON，仅首次）
    _migrate_env_configs()

    # 5. 自动连接已持久化的渠道
    await _auto_connect_from_persistence()

    # 6. 启动健康巡检
    await health_monitor.start()

    # 7. 启动 G2 flush loop
    _flush_task = asyncio.create_task(_session_flush_loop())

    # D-2: 启动缓存清理定时任务（学 Hermes cleanup_document_cache）
    async def _cache_cleaner():
        """D-2: 每小时清理过期附件缓存"""
        while True:
            await asyncio.sleep(3600)
            try:
                count = cleanup_cache(max_age_hours=24)
                if count > 0:
                    logger.info(f"清理了 {count} 个过期缓存文件")
            except Exception as e:
                logger.warning(f"缓存清理失败: {e}")
    asyncio.create_task(_cache_cleaner())

    logger.info("IM Gateway 已启动 (v2 OpenClaw 架构)",
                port=gateway_config.port,
                api_url=gateway_config.api_url,
                channels=registry.list_ids())

    yield

    # ── 关闭序列（与启动相反）─────────────────────
    # G9: drain 所有活跃 session
    async def _flush_one(s):
        if bridge.is_ready:
            await bridge.proxy_post(
                "/api/evolution/flush",
                json={"agentId": s.agent_id, "messages": []},
                timeout=10.0,
            )
    await session_manager.drain(flush_callback=_flush_one, timeout_s=30)

    if _flush_task:
        _flush_task.cancel()
        try:
            await _flush_task
        except asyncio.CancelledError:
            pass

    await health_monitor.stop()
    await reconnect_engine.cancel_all()

    # 停止所有活跃渠道
    for channel_id in list(_active_channels.keys()):
        await _disconnect_channel(channel_id)

    await bridge.stop()
    state_manager.cleanup()
    logger.info("IM Gateway 已关闭")


# ── FastAPI 应用 ──────────────────────────────────
app = FastAPI(
    title="Super Agent IM Gateway",
    description="IM 平台网关 — OpenClaw 声明式插件架构 v2",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=gateway_config.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Key 验证中间件
IM_GATEWAY_API_KEY = os.environ.get("IM_GATEWAY_API_KEY", "")

@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    """API Key 验证中间件，跳过健康检查端点"""
    if request.url.path in ("/health", "/docs", "/openapi.json"):
        return await call_next(request)
    if IM_GATEWAY_API_KEY:
        key = request.headers.get("x-api-key", "")
        if key != IM_GATEWAY_API_KEY:
            return JSONResponse(status_code=401, content={"error": "Invalid or missing API key"})
    try:
        return await call_next(request)
    except Exception as exc:
        logger.error(f"请求处理异常: {request.url.path} -> {type(exc).__name__}: {exc}")
        logger.error(_tb.format_exc())
        return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})


# 全局异常兜底：捕获所有未处理的异常
@app.exception_handler(Exception)
async def _global_exc_handler(request: Request, exc: Exception):
    logger.error(f"全局异常: {request.url.path} -> {type(exc).__name__}: {exc}")
    logger.error(_tb.format_exc())
    return JSONResponse(status_code=500, content={"error": f"{type(exc).__name__}: {exc}"})


# ======== API 模型 ========

class ChannelConnectRequest(BaseModel):
    """渠道连接请求（凭证由 Schema 驱动）"""
    credentials: Dict[str, Any] = {}
    settings: Dict[str, Any] = {}

class ChannelSetupRequest(BaseModel):
    """渠道配置向导请求"""
    input_data: Dict[str, Any] = {}

class SendRequest(BaseModel):
    platform: str
    chat_id: str
    message: str
    user_id: str = "api"
    thread_id: str = ""

class BindRequest(BaseModel):
    channel_id: str
    agent_id: str

class RoutingBindRequest(BaseModel):
    """路由绑定请求（三级规则链）"""
    level: str  # "chat" | "user" | "platform"
    platform: str
    target_id: str = ""  # chat_id 或 user_id（platform 级别时为空）
    agent_id: str


# ======== 新架构 API 路由 ========

# ─── Schema 驱动配置 ─────────────────────────────────

@app.get("/api/gateway/channels/schemas")
async def get_channel_schemas():
    """返回所有渠道的配置 Schema — 前端据此自动渲染表单"""
    try:
        return registry.list_schemas()
    except Exception as e:
        logger.error(f"获取渠道 Schema 失败: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(500, f"获取渠道 Schema 失败: {type(e).__name__}: {e}")


@app.get("/api/gateway/channels")
async def list_channels():
    """列出所有已注册渠道及其连接状态"""
    try:
        result = []
        for plugin in registry.list_plugins():
            connected = plugin.gateway_adapter.is_connected
            result.append({
                "id": plugin.id,
                "label": plugin.label,
                "connected": connected,
                "last_error": plugin.gateway_adapter.last_error,
                "has_qr_login": plugin.qr_login_adapter is not None,
                "has_doctor": plugin.doctor_adapter is not None,
                "has_setup": plugin.setup_adapter is not None,
                "capabilities": {
                    "media": plugin.capabilities.media,
                    "threads": plugin.capabilities.threads,
                    "block_streaming": plugin.capabilities.block_streaming,
                },
            })
        return {"channels": result}
    except Exception as e:
        logger.error(f"获取渠道列表失败: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(500, f"获取渠道列表失败: {type(e).__name__}: {e}")


# ─── 连接/断开 ──────────────────────────────────────

@app.post("/api/gateway/channels/{channel_id}/connect")
async def connect_channel(channel_id: str, req: ChannelConnectRequest):
    """连接指定渠道"""
    plugin = registry.get(channel_id)
    if not plugin:
        raise HTTPException(404, f"渠道未注册: {channel_id}")

    # 配置验证
    error = plugin.config_adapter.validate(req.credentials)
    if error:
        raise HTTPException(400, error)

    config = ChannelConfig(
        channel_id=channel_id,
        credentials=req.credentials,
        settings=req.settings,
    )
    success = await _connect_channel(channel_id, config)
    if not success:
        err = plugin.gateway_adapter.last_error or "连接失败"
        raise HTTPException(400, err)

    return {"success": True, "channel": channel_id}


@app.post("/api/gateway/channels/{channel_id}/disconnect")
async def disconnect_channel(channel_id: str):
    """断开指定渠道"""
    plugin = registry.get(channel_id)
    if not plugin:
        raise HTTPException(404, f"渠道未注册: {channel_id}")

    await reconnect_engine.cancel_reconnect(channel_id)
    await _disconnect_channel(channel_id)
    return {"success": True, "channel": channel_id}


# ─── 渠道状态 ──────────────────────────────────────

@app.get("/api/gateway/channels/{channel_id}/status")
async def channel_status(channel_id: str):
    """查询渠道详细状态"""
    plugin = registry.get(channel_id)
    if not plugin:
        raise HTTPException(404, f"渠道未注册: {channel_id}")

    result = {
        "channel": channel_id,
        "connected": plugin.gateway_adapter.is_connected,
        "last_error": plugin.gateway_adapter.last_error,
    }

    # StatusAdapter 主动探测（如果支持）
    if plugin.status_adapter and channel_id in _active_channels:
        try:
            probe = await plugin.status_adapter.probe_account(
                _active_channels[channel_id], timeout_ms=5000
            )
            result["probe"] = probe
        except Exception as e:
            result["probe_error"] = str(e)

    return result


# ─── QR 扫码登录（微信）─────────────────────────────

@app.post("/api/gateway/channels/{channel_id}/qr/start")
async def start_qr_login(channel_id: str, req: ChannelConnectRequest):
    """发起 QR 扫码登录"""
    plugin = registry.get(channel_id)
    if not plugin or not plugin.qr_login_adapter:
        raise HTTPException(404, f"渠道 {channel_id} 不支持 QR 登录")

    # 先初始化 gateway（建立 client 等）
    config = ChannelConfig(channel_id=channel_id, credentials=req.credentials)
    if hasattr(plugin.gateway_adapter, "_client") and plugin.gateway_adapter._client is None:
        await plugin.gateway_adapter.start(config)

    result = await plugin.qr_login_adapter.start_qr_login()
    return {
        "qr_data_url": result.qr_data_url,
        "session_id": result.session_id,
        "message": result.message,
    }


@app.get("/api/gateway/channels/{channel_id}/qr/status")
async def check_qr_status(channel_id: str):
    """轮询 QR 扫码状态"""
    plugin = registry.get(channel_id)
    if not plugin or not plugin.qr_login_adapter:
        raise HTTPException(404, f"渠道 {channel_id} 不支持 QR 登录")

    result = await plugin.qr_login_adapter.check_qr_status()

    # 扫码成功后，完成连接设置
    if result.connected:
        config = config_persistence.get(channel_id) or ChannelConfig(channel_id=channel_id)
        await _make_message_handler(channel_id)
        if hasattr(plugin.outbound_adapter, "configure"):
            plugin.outbound_adapter.configure(config)
        _active_channels[channel_id] = config
        # 延迟持久化：避免 Uvicorn reload 中断响应
        asyncio.create_task(_deferred_save(channel_id, config))

    return {
        "status": result.status.value,
        "connected": result.connected,
        "error": result.error,
    }


# ─── Doctor 诊断（6.8）────────────────────────────

@app.get("/api/gateway/channels/{channel_id}/doctor")
async def doctor_channel(channel_id: str):
    """渠道配置诊断"""
    plugin = registry.get(channel_id)
    if not plugin or not plugin.doctor_adapter:
        raise HTTPException(404, f"渠道 {channel_id} 没有 Doctor 适配器")

    config = _active_channels.get(channel_id) or config_persistence.get(channel_id)
    if not config:
        raise HTTPException(400, f"渠道 {channel_id} 未配置")

    # 诊断
    mutation = plugin.doctor_adapter.repair_config(config)
    warnings = plugin.doctor_adapter.collect_warnings(config)

    return {
        "channel": channel_id,
        "changed": mutation.changed,
        "patches": mutation.patches,
        "warnings": mutation.warnings + warnings,
    }


# ─── Setup 配置向导 ─────────────────────────────────

@app.post("/api/gateway/channels/{channel_id}/setup")
async def setup_channel(channel_id: str, req: ChannelSetupRequest):
    """渠道配置向导"""
    plugin = registry.get(channel_id)
    if not plugin or not plugin.setup_adapter:
        raise HTTPException(404, f"渠道 {channel_id} 没有 Setup 适配器")

    # 校验输入
    error = plugin.setup_adapter.validate_input(req.input_data)
    if error:
        raise HTTPException(400, error)

    # 应用配置
    current = config_persistence.get(channel_id) or ChannelConfig(channel_id=channel_id)
    new_config = plugin.setup_adapter.apply_account_config(current, req.input_data)
    config_persistence.save(channel_id, new_config)

    return {"success": True, "channel": channel_id}


# ─── Security 安全审计 ──────────────────────────────

@app.get("/api/gateway/channels/{channel_id}/security")
async def security_audit(channel_id: str):
    """渠道安全审计"""
    plugin = registry.get(channel_id)
    if not plugin or not plugin.security_adapter:
        raise HTTPException(404, f"渠道 {channel_id} 没有 Security 适配器")

    config = _active_channels.get(channel_id) or config_persistence.get(channel_id)
    if not config:
        raise HTTPException(400, f"渠道 {channel_id} 未配置")

    warnings = plugin.security_adapter.collect_warnings(config)
    findings = plugin.security_adapter.collect_audit_findings(config)

    return {
        "channel": channel_id,
        "warnings": warnings,
        "findings": [
            {
                "check_id": f.check_id,
                "severity": f.severity,
                "title": f.title,
                "detail": f.detail,
                "remediation": f.remediation,
            }
            for f in findings
        ],
    }


# ─── Agent 路由管理（三级规则链）───────────────────────

@app.get("/api/gateway/routing")
async def get_routing_bindings():
    """获取当前所有路由绑定规则"""
    return agent_router.get_all_bindings()


@app.post("/api/gateway/routing/bind")
async def bind_routing(req: RoutingBindRequest):
    """绑定 chat/user/platform 到指定 Agent（三级规则链）"""
    if req.level == "chat":
        if not req.target_id:
            raise HTTPException(400, "chat 级别绑定需要 target_id (chat_id)")
        agent_router.bind_chat(req.platform, req.target_id, req.agent_id)
    elif req.level == "user":
        if not req.target_id:
            raise HTTPException(400, "user 级别绑定需要 target_id (user_id)")
        agent_router.bind_user(req.platform, req.target_id, req.agent_id)
    elif req.level == "platform":
        agent_router.bind_platform(req.platform, req.agent_id)
    else:
        raise HTTPException(400, f"无效的 level: {req.level}，支持 chat/user/platform")

    return {
        "success": True,
        "level": req.level,
        "platform": req.platform,
        "target_id": req.target_id,
        "agent_id": req.agent_id,
    }


@app.delete("/api/gateway/routing/bind")
async def unbind_routing(req: RoutingBindRequest):
    """解绑 chat/user/platform 的 Agent 路由"""
    if req.level == "chat":
        removed = agent_router.unbind_chat(req.platform, req.target_id)
    elif req.level == "user":
        removed = agent_router.unbind_user(req.platform, req.target_id)
    elif req.level == "platform":
        removed = agent_router.unbind_platform(req.platform)
    else:
        raise HTTPException(400, f"无效的 level: {req.level}")

    if not removed:
        raise HTTPException(404, "绑定不存在")

    return {"success": True, "removed": True}


# ─── 兼容旧 API + 通用端点 ──────────────────────────

@app.get("/health")
async def health():
    """增强版健康检查：分级状态 + 运行时快照"""
    api_health = await bridge.health_check()

    # 渠道连接状态
    channel_statuses = {}
    for plugin in registry.list_plugins():
        channel_statuses[plugin.id] = {
            "connected": plugin.gateway_adapter.is_connected,
            "last_error": plugin.gateway_adapter.last_error,
        }

    any_connected = any(s["connected"] for s in channel_statuses.values())
    api_ok = api_health.get("status") == "ok"

    if api_ok and any_connected:
        overall_status = "ok"
    elif api_ok:
        overall_status = "degraded"
    else:
        overall_status = "unhealthy"

    health_snapshot = health_monitor.get_health_snapshot()
    state_snapshot = state_manager.get_snapshot()

    return {
        "status": overall_status,
        "version": "2.0.0",
        "api_connection": api_health.get("status", "unknown"),
        "channels": channel_statuses,
        "channel_count": registry.count(),
        "active_sessions": session_manager.count(),
        "health": health_snapshot,
        "gateway": state_snapshot,
        "reconnect": reconnect_engine.get_all_status(),
    }


@app.get("/platforms")
async def list_platforms():
    """列出所有支持的平台（兼容旧 API）"""
    return {
        pid: {"label": p.label, "capabilities": {
            "media": p.capabilities.media,
            "threads": p.capabilities.threads,
        }}
        for pid, p in zip(registry.list_ids(), registry.list_plugins())
    }


@app.post("/send")
async def send_message(req: SendRequest):
    """通过网关发送消息到 Agent 并获取回复"""
    reply = await bridge.send_message(
        platform=req.platform,
        chat_id=req.chat_id,
        user_id=req.user_id,
        text=req.message,
        thread_id=req.thread_id,
    )
    return {"reply": reply}


@app.post("/adapters/bind")
async def bind_channel(req: BindRequest):
    """绑定通道到 Agent"""
    bridge.bind_channel(req.channel_id, req.agent_id)
    return {"status": "bound", "channel_id": req.channel_id, "agent_id": req.agent_id}


@app.get("/runtime")
async def get_runtime():
    """返回完整运行时快照（供前端 Dashboard 使用）"""
    channels_runtime = {}
    for plugin in registry.list_plugins():
        channels_runtime[plugin.id] = {
            "label": plugin.label,
            "connected": plugin.gateway_adapter.is_connected,
            "last_error": plugin.gateway_adapter.last_error,
        }
    return {
        "channels": channels_runtime,
        "health": health_monitor.get_health_snapshot(),
        "reconnect": reconnect_engine.get_all_status(),
        "gateway": state_manager.get_snapshot(),
        "sessions": {
            "count": session_manager.count(),
            "sessions": [s.to_dict() for s in session_manager.get_all_sessions()],
        },
        "config": gateway_config.to_dict(),
    }


# ── 配置管理 API ───────────────────────────────────
class ConfigUpdateRequest(BaseModel):
    updates: Dict[str, Any]

@app.get("/config")
async def get_config():
    """获取当前配置（脱敏）"""
    return gateway_config.to_dict()

@app.post("/config")
async def update_config_api(req: ConfigUpdateRequest):
    """运行时更新配置"""
    from config_manager import update_config
    changes = update_config(gateway_config, req.updates)
    return {"changes": changes, "config": gateway_config.to_dict()}


# ─── 媒体文件服务 ─────────────────────────────────────────
MEDIA_SERVE_DIR = os.environ.get("MEDIA_SERVE_DIR", os.path.join(os.path.dirname(__file__), ".media"))
os.makedirs(MEDIA_SERVE_DIR, exist_ok=True)

@app.get("/media/{filename}")
async def serve_media(filename: str):
    """媒体文件下载服务"""
    safe_name = os.path.basename(filename)
    file_path = os.path.join(MEDIA_SERVE_DIR, safe_name)
    if not os.path.isfile(file_path):
        alt_path = os.path.join(os.path.dirname(__file__), "..", "..", "data", "media", safe_name)
        if os.path.isfile(alt_path):
            file_path = alt_path
        else:
            raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(file_path)


if __name__ == "__main__":
    import uvicorn

    port = gateway_config.port
    logger.info("启动 IM Gateway (v2)", port=port)
    # 仅手动开发运行时启用热重载（IM_GATEWAY_RELOAD=true）
    # GatewayLauncher 已有崩溃重启机制，无需 uvicorn reload 二次重启
    enable_reload = os.environ.get("IM_GATEWAY_RELOAD", "false").lower() == "true"
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=port,
        reload=enable_reload,
        reload_dirs=[os.path.dirname(__file__)] if enable_reload else [],
        reload_excludes=["data/*", "*.json", ".media/*", "*.tmp", "__pycache__", "**/__pycache__", "**/__pycache__/*", "*.pyc"] if enable_reload else [],
    )
