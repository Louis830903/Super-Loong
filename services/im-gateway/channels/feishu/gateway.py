"""
飞书渠道 — 连接管理（GatewayAdapter + InboundAdapter 实现）

支持两种连接模式：
1. WebSocket 长连接（推荐）：通过 lark_oapi SDK 建立长连接
2. Webhook 回调：启动 HTTP 服务器接收飞书推送

参考 Hermes feishu.py 的 lark_oapi WebSocket 集成。
"""

import asyncio
import json
import logging
import os
import tempfile
import threading
import time
from typing import Optional, Callable, Any

from core.types import ChannelConfig, MessageEvent, MessageSource, MessageType

logger = logging.getLogger("gateway.feishu.gateway")


class FeishuGateway:
    """
    飞书网关适配器 — 实现 GatewayAdapter + InboundAdapter Protocol

    WebSocket 模式：使用 lark_oapi SDK 的 ws_client
    Webhook 模式：通过 FastAPI 子路由接收回调
    """

    def __init__(self):
        self._connected = False
        self._last_error: Optional[str] = None
        self._message_handler: Optional[Callable] = None
        self._config: Optional[ChannelConfig] = None
        self._ws_client = None  # lark_oapi ws client
        self._lark_client = None  # lark_oapi API client（用于文件下载等 API 调用）
        self._task: Optional[asyncio.Task] = None
        self._ws_thread: Optional[threading.Thread] = None  # WebSocket 独立线程
        self._connected_at: Optional[str] = None
        self._last_event_at: Optional[str] = None
        # 主事件循环引用（在 start() 时捕获，供线程回调中安全调度协程）
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ── GatewayAdapter Protocol ──

    async def start(self, config: ChannelConfig) -> bool:
        """启动飞书连接"""
        self._config = config
        app_id = config.credentials.get("app_id", "")
        app_secret = config.credentials.get("app_secret", "")
        mode = config.settings.get("mode", config.credentials.get("mode", "websocket"))

        if not app_id or not app_secret:
            self._last_error = "缺少 App ID 或 App Secret"
            logger.error(f"飞书连接失败: {self._last_error}")
            return False

        try:
            if mode == "websocket":
                return await self._start_websocket(app_id, app_secret)
            else:
                return await self._start_webhook(config)
        except Exception as e:
            self._last_error = str(e)
            logger.error(f"飞书连接异常: {e}")
            return False

    async def stop(self) -> None:
        """停止飞书连接"""
        self._connected = False
        # 清理 asyncio task（旧模式兼容）
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # WebSocket 线程会在 SDK 停止后自动退出（daemon 线程）
        self._ws_client = None
        self._task = None
        self._ws_thread = None
        logger.info("飞书连接已停止")

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    # ── InboundAdapter Protocol ──

    def set_message_handler(self, handler: Callable) -> None:
        self._message_handler = handler

    # ── HealthAdapter 兼容属性 ──

    @property
    def has_fatal_error(self) -> bool:
        return self._last_error is not None and not self._connected

    @property
    def connected_at(self) -> Optional[str]:
        return self._connected_at

    @property
    def last_event_at(self) -> Optional[str]:
        return self._last_event_at

    # ── WebSocket 模式 ──

    async def _start_websocket(self, app_id: str, app_secret: str) -> bool:
        """使用 lark_oapi SDK 启动 WebSocket 长连接
        
        关键设计：
        1. 在独立 daemon 线程中运行 SDK（避免事件循环冲突）
        2. 启动后等待最多 3 秒检测快速失败，确保 HTTP 响应反映真实连接状态
        """
        try:
            import lark_oapi as lark

            # 捕获当前事件循环，供线程回调中安全调度协程
            self._loop = asyncio.get_running_loop()

            # 创建飞书客户端
            cli = lark.Client.builder() \
                .app_id(app_id) \
                .app_secret(app_secret) \
                .log_level(lark.LogLevel.WARNING) \
                .build()

            # 保存 API 客户端实例（用于文件下载等后续 API 调用）
            self._lark_client = cli

            # 注册事件处理器
            event_handler = lark.EventDispatcherHandler.builder("", "") \
                .register_p2_im_message_receive_v1(self._on_message_event) \
                .build()

            # 使用 WebSocket 客户端
            ws_cli = lark.ws.Client(
                app_id=app_id,
                app_secret=app_secret,
                event_handler=event_handler,
                log_level=lark.LogLevel.WARNING,
            )

            self._ws_client = ws_cli
            self._last_error = None

            # 在独立 daemon 线程启动 WebSocket SDK（避免与 uvicorn 事件循环冲突）
            self._ws_thread = threading.Thread(
                target=self._run_ws_in_thread,
                args=(ws_cli,),
                daemon=True,
                name="feishu-ws",
            )
            self._ws_thread.start()

            # 等待最多 5 秒检测快速失败（如凭据错误、SDK 初始化异常）
            # 增加等待时间：飞书 SDK 鉴权握手可能需要 3-5 秒
            for _ in range(50):
                await asyncio.sleep(0.1)
                if self._last_error:
                    # SDK 已报错，连接失败
                    return False
                if not self._ws_thread.is_alive():
                    # 线程已退出但没有设 error
                    self._last_error = self._last_error or "WebSocket 线程意外退出"
                    return False
                # 收到第一条事件即可确认连接成功（比等待超时更可靠）
                if self._last_event_at:
                    break

            # 5 秒内未报错且线程存活 → 连接成功
            self._connected = True
            self._connected_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            logger.info(f"飞书 WebSocket 连接已启动: app_id={app_id[:8]}***")
            return True

        except ImportError:
            self._last_error = "lark_oapi SDK 未安装，请安装: pip install lark-oapi"
            logger.error(f"飞书连接失败: {self._last_error}")
            return False

    def _run_ws_in_thread(self, ws_cli) -> None:
        """在独立线程运行飞书 WebSocket SDK（避免事件循环冲突）
        
        根因分析：
        lark_oapi.ws.client 在模块加载时通过 asyncio.get_event_loop() 捕获
        主线程的事件循环到模块级变量 `loop`，然后 start() 直接调用
        loop.run_until_complete() — 在 uvicorn 已运行的循环上嵌套调用。
        
        之前尝试 nest_asyncio.apply() 允许嵌套，但 nest_asyncio 在 CLASS 级别
        修补 BaseEventLoop，破坏 uvicorn/anyio/sniffio 的事件循环检测，
        导致所有 HTTP 端点 500 (NoEventLoopError)。
        
        正确做法：为线程创建全新事件循环，并猴子补丁 SDK 的模块级 loop 变量，
        使 SDK 的 run_until_complete() 在新循环上执行，完全不影响 uvicorn。
        """
        import asyncio
        # 为当前线程创建全新的事件循环
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        # 关键：替换 lark SDK 模块级 loop 变量
        # SDK 的 start() 直接引用此变量调用 run_until_complete()，
        # 必须指向当前线程的新循环，而非 uvicorn 的主循环
        import lark_oapi.ws.client as _ws_mod
        # P2-06: 版本兼容性检查，SDK 升级后可能移除 loop 属性
        if hasattr(_ws_mod, "loop"):
            _ws_mod.loop = loop
        else:
            logger.warning(
                "飞书 SDK lark_oapi.ws.client 缺少 loop 属性，"
                "猴子补丁已跳过。请检查 SDK 版本是否升级，可能导致 WS 连接异常"
            )

        try:
            ws_cli.start()
        except Exception as e:
            self._last_error = str(e)
            self._connected = False
            logger.error(f"飞书 WebSocket 异常退出: {e}")
        finally:
            try:
                loop.close()
            except Exception:
                pass

    def _on_message_event(self, data) -> None:
        """飞书消息事件回调（由 lark_oapi SDK 调用）
        
        SDK 回调签名: Callable[[P2ImMessageReceiveV1], None]
        只传一个参数 data（反序列化后的事件对象），无 ctx。
        """
        try:
            self._last_event_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

            msg = data.event.message
            sender = data.event.sender

            # P2-07: 结构化日志 — 记录入站消息关键字段，便于排查问题
            logger.info(
                "飞书消息入站: msg_id=%s, chat_id=%s, type=%s, chat_type=%s",
                getattr(msg, "message_id", "?"),
                getattr(msg, "chat_id", "?"),
                getattr(msg, "message_type", "?"),
                getattr(msg, "chat_type", "?"),
            )

            # 解析消息内容
            text = ""
            msg_type = MessageType.TEXT
            media_urls = []
            media_types = []

            content = json.loads(msg.content) if msg.content else {}

            if msg.message_type == "text":
                text = content.get("text", "")
            elif msg.message_type == "image":
                msg_type = MessageType.IMAGE
                image_key = content.get("image_key", "")
                # 使用平台前缀标识，下游据此决定是否需要调用飞书 API 下载图片
                media_urls = [f"feishu://image/{image_key}"] if image_key else []
                media_types = ["image/png"] if image_key else []
            elif msg.message_type == "file":
                msg_type = MessageType.FILE
                file_key = content.get("file_key", "")
                media_urls = [f"feishu://file/{file_key}"] if file_key else []
                media_types = ["application/octet-stream"] if file_key else []
            elif msg.message_type == "audio":
                msg_type = MessageType.AUDIO
                file_key = content.get("file_key", "")
                media_urls = [f"feishu://audio/{file_key}"] if file_key else []
                media_types = ["audio/opus"] if file_key else []
            else:
                text = f"[{msg.message_type}]"

            # 构造统一 MessageEvent（安全解析 sender_id 属性，避免 AttributeError）
            _sender_id = getattr(sender, "sender_id", None)
            message_event = MessageEvent(
                text=text,
                source=MessageSource(
                    user_id=getattr(_sender_id, "open_id", "") or "",
                    chat_id=msg.chat_id or "",
                    thread_id=getattr(msg, "root_id", "") or "",
                    is_group=msg.chat_type == "group",
                    sender_name=getattr(_sender_id, "union_id", "") or "",
                ),
                msg_type=msg_type,
                msg_id=msg.message_id or "",
                timestamp=time.time(),
                media_urls=media_urls,
                media_types=media_types,
                raw=data,
            )

            if self._message_handler and self._loop:
                # 使用 run_coroutine_threadsafe 将异步任务安全投回主事件循环
                future = asyncio.run_coroutine_threadsafe(
                    self._message_handler(message_event),
                    self._loop,
                )
                # P0: 注册回调捕获异步异常，防止错误被静默吞掉
                def _on_handler_done(fut):
                    try:
                        fut.result()
                    except Exception as exc:
                        logger.error(f"飞书消息处理器异步异常: {exc}", exc_info=True)
                future.add_done_callback(_on_handler_done)

        except Exception as e:
            logger.error(f"飞书消息处理异常: {e}", exc_info=True)

    # ── 飞书文件资源下载 ──

    def download_resource(self, message_id: str, file_key: str, resource_type: str = "file") -> Optional[str]:
        """
        通过飞书 API 下载消息中的文件资源（语音/图片/文件）到本地临时目录。

        Args:
            message_id: 飞书消息 ID
            file_key: 文件资源 key
            resource_type: 资源类型（"file" 或 "image"）

        Returns:
            本地文件路径，失败时返回 None
        """
        if not self._lark_client:
            logger.error("飞书 API 客户端未初始化，无法下载文件资源")
            return None

        try:
            from lark_oapi.api.im.v1 import GetMessageResourceRequest

            req = GetMessageResourceRequest.builder() \
                .message_id(message_id) \
                .file_key(file_key) \
                .type(resource_type) \
                .build()

            resp = self._lark_client.im.v1.message_resource.get(req)

            if not resp.success():
                logger.error(
                    "飞书文件下载失败: code=%s, msg=%s",
                    resp.code, resp.msg,
                )
                return None

            # 将响应二进制内容写入临时文件
            # 根据 resource_type 动态设置文件后缀和前缀（A-0-①: 避免图片被错误命名为 .opus）
            _SUFFIX_MAP = {
                "image": ".png",   # 飞书图片默认 PNG
                "file": "",        # 通用文件，无固定后缀
                "audio": ".opus",  # 飞书语音默认 opus
            }
            _PREFIX_MAP = {
                "image": "feishu_img_",
                "file": "feishu_file_",
                "audio": "feishu_audio_",
            }
            tmp = tempfile.NamedTemporaryFile(
                delete=False,
                suffix=_SUFFIX_MAP.get(resource_type, ""),
                prefix=_PREFIX_MAP.get(resource_type, "feishu_"),
            )
            tmp.write(resp.file.read())
            tmp.close()

            file_size = os.path.getsize(tmp.name)
            logger.info(
                "飞书文件下载成功: msg_id=%s, file_key=%s, size=%d bytes, path=%s",
                message_id, file_key, file_size, tmp.name,
            )
            return tmp.name

        except ImportError:
            logger.error("缺少 lark_oapi SDK，无法下载飞书文件资源")
            return None
        except Exception as e:
            logger.error("飞书文件下载异常: %s", e, exc_info=True)
            return None

    # ── Webhook 模式（备选） ──

    async def _start_webhook(self, config: ChannelConfig) -> bool:
        """Webhook 模式启动（需外部 FastAPI 注册路由）"""
        verification_token = config.credentials.get("verification_token", "")
        if not verification_token:
            self._last_error = "Webhook 模式需要 Verification Token"
            logger.error(f"飞书 Webhook 启动失败: {self._last_error}")
            return False

        self._connected = True
        self._last_error = None
        self._connected_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        logger.info("飞书 Webhook 模式就绪（需在 server.py 注册回调路由）")
        return True
