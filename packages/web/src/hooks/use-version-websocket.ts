"use client";

/**
 * 版本更新 WebSocket 单例 hook。
 *
 * 设计要点：
 * - 全局单例 WebSocket 连接（所有 VersionFooter 实例共享），避免双重连接
 * - 监听 "update:available" 事件，解析为 VersionInfo 状态
 * - 返回 null 表示尚未收到推送（与初始状态区分）
 * - 不做 Notification.requestPermission()，仅更新 UI 状态（避免突兀弹窗）
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
    };
  }, []);

  return info;
}
