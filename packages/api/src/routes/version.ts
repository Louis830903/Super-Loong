/**
 * GET /api/version — 版本检查与更新通知
 *
 * 调用 core 的 checkForUpdates() 查询 GitHub Releases 最新版本，
 * 返回当前版本、远端版本、是否有更新及 Release 页面链接。
 *
 * 返回类型与 @super-agent/web-types 的 VersionInfo 保持一致。
 *
 * TTL 缓存：1 小时内重复请求直接返回缓存，避免频繁调用 GitHub API。
 */

import type { FastifyInstance } from "fastify";
import { checkForUpdates, type VersionCheckResult } from "@super-agent/core";
import { sendSuccess } from "./response-helper.js";

/** 缓存 TTL：1 小时 */
const CACHE_TTL_MS = 60 * 60 * 1000;

let cachedResult: { data: VersionCheckResult; timestamp: number } | null = null;

export function versionRoutes(app: FastifyInstance): void {
  app.get("/api/version", async (_request, reply) => {
    // 缓存命中且未过期 — 直接返回
    if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
      return sendSuccess(reply, cachedResult.data);
    }

    const result = await checkForUpdates(undefined, 5000);

    // 仅成功查询才缓存（失败不缓存，下次请求可重试）
    if (result.success) {
      cachedResult = { data: result, timestamp: Date.now() };
    }

    return sendSuccess(reply, result);
  });
}
