/**
 * Service Config Routes — 非 LLM 外部服务配置管理。
 *
 * GET    /api/services                 — 列出所有服务 + 配置状态
 * GET    /api/services/:id             — 查看单个服务配置（Key 掩码）
 * PUT    /api/services/:id             — 更新服务配置
 * DELETE /api/services/:id             — 清除服务配置
 * POST   /api/services/browser/detect  — 触发本地浏览器探测
 */

import type { FastifyInstance } from "fastify";
import { SERVICE_CATALOG, syncEnvVarToFile } from "@super-agent/core";
import type { AppContext } from "../context.js";
import type { ServiceCatalogEntry, ServiceInfo } from "@super-agent/core";
import { sendSuccess, Errors } from "./response-helper.js";

export async function serviceRoutes(app: FastifyInstance, ctx: AppContext) {
  // ── GET /api/services ──────────────────────────────────
  app.get("/api/services", async (_req, reply) => {
    const services = ctx.configStore.listServices();
    return sendSuccess(reply, { services });
  });

  // ── GET /api/services/:id ──────────────────────────────
  app.get<{ Params: { id: string } }>("/api/services/:id", async (request, reply) => {
    const { id } = request.params;
    const catalog = SERVICE_CATALOG.find((s: ServiceCatalogEntry) => s.id === id);
    if (!catalog) {
      return Errors.notFound(reply, `Unknown service: ${id}`);
    }
    const services = ctx.configStore.listServices();
    const service = services.find((s: ServiceInfo) => s.id === id);
    return sendSuccess(reply, { service: service ?? null });
  });

  // ── PUT /api/services/:id ──────────────────────────────
  app.put<{ Params: { id: string }; Body: Record<string, string> }>(
    "/api/services/:id",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as Record<string, string>;
      const catalog = SERVICE_CATALOG.find((s: ServiceCatalogEntry) => s.id === id);
      if (!catalog) {
        return Errors.notFound(reply, `Unknown service: ${id}`);
      }
      // 逐个保存配置项
      const validKeys = catalog.keys.map((k: { key: string }) => k.key);
      for (const [key, value] of Object.entries(body)) {
        if (validKeys.includes(key) && value !== undefined) {
          ctx.configStore.set(id, key, value);

          // 同步到 .env 文件和 process.env，确保 Python 子进程（video-forge 等）能读取
          const keyDef = catalog.keys.find((k) => k.key === key);
          if (keyDef?.envKey && value) {
            process.env[keyDef.envKey] = value;
            syncEnvVarToFile(keyDef.envKey, value);

            // RunningHub API Key 热更新：通知 Python video-forge 服务即时生效，无需重启
            if (id === "runninghub" && keyDef.envKey === "RUNNINGHUB_API_KEY") {
              const vfUrl = process.env.VIDEO_FORGE_URL || "http://127.0.0.1:8199";
              try {
                const resp = await fetch(`${vfUrl}/admin/reload-config`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ runninghub_api_key: value }),
                  signal: AbortSignal.timeout(5000),
                });
                if (resp.ok) {
                  app.log.info("[services] RunningHub API Key 已同步到 Python video-forge 服务（热更新）");
                } else {
                  app.log.warn("[services] Python video-forge 热更新返回非 200: %s", resp.status);
                }
              } catch (err: any) {
                // video-forge 可能未启动或不可达，不影响主流程
                app.log.warn("[services] Python video-forge 热更新通知失败（服务可能未启动）: %s", err.message);
              }
            }
          }
        }
      }
      // 返回更新后的状态
      const services = ctx.configStore.listServices();
      const service = services.find((s: ServiceInfo) => s.id === id);
      return sendSuccess(reply, { service });
    }
  );

  // ── DELETE /api/services/:id ───────────────────────────
  app.delete<{ Params: { id: string } }>(
    "/api/services/:id",
    async (request, reply) => {
      const { id } = request.params;
      const catalog = SERVICE_CATALOG.find((s: ServiceCatalogEntry) => s.id === id);
      if (!catalog) {
        return Errors.notFound(reply, `Unknown service: ${id}`);
      }
      ctx.configStore.delete(id);
      return sendSuccess(reply, { success: true });
    }
  );

  // ── POST /api/services/browser/detect ──────────────────
  // 探测本地安装的浏览器，返回找到的路径
  app.post("/api/services/browser/detect", async (_req, reply) => {
    const { existsSync } = await import("node:fs");
    const platform = process.platform;
    const candidates: Array<{ name: string; path: string }> = [];

    if (platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA ?? "";
      candidates.push(
        { name: "Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" },
        { name: "Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
        { name: "Chrome", path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` },
        { name: "Brave", path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
      );
    } else if (platform === "darwin") {
      candidates.push(
        { name: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
        { name: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
        { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
      );
    } else {
      candidates.push(
        { name: "Edge", path: "/usr/bin/microsoft-edge" },
        { name: "Chrome", path: "/usr/bin/google-chrome" },
        { name: "Brave", path: "/usr/bin/brave-browser" },
      );
    }

    const found = candidates.filter(c => existsSync(c.path));
    return sendSuccess(reply, {
      platform,
      detected: found,
      recommended: found.length > 0 ? found[0] : null,
    });
  });
}
