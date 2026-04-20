"""
Super Agent IM Gateway - 通信桥接器

将 Hermes 平台适配器接收的消息转发到 Super Agent API，并将回复返回给 IM 平台。

重试机制：
- 可重试错误（网络超时、503、连接重置）最多重试 3 次
- 不可重试错误（401、403、400）直接返回
- 每条原始消息生成 requestId（uuid4），重试时复用同一 ID
- 幂等性保护：chat.ts 端根据 requestId 去重
"""

import asyncio
import base64
import json as _json
import mimetypes
import os
import uuid
import httpx
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Callable

from structured_logger import create_logger

logger = create_logger("gateway.bridge")


# WebSocket 客户端（可选，用于替代 HTTP POST）
try:
    import websockets
    import websockets.exceptions
    _WS_AVAILABLE = True
except ImportError:
    _WS_AVAILABLE = False


@dataclass
class BridgeConfig:
    """通信桥配置"""
    api_base_url: str = "http://localhost:3001"
    api_key: str = ""
    default_agent_id: str = ""
    timeout: float = 120.0  # LLM 响应可能较慢
    max_retries: int = 3     # 最大重试次数


# ─── 媒体分类与安全校验 (对标 OpenClaw 渠道适配模式) ──────

MIME_KIND_MAP = {
    "image/": "image",
    "video/": "video",
    "audio/": "audio",
    "application/pdf": "document",
    "application/msword": "document",
    "application/vnd.openxmlformats": "document",
    "application/vnd.ms-excel": "document",
    "application/vnd.ms-powerpoint": "document",
}

# 全局回退限制 (未匹配平台时使用)
# 各平台实际限制已在 core/types.py PLATFORM_SIZE_LIMITS 中定义
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024  # 20MB (三平台最小公约数)

# 延迟导入: 供 validate_attachment_for_platform 使用
_platform_size_limits_loaded = False
_get_size_limit = None


def _ensure_size_limits():
    """延迟加载平台大小限制, 避免循环导入"""
    global _platform_size_limits_loaded, _get_size_limit
    if not _platform_size_limits_loaded:
        try:
            from core.types import get_size_limit
            _get_size_limit = get_size_limit
        except ImportError:
            _get_size_limit = None
        _platform_size_limits_loaded = True


def classify_media_kind(file_path: str, mime_type: str = "") -> str:
    """根据 MIME 和扩展名推断媒体分类"""
    if not mime_type:
        mime_type, _ = mimetypes.guess_type(file_path)
        mime_type = mime_type or ""
    for prefix, kind in MIME_KIND_MAP.items():
        if mime_type.startswith(prefix):
            return kind
    return "file"


def validate_attachment(path: str, platform: str = "", kind: str = "") -> tuple:
    """
    校验附件安全性，返回 (is_valid, error_message)。

    Args:
        path: 文件路径
        platform: 平台名 (wecom/feishu/dingtalk), 用于查询精确限制
        kind: 媒体类型 (image/audio/video/file), 用于查询精确限制
    """
    if not os.path.isfile(path):
        return False, f"文件不存在: {path}"
    # P2-04: 使用 os.path.islink 替代 realpath/abspath 对比，更可靠
    if os.path.islink(path):
        return False, f"不允许符号链接: {path}"
    real = os.path.realpath(path)
    size = os.path.getsize(real)
    if size == 0:
        return False, f"文件为空: {path}"

    # 按平台+类型查询精确限制, 未匹配时用全局回退
    _ensure_size_limits()
    if platform and kind and _get_size_limit:
        limit = _get_size_limit(platform, kind)
    else:
        limit = MAX_ATTACHMENT_BYTES

    if size > limit:
        limit_mb = limit / (1024 * 1024)
        return False, f"文件超过 {limit_mb:.0f}MB 限制: {size} bytes (platform={platform}, kind={kind})"

    return True, ""


@dataclass
class BridgeReply:
    """桥接回复 — 结构化返回文本和附件"""
    text: str
    attachments: List[Dict[str, str]] = field(default_factory=list)  # [{path, kind, mimeType, filename}]


