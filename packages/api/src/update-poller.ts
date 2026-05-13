/**
 * 定时版本轮询器 — 后台定期检查 GitHub/Gitee 最新版本，
 * 发现更新后通过 WebSocket 事件总线主动推送给所有已连接的前端客户端。
 *
 * 设计原则：
 * - 独立模块，不依赖路由层（直接调用 core 的 checkForUpdates，绕过 /api/version 缓存）
 * - 通过 emitEvent 推送（绕过 /api/ws/broadcast 的 RBAC 鉴权限制）
 * - 返回 stop 函数供 graceful shutdown 调用，避免 setInterval 泄漏
 * - 同一版本仅推送一次（lastNotifiedVersion 去重）
 */

import { checkForUpdates } from "@super-agent/core";
import { emitEvent } from "./ws/index.js";
import type { FastifyInstance } from "fastify";

/** 轮询间隔：6 小时 */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 启动定时版本轮询器。
 *
 * @param app  Fastify 实例（仅用于日志，不绑定生命周期）
 * @returns   停止函数，调用后清理 setInterval
 */
export function startUpdatePoller(app: FastifyInstance): () => void {
  let lastNotifiedVersion: string | null = null;

  const poll = async () => {
    try {
      // 直接调用 core 的 checkForUpdates()，天然绕过路由层 1h TTL 缓存
      const result = await checkForUpdates();
      if (result.outdated && result.latest && result.latest !== lastNotifiedVersion) {
        lastNotifiedVersion = result.latest;
        // 通过事件总线推送至所有 WebSocket 客户端（admin/* 订阅均可见）
        emitEvent("update:available", {
          current: result.current,
          latest: result.latest,
          releaseUrl: result.releaseUrl ?? "",
          source: result.source ?? "",
        });
        app.log.info(
          { current: result.current, latest: result.latest },
          "版本更新广播已推送"
        );
      }
    } catch {
      // 轮询失败静默忽略（网络不可用、API 限流等不构成故障）
    }
  };

  // 首次延迟 30s 启动（避免与 Phase 1 启动检查并发请求）
  const initialTimer = setTimeout(poll, 30_000);
  // 后续每 6 小时轮询
  const timer = setInterval(poll, POLL_INTERVAL_MS);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
