/**
 * Video Provider Templates REST API — 视频 Agent 模型配置模板管理。
 *
 * 端点：
 *   GET    /api/video/provider-templates      — 列出所有模板（含系统预设）
 *   POST   /api/video/provider-templates      — 创建用户自定义模板
 *   PUT    /api/video/provider-templates/:id   — 更新用户模板（系统预设不可改）
 *   DELETE /api/video/provider-templates/:id   — 删除用户模板（系统预设不可删）
 *
 * @see video-crew-provider-presets.ts 系统预设常量
 * @see sqlite.ts agent_provider_templates 表
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getProviderTemplates,
  insertProviderTemplate,
  updateProviderTemplate,
  deleteProviderTemplate,
  PROVIDER_PRESETS,
} from "@super-agent/core";
import type { ProviderTemplateRow } from "@super-agent/core";

// ─── Zod 校验 ──────────────────────────────────────────────

const AgentProviderOverrideSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

const CreateTemplateSchema = z.object({
  /** 模板名称 */
  name: z.string().min(1).max(100),
  /** 模板说明（可选） */
  description: z.string().max(500).optional(),
  /** 每个 Agent 的模型覆盖配置 */
  providers: z.record(AgentProviderOverrideSchema),
});

// PUT 允许部分更新：三个字段都为可选，但至少得带一个
const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  providers: z.record(AgentProviderOverrideSchema).optional(),
});

// ─── 路由注册 ──────────────────────────────────────────────

export async function videoProviderTemplateRoutes(app: FastifyInstance): Promise<void> {

  // ─── GET /api/video/provider-templates ───────────────────
  // 返回系统预设 + 用户模板，系统预设始终在前
  // DB 为空时回退 PROVIDER_PRESETS 内存常量，确保首次使用即可看到 6 套预设
  app.get("/api/video/provider-templates", async (_request, reply) => {
    try {
      const rows = getProviderTemplates();

      // 收集 DB 中已有的预设 ID，用于去重
      const dbPresetIds = new Set(
        rows.filter((r: ProviderTemplateRow) => r.is_preset === 1).map((r: ProviderTemplateRow) => r.id)
      );

      // 将 DB 行转为前端友好的 JSON 格式
      // 系统预设优先从内存 PROVIDER_PRESETS 解析（DB 只存标识符）
      const templates = rows.map((row: ProviderTemplateRow) => {
        const isPreset = row.is_preset === 1;
        let providers: Record<string, unknown>;
        if (isPreset) {
          const presetMatch = PROVIDER_PRESETS.find((p) => p.id === row.id);
          providers = presetMatch ? presetMatch.providers : JSON.parse(row.providers_json);
        } else {
          providers = JSON.parse(row.providers_json);
        }
        return {
          id: row.id,
          name: row.name,
          description: row.description ?? "",
          providers,
          isPreset,
          createdAt: row.created_at,
        };
      });

      // 回退：DB 中缺失的系统预设从内存 PROVIDER_PRESETS 补全
      // （迁移 V16 可能未执行或 DB 重建后丢失，6 套预设必须始终可用）
      const missingPresets = PROVIDER_PRESETS.filter(
        (p) => !dbPresetIds.has(p.id)
      );
      if (missingPresets.length > 0) {
        const fallbackTemplates = missingPresets.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          providers: p.providers,
          isPreset: true,
          createdAt: 0, // 内存回退无时间戳，前端排序时自然沉底
        }));
        // 系统预设插入到数组头部（在 DB 用户模板之前）
        return reply.send({ templates: [...fallbackTemplates, ...templates] });
      }

      return reply.send({ templates });
    } catch (err) {
      app.log.error({ err }, "Failed to list provider templates");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ─── POST /api/video/provider-templates ──────────────────
  // 创建用户自定义模板
  app.post("/api/video/provider-templates", async (request, reply) => {
    const parsed = CreateTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid template data",
        details: parsed.error.issues,
      });
    }

    const { name, description, providers } = parsed.data;
    const id = `tpl_${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    try {
      const row: ProviderTemplateRow = {
        id,
        name,
        description: description ?? null,
        providers_json: JSON.stringify(providers),
        is_preset: 0,
        created_at: now,
      };
      insertProviderTemplate(row);

      return reply.status(201).send({
        id,
        name,
        description: description ?? "",
        providers,
        isPreset: false,
        createdAt: now,
      });
    } catch (err) {
      app.log.error({ err }, "Failed to create provider template");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ─── PUT /api/video/provider-templates/:id ────────────────
  // 更新用户模板的 name/description/providers（部分字段），系统预设不可改
  app.put("/api/video/provider-templates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    // 禁止直接通过 PUT 修改系统预设（即便能命中 id，updateProviderTemplate
    // 的 WHERE is_preset = 0 也会拦截，但在这里提前返回更清晰）
    if (PROVIDER_PRESETS.some((p) => p.id === id)) {
      return reply.status(403).send({
        error: "System preset cannot be modified. Clone it as a user template first.",
      });
    }

    const parsed = UpdateTemplateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid template data",
        details: parsed.error.issues,
      });
    }

    const { name, description, providers } = parsed.data;
    if (name === undefined && description === undefined && providers === undefined) {
      return reply.status(400).send({ error: "At least one of name/description/providers is required" });
    }

    try {
      const updated = updateProviderTemplate(id, {
        name,
        description: description ?? undefined,
        providers_json: providers ? JSON.stringify(providers) : undefined,
      });
      if (!updated) {
        return reply.status(404).send({
          error: "Template not found or is a system preset (cannot modify)",
        });
      }

      // 读回当前记录返回给前端，便于其同步本地 state
      const all = getProviderTemplates();
      const row = all.find((r) => r.id === id);
      if (!row) {
        // 理论不会发生，兜底处理
        return reply.status(404).send({ error: "Template disappeared after update" });
      }
      return reply.send({
        id: row.id,
        name: row.name,
        description: row.description ?? "",
        providers: JSON.parse(row.providers_json),
        isPreset: row.is_preset === 1,
        createdAt: row.created_at,
      });
    } catch (err) {
      app.log.error({ err }, "Failed to update provider template");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // ─── DELETE /api/video/provider-templates/:id ────────────
  // 仅允许删除用户模板，系统预设不可删
  app.delete("/api/video/provider-templates/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const deleted = deleteProviderTemplate(id);
      if (!deleted) {
        return reply.status(404).send({
          error: "Template not found or is a system preset (cannot delete)",
        });
      }
      return reply.status(204).send();
    } catch (err) {
      app.log.error({ err }, "Failed to delete provider template");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