class AgentBridge:
    """
    Super Agent API 通信桥
    负责将 IM 消息转发到 API 并获取回复
    """

    def __init__(self, config: BridgeConfig):
        self.config = config
        self._client: Optional[httpx.AsyncClient] = None
        self._agent_mapping: Dict[str, str] = {}  # channel_id -> agent_id
        # 后台获取 Agent 成功时的回调（由 server.py 注入）
        self._on_agent_ready: Optional[callable] = None
        # ── WebSocket 通信层 ──
        self._ws = None               # websockets 连接实例
        self._ws_connected = False    # WebSocket 是否已连接
        self._ws_task = None          # 接收循环任务
        self._ws_reconnect_task = None  # 自动重连任务
        # 待处理请求: requestId → {"future": Future, "chunks": [], "attachments": []}
        self._pending_ws: Dict[str, dict] = {}

    async def start(self):
        """
        启动桥接器（正式启动协议）

        三步握手：
        1. 初始化 HTTP 客户端
        2. 等待 API 就绪（最多 30s 健康检查轮询）
        3. 获取默认 Agent（失败则启动后台指数退避重试）
        """
        self._client = httpx.AsyncClient(
            base_url=self.config.api_base_url,
            timeout=httpx.Timeout(self.config.timeout),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.config.api_key}"} if self.config.api_key else {}),
            },
        )

        # 第一步：等待 API 就绪（最多 30s）
        api_ready = await self._wait_for_api(max_wait=30)
        if not api_ready:
            logger.warning("API 未就绪，Bridge 仍将启动，Agent 获取将在后台重试")

        # 第二步：获取默认 Agent
        if not self.config.default_agent_id:
            agent_id = await self._fetch_default_agent()
            if agent_id:
                self.config.default_agent_id = agent_id

        # 第三步：如果 Agent 仍未获取到，启动后台重试
        if not self.config.default_agent_id:
            logger.warning("默认 Agent 未获取到，启动后台重试任务")
            asyncio.create_task(self._background_agent_fetch())

        # 第四步：尝试建立 WebSocket 连接（Phase A — 优先 WS，HTTP 降级）
        if _WS_AVAILABLE:
            await self._connect_ws()

    async def _wait_for_api(self, max_wait: int = 30) -> bool:
        """等待 API 健康检查通过（启动时序保护）
        注意：使用轻量 /api/ping 端点，避免与 /api/system/health 的循环依赖
        """
        for i in range(max_wait):
            try:
                resp = await self._client.get("/api/ping", timeout=httpx.Timeout(3.0))
                if resp.status_code == 200:
                    logger.info(f"API 就绪 (第 {i + 1} 秒)")
                    return True
            except Exception:
                pass
            if i < max_wait - 1:
                await asyncio.sleep(1.0)
        logger.warning(f"等待 API 就绪超时 ({max_wait}s)")
        return False

    async def _fetch_default_agent(self) -> str:
        """从 API 获取默认 Agent ID，失败返回空字符串"""
        try:
            resp = await self._client.get("/api/agents", timeout=httpx.Timeout(10.0))
            data = resp.json()
            agents = data.get("agents", data if isinstance(data, list) else [])
            if agents:
                agent_id = agents[0]["id"]
                agent_name = agents[0].get("name", agent_id)
                logger.info(f"默认 Agent 已获取: {agent_name} ({agent_id})")
                return agent_id
            logger.warning("API 返回空 Agent 列表")
        except Exception as e:
            logger.error(f"获取默认 Agent 失败: {e}")
        return ""

    async def _background_agent_fetch(self):
        """
        后台指数退避获取默认 Agent

        适用于 Gateway 先于 API 启动的场景：
        - 最多重试 10 次
        - 延迟: 2s → 4s → 8s → 16s → 32s → 60s（封顶）
        - 获取成功后立即停止
        """
        for attempt in range(10):
            delay = min(2 ** (attempt + 1), 60)
            await asyncio.sleep(delay)
            agent_id = await self._fetch_default_agent()
            if agent_id:
                self.config.default_agent_id = agent_id
                # 通知外部观察者（如 session_manager）
                if self._on_agent_ready:
                    self._on_agent_ready(agent_id)
                logger.info(f"后台重试成功 (第 {attempt + 1} 次, 延迟 {delay}s)")
                return
        logger.error("10 次重试后仍无法获取默认 Agent，请检查 API 服务状态")

    async def stop(self):
        """关闭所有连接"""
        # 关闭 WebSocket
        if self._ws_reconnect_task and not self._ws_reconnect_task.done():
            self._ws_reconnect_task.cancel()
        if self._ws_task and not self._ws_task.done():
            self._ws_task.cancel()
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
            self._ws_connected = False
        # 关闭 HTTP 客户端
        if self._client:
            await self._client.aclose()
            self._client = None

    def bind_channel(self, channel_id: str, agent_id: str):
        """绑定通道到指定 Agent"""
        self._agent_mapping[channel_id] = agent_id
        logger.info(f"Channel {channel_id} bound to agent {agent_id}")

    def get_agent_id(self, channel_id: str) -> str:
        """获取通道绑定的 Agent ID"""
        return self._agent_mapping.get(channel_id, self.config.default_agent_id)

    async def send_message(
        self,
        platform: str,
        chat_id: str,
        user_id: str,
        text: str,
        thread_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        agent_id: str = "",
    ) -> str:
        """
        将 IM 消息发送到 Super Agent API 并获取回复（带重试 + 幂等性保护）

        Args:
            platform: 平台名称 (wecom/feishu/dingtalk/weixin)
            chat_id: 聊天 ID
            user_id: 用户 ID
            text: 消息文本
            thread_id: 线程 ID (可选)
            metadata: 附加元数据
            agent_id: 显式指定的 Agent ID（由 AgentRouter 解析，空则回退到旧逻辑）

        Returns:
            Agent 的回复文本
        """
        if not self._client:
            raise RuntimeError("Bridge not started")

        # 优先使用显式传入的 agent_id，否则回退到旧的渠道绑定逻辑
        resolved_agent_id = agent_id or self.get_agent_id(platform)

        if not resolved_agent_id:
            return "系统错误：没有可用的 Agent，请先在管理后台创建 Agent。"

        # B-7: 统一提取 _images，避免 WS/HTTP 降级时数据丢失
        images = None
        if metadata and "_images" in metadata:
            images = metadata.pop("_images")

        # ── P0: 统一 requestId，WS 和 HTTP 降级共用同一个（借鉴 OpenClaw 架构设计） ──
        request_id = str(uuid.uuid4())

        # ── Phase A: 优先 WebSocket，降级 HTTP ──
        if self._ws_connected and self._ws:
            try:
                # B-7: 将提取的 images 传递给 WS 方法（通过临时包装 metadata）
                ws_meta = dict(metadata) if metadata else {}
                if images:
                    ws_meta["images"] = images
                return await self._send_via_ws(
                    agent_id=resolved_agent_id,
                    platform=platform,
                    chat_id=chat_id,
                    user_id=user_id,
                    text=text,
                    thread_id=thread_id,
                    metadata=ws_meta,
                    request_id=request_id,
                )
            except Exception as e:
                logger.warning(f"WebSocket 发送失败，降级到 HTTP: {e}")

        session_id = f"{platform}:{chat_id}"
        if thread_id:
            session_id += f":{thread_id}"

        # HTTP 降级：复用统一 request_id（不再另行生成，确保去重缓存跨 WS/HTTP 生效）

        payload = {
            "agentId": resolved_agent_id,
            "message": text,
            "sessionId": session_id,
            "platform": platform,
            "requestId": request_id,  # 幂等性 Key
            "metadata": {
                "userId": user_id,
                "chatId": chat_id,
                "threadId": thread_id,
                **({"images": images} if images else {}),
                **(metadata or {}),
            },
        }

        # 重试循环
        max_retries = self.config.max_retries
        last_error = None

        for attempt in range(max_retries + 1):  # 0 = 首次尝试, 1..N = 重试
            try:
                if attempt > 0:
                    # 重试延迟：1s -> 2s -> 4s
                    delay = min(2 ** (attempt - 1), 4)
                    logger.warning("重试发送消息",
                                   attempt=attempt,
                                   max_retries=max_retries,
                                   delay_seconds=delay,
                                   session_id=session_id,
                                   request_id=request_id)
                    await asyncio.sleep(delay)

                resp = await self._client.post("/api/chat", json=payload)
                resp.raise_for_status()
                data = resp.json()
                reply_text = data.get("response", data.get("content", data.get("message", "")))

                # 结构化附件处理 — 校验 + 分类 + 媒体类型推断
                structured_attachments: list[dict] = []
                attachments = data.get("attachments") or []
                if attachments:
                    for att in attachments:
                        att_path = att.get("path", "") if isinstance(att, dict) else str(att)
                        if not att_path:
                            continue
                        is_valid, err_msg = validate_attachment(att_path)
                        if not is_valid:
                            logger.warning("附件校验失败", error=err_msg)
                            continue
                        mime_type = att.get("mimeType", "") if isinstance(att, dict) else ""
                        kind = classify_media_kind(att_path, mime_type)
                        if not mime_type:
                            mime_type, _ = mimetypes.guess_type(att_path)
                            mime_type = mime_type or "application/octet-stream"
                        structured_attachments.append({
                            "path": att_path,
                            "kind": kind,
                            "mimeType": mime_type,
                            "filename": os.path.basename(att_path),
                        })

                # 后向兼容: 将结构化附件转为 MEDIA: 标记
                if structured_attachments:
                    media_tags = [f"MEDIA:{a['path']}" for a in structured_attachments]
                    reply_text = reply_text.rstrip() + "\n\n" + "\n".join(media_tags)

                if attempt > 0:
                    logger.info("重试成功",
                                attempt=attempt,
                                session_id=session_id,
                                request_id=request_id)

                # G3: 异步回传交互数据到 Node.js 进化引擎（非关键路径，失败静默）
                asyncio.create_task(self._report_interaction(
                    agent_id=resolved_agent_id,
                    session_id=session_id,
                    user_message=text,
                    agent_response=reply_text,
                    success=True,
                    platform=platform,
                ))

                return reply_text

            except httpx.TimeoutException as e:
                last_error = e
                logger.error("API 超时",
                             session_id=session_id,
                             attempt=attempt,
                             request_id=request_id)
                # 可重试
                continue

            except httpx.HTTPStatusError as e:
                status_code = e.response.status_code
                # 不可重试状态码：4xx（401/403/400）
                if 400 <= status_code < 500:
                    logger.error("API 客户端错误，不重试",
                                 status_code=status_code,
                                 body=e.response.text[:200],
                                 session_id=session_id)
                    return f"系统错误 ({status_code})，请联系管理员。"
                # 服务端错误：可重试
                last_error = e
                logger.error("API 服务端错误",
                             status_code=status_code,
                             attempt=attempt,
                             session_id=session_id,
                             request_id=request_id)
                continue

            except Exception as e:
                last_error = e
                logger.error("Bridge 异常",
                             error=str(e),
                             attempt=attempt,
                             session_id=session_id,
                             request_id=request_id)
                continue

        # 所有重试均失败
        logger.error("所有重试均失败",
                     total_attempts=max_retries + 1,
                     session_id=session_id,
                     request_id=request_id,
                     last_error=str(last_error))
        return "抱歉，AI 响应失败，请稍后重试。"

    async def _report_interaction(self, **kwargs) -> None:
        """
        G3: 异步回传交互数据到 Node.js 进化引擎

        对齐已有端点 POST /api/evolution/interactions（evolution.ts L77）
        RecordInteractionSchema: {agentId, sessionId?, userMessage, agentResponse, toolCalls?, success?}
        非关键路径，失败静默。
        """
        try:
            if not self._client:
                return
            payload = {
                "agentId": kwargs.get("agent_id", ""),
                "sessionId": kwargs.get("session_id", ""),
                "userMessage": kwargs.get("user_message", ""),
                "agentResponse": kwargs.get("agent_response", ""),
                "success": kwargs.get("success", True),
                "platform": kwargs.get("platform", ""),
            }
            await self._client.post(
                "/api/evolution/interactions",
                json=payload,
                timeout=httpx.Timeout(5.0),
            )
        except Exception:
            pass  # G3: 静默失败，不影响主消息流程

    async def health_check(self) -> Dict[str, Any]:
        """增强版健康检查：探测 API 实际连通性，返回分级状态
        注意：使用 /api/ping 而非 /api/system/health，避免健康检查循环依赖
        """
        if not self._client:
            return {"status": "error", "message": "Bridge not started", "grade": "unhealthy"}
        try:
            resp = await self._client.get("/api/ping", timeout=httpx.Timeout(5.0))
            if resp.status_code == 200:
                data = resp.json()
                data["grade"] = "ok"
                data["ws_connected"] = self._ws_connected
                return data
            else:
                return {"status": "degraded", "grade": "degraded",
                        "message": f"API returned {resp.status_code}",
                        "ws_connected": self._ws_connected}
        except httpx.TimeoutException:
            return {"status": "degraded", "grade": "degraded",
                    "message": "API health check timed out",
                    "ws_connected": self._ws_connected}
        except Exception as e:
            return {"status": "error", "grade": "unhealthy",
                    "message": str(e), "ws_connected": self._ws_connected}

    @property
    def is_ready(self) -> bool:
        """Bridge 是否已启动且 HTTP 客户端可用"""
        return self._client is not None

    async def proxy_post(self, path: str, **kwargs) -> Optional[httpx.Response]:
        """代理 HTTP POST 请求（供外部模块安全调用，避免直接访问 _client 私有属性）"""
        if not self._client:
            return None
        return await self._client.post(path, **kwargs)

    # ── WebSocket 通信层 (Phase A) ──────────────────────────

    async def _connect_ws(self) -> bool:
        """建立 WebSocket 连接到 API /ws/gateway（携带 api_key 鉴权）"""
        try:
            ws_url = self.config.api_base_url.replace("http://", "ws://").replace("https://", "wss://")
            uri = f"{ws_url}/ws/gateway"
            # 携带 Authorization header（与 HTTP 路径一致）
            extra_headers = {}
            if self.config.api_key:
                extra_headers["Authorization"] = f"Bearer {self.config.api_key}"
            self._ws = await websockets.connect(
                uri,
                additional_headers=extra_headers,
                ping_interval=30,
                ping_timeout=10,
                close_timeout=5,
            )
            self._ws_connected = True
            # 启动接收循环
            self._ws_task = asyncio.create_task(self._ws_receive_loop())
            logger.info(f"WebSocket 连接已建立: {uri}")
            return True
        except Exception as e:
            logger.warning(f"WebSocket 连接失败，将使用 HTTP 降级: {e}")
            self._ws_connected = False
            # 启动后台重连
            if not self._ws_reconnect_task or self._ws_reconnect_task.done():
                self._ws_reconnect_task = asyncio.create_task(self._ws_reconnect_loop())
            return False

    async def _ws_receive_loop(self):
        """
        WebSocket 接收循环 — 分发 API 回复到对应的待处理请求

        API 回复类型：
        - chunk: 流式内容块，累积到 pending request
        - done:  请求完成，解析 future
        - error: 请求失败，设置 future 异常
        - pong:  心跳响应，忽略
        """
        try:
            async for raw in self._ws:
                try:
                    msg = _json.loads(raw)
                except Exception:
                    continue

                msg_type = msg.get("type", "")
                request_id = msg.get("requestId", "")

                if msg_type == "chunk" and request_id in self._pending_ws:
                    # 累积内容块
                    data = msg.get("data", "")
                    if isinstance(data, str):
                        self._pending_ws[request_id]["chunks"].append(data)
                    elif isinstance(data, dict):
                        content = data.get("content", "")
                        if content:
                            self._pending_ws[request_id]["chunks"].append(content)
                        if data.get("type") == "attachment":
                            self._pending_ws[request_id]["attachments"].append(data)

                elif msg_type == "done" and request_id in self._pending_ws:
                    # 请求完成 — 组装响应并解析 future
                    pending = self._pending_ws.pop(request_id)
                    # done 消息可能包含完整 response 字段（API 侧累积）
                    full_text = msg.get("response", "") or "".join(pending["chunks"])
                    attachments = msg.get("attachments", []) or pending["attachments"]
                    if not pending["future"].done():
                        pending["future"].set_result({
                            "text": full_text,
                            "attachments": attachments,
                        })

                elif msg_type == "error" and request_id in self._pending_ws:
                    pending = self._pending_ws.pop(request_id)
                    if not pending["future"].done():
                        pending["future"].set_result({
                            "text": f"抱歉，AI 响应失败：{msg.get('error', '未知错误')}",
                            "attachments": [],
                        })

                elif msg_type == "pong":
                    pass  # 心跳响应

        except (websockets.exceptions.ConnectionClosed, websockets.exceptions.ConnectionClosedError) as e:
            logger.warning(f"WebSocket 连接断开: {e}")
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error(f"WebSocket 接收循环异常: {e}")
        finally:
            self._ws_connected = False
            # 清理所有待处理请求（优雅降级而非抛异常，让上层 send_message 可以重试 HTTP）
            for rid, pending in list(self._pending_ws.items()):
                if not pending["future"].done():
                    pending["future"].set_result({
                        "text": "抱歉，连接中断，正在重试...",
                        "attachments": [],
                    })
                self._pending_ws.pop(rid, None)
            # 启动自动重连
            if not self._ws_reconnect_task or self._ws_reconnect_task.done():
                self._ws_reconnect_task = asyncio.create_task(self._ws_reconnect_loop())

    async def _ws_reconnect_loop(self):
        """WebSocket 指数退避重连（5s → 10s → 20s → ... → 60s，最多 20 次）"""
        for attempt in range(20):
            if self._ws_connected:
                return
            delay = min(5 * (2 ** attempt), 60)
            logger.info(f"WebSocket 重连等待 {delay}s (第 {attempt + 1} 次)")
            await asyncio.sleep(delay)
            if self._ws_connected:
                return
            success = await self._connect_ws()
            if success:
                logger.info(f"WebSocket 重连成功 (第 {attempt + 1} 次)")
                return
        logger.error("WebSocket 重连失败 (20 次)，将持续使用 HTTP")

    async def _send_via_ws(
        self,
        agent_id: str,
        platform: str,
        chat_id: str,
        user_id: str,
        text: str,
        thread_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
        request_id: str = "",  # P0: 接收外部传入的统一 requestId
    ) -> str:
        """
        通过 WebSocket 发送消息并等待流式响应

        协议: 发送 {type:"chat", ...} → 等待 chunk+done → 组装完整回复
        """
        # 使用传入的 request_id，不再自行生成（与 HTTP 降级共用同一 ID）
        if not request_id:
            request_id = str(uuid.uuid4())
        session_id = f"{platform}:{chat_id}"
        if thread_id:
            session_id += f":{thread_id}"

        # 创建待处理请求
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        self._pending_ws[request_id] = {
            "future": future,
            "chunks": [],
            "attachments": [],
        }

        # B-7: images 已在 send_message() 入口统一提取并注入 ws_meta，此处直接使用 metadata

        # 发送 chat 消息
        payload = _json.dumps({
            "type": "chat",
            "requestId": request_id,
            "agentId": agent_id,
            "sessionId": session_id,
            "message": text,
            "metadata": {
                "userId": user_id,
                "chatId": chat_id,
                "threadId": thread_id,
                "platform": platform,
                **(metadata or {}),
            },
        })
        await self._ws.send(payload)

        try:
            # 等待响应（超时与 HTTP 一致）
            result = await asyncio.wait_for(future, timeout=self.config.timeout)
            reply_text = result.get("text", "")
            attachments = result.get("attachments", [])

            # 后向兼容: 将附件转为 MEDIA: 标记（与 HTTP 路径一致）
            if attachments:
                media_tags = []
                for att in attachments:
                    path = att.get("path", "") if isinstance(att, dict) else ""
                    if path:
                        media_tags.append(f"MEDIA:{path}")
                if media_tags:
                    reply_text = reply_text.rstrip() + "\n\n" + "\n".join(media_tags)

            # G3: 异步回传交互数据
            asyncio.create_task(self._report_interaction(
                agent_id=agent_id,
                session_id=session_id,
                user_message=text,
                agent_response=reply_text,
                success=True,
                platform=platform,
            ))

            return reply_text

        except asyncio.TimeoutError:
            self._pending_ws.pop(request_id, None)
            raise
        except Exception:
            self._pending_ws.pop(request_id, None)
            raise

    async def transcribe_audio(self, file_path: str, language: str = "zh") -> str:
        """
        调用 Super Agent STT API 将本地音频文件转写为文本。

        Args:
            file_path: 本地音频文件绝对路径（由 Hermes 适配器缓存）
            language: 语言代码，默认 "zh"

        Returns:
            转写后的文本，失败时返回空字符串
        """
        if not self._client:
            logger.error("Bridge not started, cannot transcribe")
            return ""

        if not os.path.isfile(file_path):
            logger.warning(f"Audio file not found: {file_path}")
            return ""

        try:
            with open(file_path, "rb") as f:
                audio_data = f.read()

            if not audio_data:
                logger.warning(f"Audio file is empty: {file_path}")
                return ""

            audio_b64 = base64.b64encode(audio_data).decode("ascii")

            # 从文件扩展名推断格式
            ext = os.path.splitext(file_path)[1].lstrip(".").lower()
            FORMAT_MAP = {
                "silk": "silk", "ogg": "ogg", "oga": "ogg", "opus": "opus",
                "mp3": "mp3", "wav": "wav", "webm": "webm",
                "m4a": "m4a", "mp4": "mp4", "amr": "amr",
                "aac": "aac", "flac": "flac",
            }
            audio_format = FORMAT_MAP.get(ext, "wav")

            resp = await self._client.post(
                "/api/voice/transcribe",
                json={"audio": audio_b64, "language": language, "format": audio_format},
                timeout=httpx.Timeout(30.0),
            )
            resp.raise_for_status()
            result = resp.json()
            text = result.get("text", "")
            if text:
                logger.info(f"Transcription OK ({len(text)} chars) for {os.path.basename(file_path)}")
            return text
        except Exception as e:
            logger.error(f"Audio transcription failed for {file_path}: {e}")
            return ""
