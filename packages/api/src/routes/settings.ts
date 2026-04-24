/**
 * Settings REST API routes.
 *
 * Feature Flags:
 *   GET  /api/settings/flags       — 读取所有能力模块开关状态
 *   PUT  /api/settings/flags       — 批量更新能力模块开关
 *
 * 持久化策略: Flag 变更同时写入 process.env（立即生效）和 ConfigStore（重启恢复）。
 * 工具热加载: Flag 变更后自动失效工具缓存并重新加载，新工具即时注册到所有 Agent。
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requirePermission } from "../auth/index.js";
import { getConfigStore, invalidateToolCache, getAllBuiltinTools, builtinTools, injectSysopsSecurityRules } from "@super-agent/core";

/** 支持的 Feature Flag 列表及其描述 */
const FLAG_DEFS = [
  {
    key: "SUPER_AGENT_SYSOPS_ENABLED",
    label: "系统操作总开关",
    description: "启用后解锁终端引擎及所有子模块",
    group: "sysops",
  },
  {
    key: "SUPER_AGENT_OPS_TOOLS",
    label: "运维工具集",
    description: "Docker/服务/网络/监控/部署工具",
    group: "sysops",
    parent: "SUPER_AGENT_SYSOPS_ENABLED",
  },
  {
    key: "SUPER_AGENT_DEV_TOOLS",
    label: "开发辅助工具集",
    description: "Git高级/包管理/测试构建/环境管理",
    group: "sysops",
    parent: "SUPER_AGENT_SYSOPS_ENABLED",
  },
  {
    key: "SUPER_AGENT_DESKTOP_TOOLS",
    label: "桌面控制工具集",
    description: "GUI控制/屏幕截图/应用管理",
    group: "sysops",
    parent: "SUPER_AGENT_SYSOPS_ENABLED",
  },
  {
    key: "SUPER_AGENT_COMPUTER_USE",
    label: "Computer Use 循环",
    description: "自主桌面操作循环（需桌面工具集）",
    group: "sysops",
    parent: "SUPER_AGENT_SYSOPS_ENABLED",
  },
] as const;

type FlagKey = typeof FLAG_DEFS[number]["key"];

export async function settingsRoutes(app: FastifyInstance, _ctx: AppContext) {

  // ─── GET /api/settings/flags ─────────────────────────────
  // 返回所有 Feature Flag 的当前状态
  app.get("/api/settings/flags", async (_req, reply) => {
    const flags = FLAG_DEFS.map((def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      group: def.group,
      parent: "parent" in def ? def.parent : undefined,
      enabled: process.env[def.key] === "true",
    }));
    return reply.send({ flags });
  });

  // ─── PUT /api/settings/flags ─────────────────────────────
  // 批量更新 Feature Flag: { flags: { "SUPER_AGENT_SYSOPS_ENABLED": true, ... } }
  // 注意: 仅影响当前进程，重启后回到 .env 定义的值
  // 需要管理员权限 — 防止未认证用户修改安全开关
  app.put("/api/settings/flags", {
    preHandler: requirePermission("*"),
  }, async (req, reply) => {
    const body = req.body as { flags?: Record<string, boolean> } | undefined;

    if (!body?.flags || typeof body.flags !== "object") {
      return reply.status(400).send({ error: "body.flags is required (Record<string, boolean>)" });
    }

    const validKeys = new Set<string>(FLAG_DEFS.map((d) => d.key));
    const updated: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(body.flags)) {
      if (!validKeys.has(key)) continue;
      // 当子开关开启但父开关关闭时，自动开启父开关
      const def = FLAG_DEFS.find((d) => d.key === key);
      if (value && def && "parent" in def && def.parent) {
        process.env[def.parent] = "true";
        updated[def.parent] = true;
      }
      process.env[key] = value ? "true" : "false";
      updated[key] = value;
    }

    // 当总开关关闭时，联动关闭所有子开关
    if (body.flags["SUPER_AGENT_SYSOPS_ENABLED"] === false) {
      for (const def of FLAG_DEFS) {
        if ("parent" in def && def.parent === "SUPER_AGENT_SYSOPS_ENABLED") {
          process.env[def.key] = "false";
          updated[def.key] = false;
        }
      }
    }

    // ── 持久化到 ConfigStore（SQLite 数据库，重启后恢复） ──
    const configStore = getConfigStore();
    for (const [key, value] of Object.entries(updated)) {
      configStore.set("feature_flags", key, value ? "true" : "false", false);
    }

    // ── 工具热加载：失效缓存 → 重新加载 → 注册新工具 ──
    try {
      invalidateToolCache();
      const allTools = await getAllBuiltinTools();
      const optionalTools = allTools.slice(builtinTools.length);
      // registerGlobalTool 基于 Map<name, tool>，重复注册自动去重
      for (const tool of optionalTools) {
        _ctx.agentManager.registerGlobalTool(tool);
      }
      // SysOps 安全策略同步
      if (process.env.SUPER_AGENT_SYSOPS_ENABLED === "true") {
        injectSysopsSecurityRules(_ctx.securityManager as any);
      }
      app.log.info({ toolCount: allTools.length }, "Tools hot-reloaded after flag change");
    } catch (err: any) {
      app.log.warn({ error: err.message }, "Tool hot-reload failed (restart may be needed)");
    }

    // 返回更新后的完整状态
    const flags = FLAG_DEFS.map((def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      group: def.group,
      parent: "parent" in def ? def.parent : undefined,
      enabled: process.env[def.key] === "true",
    }));

    app.log.info({ updated }, "Feature flags updated (persisted to ConfigStore)");
    return reply.send({ flags, updated });
  });

  app.log.info("Settings routes registered");
}
