"""
Session 生命周期管理（G1）— 学 Hermes gateway/session.py + gateway/run.py

连接 Adapter ↔ Agent ↔ Memory ↔ Evolution 四系统的关键枢纽。
管理 session 创建/空闲超时/重置/持久化。

持久化说明：
  gateway-launcher.ts 会在 Python Gateway 崩溃后自动重启（指数退避，最多 5 次）。
  若 session 仅存内存，重启后 turn_count 归零、flush 最小轮数检查失效、旧 session 记忆永不 flush。
  因此 SessionManager 必须依赖 gateway_state.py 持久化 session 数据，重启时调用 _restore() 恢复。
"""

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

from core.types import (
    GatewaySession,
    SessionKeyStrategy,
    SessionResetPolicy,
)

logger = logging.getLogger("gateway.session")

# 默认 session 持久化路径
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_SESSION_FILE = _DATA_DIR / "gateway_sessions.json"


def _build_session_key(
    platform: str,
    user_id: str,
    chat_id: str,
    thread_id: str = "",
    strategy: SessionKeyStrategy = SessionKeyStrategy.PER_USER_CHAT,
    agent_id: str = "",
) -> str:
    """根据策略生成 session key（含 agent_id 前缀）"""
    # 基础 key
    if strategy == SessionKeyStrategy.PER_USER:
        base = f"{platform}:{user_id}"
    elif strategy == SessionKeyStrategy.PER_CHAT:
        base = f"{platform}:{chat_id}"
    elif strategy == SessionKeyStrategy.PER_THREAD:
        base = f"{platform}:{user_id}:{thread_id}" if thread_id else f"{platform}:{user_id}"
    else:  # PER_USER_CHAT（默认）
        base = f"{platform}:{user_id}:{chat_id}"

    # 嵌入 agentId 前缀（学 OpenClaw SessionKey 设计）
    if agent_id:
        return f"agent:{agent_id}:{base}"
    return base


class SessionManager:
    """
    Session 生命周期管理器

    职责：
    - resolve_session: 根据消息上下文查找/创建 session
    - get_idle_sessions: 获取所有空闲超时的 session（供 flush loop 使用）
    - remove_session: 移除 session（flush 后调用）
    - _persist / _restore: 持久化到 JSON 文件（防重启丢失）
    - drain: 优雅关闭时 flush 所有活跃 session（G9）
    """

    def __init__(
        self,
        default_agent_id: str = "",
        reset_policy: Optional[SessionResetPolicy] = None,
        session_file: Path = _SESSION_FILE,
    ):
        self._sessions: dict[str, GatewaySession] = {}
        self._default_agent_id = default_agent_id
        self._policy = reset_policy or SessionResetPolicy()
        self._session_file = session_file
        self._session_file.parent.mkdir(parents=True, exist_ok=True)

        # 启动时从持久化文件恢复
        self._restore()

    def resolve_session(
        self,
        platform: str,
        user_id: str,
        chat_id: str,
        thread_id: str = "",
        key_strategy: SessionKeyStrategy = SessionKeyStrategy.PER_USER_CHAT,
        agent_id: str = "",
    ) -> GatewaySession:
        """
        查找或创建 session

        Args:
            platform: 渠道标识
            user_id: 用户 ID
            chat_id: 聊天 ID
            thread_id: 线程 ID（飞书线程隔离）
            key_strategy: session key 生成策略
            agent_id: 指定 agent（未指定用默认）

        Returns:
            GatewaySession 实例（新建或已有）
        """
        key = _build_session_key(platform, user_id, chat_id, thread_id, key_strategy, agent_id)

        # 解析最终使用的 agent_id
        resolved_agent_id = agent_id or self._default_agent_id

        if key in self._sessions:
            session = self._sessions[key]
            session.touch()
            self._persist()
            return session

        # 创建新 session
        session = GatewaySession(
            session_key=key,
            agent_id=resolved_agent_id,
            platform=platform,
            user_id=user_id,
            chat_id=chat_id,
        )
        self._sessions[key] = session
        self._persist()
        logger.info("新 session 已创建: %s", key)
        return session

    def get_idle_sessions(self) -> list[GatewaySession]:
        """获取所有空闲超时的 session（供 G2 flush loop 使用）"""
        if self._policy.mode == "none":
            return []

        timeout = self._policy.idle_timeout_s
        return [s for s in self._sessions.values() if s.is_idle(timeout)]

    def get_all_sessions(self) -> list[GatewaySession]:
        """获取所有活跃 session"""
        return list(self._sessions.values())

    def remove_session(self, key: str) -> Optional[GatewaySession]:
        """移除 session（flush 完成后调用）"""
        session = self._sessions.pop(key, None)
        if session:
            self._persist()
            logger.info("session 已移除: %s (turns=%d)", key, session.turn_count)
        return session

    def count(self) -> int:
        """活跃 session 数量"""
        return len(self._sessions)

    # ── 持久化 ──────────────────────────────────────

    def _persist(self) -> None:
        """每次 session 变更后写盘（防重启丢失）"""
        try:
            data = {key: s.to_dict() for key, s in self._sessions.items()}
            tmp_file = self._session_file.with_suffix(".tmp")
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            # 原子替换
            if self._session_file.exists():
                os.unlink(self._session_file)
            os.rename(tmp_file, self._session_file)
        except Exception as e:
            logger.error("session 持久化失败: %s", e)

    def _restore(self) -> None:
        """启动时从 JSON 恢复所有 session"""
        if not self._session_file.exists():
            return

        try:
            with open(self._session_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            for key, s_dict in data.items():
                self._sessions[key] = GatewaySession.from_dict(s_dict)
            logger.info("已恢复 %d 个 session", len(self._sessions))
        except Exception as e:
            logger.error("session 恢复失败: %s", e)

    # ── G9: Graceful Drain ─────────────────────────

    async def drain(self, flush_callback=None, timeout_s: float = 30) -> int:
        """
        优雅关闭：等待活跃请求 → flush 所有 session → 退出

        Args:
            flush_callback: 异步回调，接收 GatewaySession 参数，执行 flush
            timeout_s: 最长等待时间

        Returns:
            成功 flush 的 session 数量
        """
        sessions = list(self._sessions.values())
        if not sessions:
            return 0

        logger.info("开始 drain %d 个活跃 session (timeout=%ds)", len(sessions), timeout_s)
        flushed = 0

        async def _flush_one(session: GatewaySession):
            nonlocal flushed
            try:
                if flush_callback:
                    await flush_callback(session)
                flushed += 1
            except Exception as e:
                logger.error("drain flush 失败: %s, error=%s", session.session_key, e)

        try:
            await asyncio.wait_for(
                asyncio.gather(*[_flush_one(s) for s in sessions], return_exceptions=True),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            logger.warning("drain 超时: %d/%d session 已 flush", flushed, len(sessions))

        # 清空所有 session
        self._sessions.clear()
        self._persist()
        logger.info("drain 完成: %d/%d session 已 flush", flushed, len(sessions))
        return flushed
