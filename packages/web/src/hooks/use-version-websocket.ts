"use client";

/**
 * 版本更新 WebSocket 单例 hook。
 *
 * 设计要点：
 * - 全局单例 WebSocket 连接（所有 VersionFooter 实例共享），避免双重连接
 * - 监听 "update:available" 事件，解析为 VersionInfo 状态
 * - 返回 null 表示尚未收到推送（与初始状态区分）
 * - 不做 Notification.requestPermission()，仅更新 UI 状态（避免突兀弹窗）
 * - 🔧 自动重连：onclose 触发指数退避重连（1s→2s→4s→…→60s），onopen 重置计数器
 */

import { useState, useEffect, useRef } from "react";
import type { VersionInfo } from "@super-agent/web-types";

// 根据当前协议自动选择 ws:// 或 wss://
function getWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** 全局单例 WebSocket 连接（所有 hook 实例共享） */
let globalSocket: WebSocket | null = null;
const listeners = new Set<(info: VersionInfo) => void>();

// ── 重连状态 ──────────────────────────────────────────
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
/** 指数退避上限 60s（1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s...） */
const MAX_RECONNECT_DELAY = 60_000;

/** 在 onclose 后调度重连（仅当仍有活跃监听者时） */
function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY,
  );
  reconnectAttempts++;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (listeners.size > 0) getSocket();
  }, delay);
}

function getSocket(): WebSocket {
  if (!globalSocket || globalSocket.readyState >= WebSocket.CLOSING) {
    globalSocket = new WebSocket(getWsUrl());

    globalSocket.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          event?: { type: string; data: Record<string, unknown> };
        };
        // 仅处理服务端 update:available 事件（通过 emitEvent 推送过来的）
        if (msg.type === "event" && msg.event?.type === "update:available") {
          const { current, latest, releaseUrl, source } = msg.event.data as {
            current: string;
            latest: string;
            releaseUrl: string;
            source: string;
          };
          const info: VersionInfo = {
            current,
            latest,
            releaseUrl,
            source: source as VersionInfo["source"],
            outdated: true,
            success: true,
          };
          listeners.forEach((fn) => fn(info));
        }
      } catch {
        // 非 JSON 或格式不匹配的消息忽略
      }
    };

    // 🔧 连接成功 → 重置退避计数器，下次断连从 1s 重新开始
    globalSocket.onopen = () => {
      reconnectAttempts = 0;
    };

    // 🔧 被动断连（非主动关闭）→ 自动重连
    globalSocket.onclose = () => {
      if (listeners.size > 0) scheduleReconnect();
    };

    // onerror 之后通常跟随 onclose，重连逻辑集中在 onclose 中
    globalSocket.onerror = () => {
      /* 静默，重连由 onclose 触发 */
    };
  }
  return globalSocket;
}

/**
 * 监听 WebSocket 推送的版本更新事件。
 *
 * @returns 收到推送时返回 VersionInfo；未收到时返回 null
 */
export function useVersionWebSocket(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    // 触发 WebSocket 连接建立（全局单例，多次调用不会重复建连）
    getSocket();

    const handler = (newInfo: VersionInfo) => {
      if (mountedRef.current) setInfo(newInfo);
    };
    listeners.add(handler);

    return () => {
      mountedRef.current = false;
      listeners.delete(handler);
      // 所有订阅者都已卸载 → 取消重连定时器，避免后台泄漏
      if (listeners.size === 0 && reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        reconnectAttempts = 0;
      }
    };
  }, []);

  return info;
}
