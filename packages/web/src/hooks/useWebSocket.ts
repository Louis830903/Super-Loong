"use client";

/**
 * useWebSocket — 通用 WebSocket 实时事件 Hook
 *
 * 连接后端 /ws 端点，支持主题订阅、心跳保活、断线指数退避重连。
 * 后端协议: action="subscribe"/"unsubscribe"/"ping"
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { WS_BASE } from "@/lib/utils";

// ─── 类型定义 ──────────────────────────────────────────────

export interface WsEvent {
  topic: string;
  data: unknown;
  timestamp: number;
}

interface UseWebSocketOptions {
  /** 订阅的事件主题列表，支持通配符如 "agent:*" */
  topics: string[];
  /** 是否自动连接，默认 true */
  autoConnect?: boolean;
  /** 历史事件缓冲区大小，默认 50 */
  maxEvents?: number;
}

interface UseWebSocketReturn {
  /** WebSocket 连接状态 */
  connected: boolean;
  /** 最新收到的事件 */
  lastEvent: WsEvent | null;
  /** 历史事件缓冲 */
  events: WsEvent[];
  /** 手动触发重连 */
  reconnect: () => void;
}

// ─── 常量 ──────────────────────────────────────────────────

/** 心跳间隔: 25 秒（服务端 30 秒检测，留 5 秒裕量） */
const HEARTBEAT_INTERVAL = 25_000;

/** 最大重连间隔: 30 秒 */
const MAX_RECONNECT_DELAY = 30_000;

/** 初始重连间隔: 1 秒 */
const INITIAL_RECONNECT_DELAY = 1_000;

// ─── Hook 实现 ─────────────────────────────────────────────

export const useWebSocket = (options: UseWebSocketOptions): UseWebSocketReturn => {
  const { topics, autoConnect = true, maxEvents = 50 } = options;

  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const [events, setEvents] = useState<WsEvent[]>([]);

  // 使用 ref 保持实例，避免 useEffect 重复创建
  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const mountedRef = useRef(true);
  const topicsRef = useRef(topics);
  topicsRef.current = topics;

  /** 清理心跳和重连定时器 */
  const cleanup = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /** 发送 JSON 消息到 WebSocket */
  const send = useCallback((data: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  /** 安排重连（指数退避: 1s → 2s → 4s → 8s → ... → 30s） */
  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (!mountedRef.current) return;
    const delay = reconnectDelayRef.current;
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connectFn();
    }, delay);
    // 指数退避，最大 30 秒
    reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
  }, []);

  /** 建立 WebSocket 连接 */
  const connect = useCallback(() => {
    // 避免重复连接
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    // 关闭旧连接
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
    }

    cleanup();

    try {
      const ws = new WebSocket(`${WS_BASE}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        setConnected(true);
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;

        // 订阅指定主题（后端协议使用 action 字段）
        send({ action: "subscribe", topics: topicsRef.current });

        // 启动心跳
        heartbeatRef.current = setInterval(() => {
          send({ action: "ping" });
        }, HEARTBEAT_INTERVAL);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data);

          // 只处理事件消息（忽略 connected/subscribed/pong 等控制消息）
          if (msg.type === "event" && msg.event) {
            const wsEvent: WsEvent = {
              topic: msg.event.type,
              data: msg.event.data,
              timestamp: new Date(msg.event.timestamp).getTime(),
            };
            setLastEvent(wsEvent);
            setEvents((prev) => {
              const next = [wsEvent, ...prev];
              return next.length > maxEvents ? next.slice(0, maxEvents) : next;
            });
          }
        } catch {
          // 忽略非 JSON 消息
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        cleanup();
        scheduleReconnect(connect);
      };

      ws.onerror = () => {
        // onclose 会紧随触发，无需额外处理
      };
    } catch {
      // WebSocket 构造函数异常（如 URL 无效），安排重连
      setConnected(false);
      scheduleReconnect(connect);
    }
  }, [cleanup, send, scheduleReconnect, maxEvents]);

  /** 手动重连 */
  const reconnect = useCallback(() => {
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
    }
    connect();
  }, [connect]);

  // 自动连接 & 卸载清理
  useEffect(() => {
    mountedRef.current = true;
    if (autoConnect) connect();

    return () => {
      mountedRef.current = false;
      cleanup();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }
    };
  }, [autoConnect, connect, cleanup]);

  return { connected, lastEvent, events, reconnect };
};
