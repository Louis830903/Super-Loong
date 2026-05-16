/**
 * Skills Routes — manage skills and marketplace.
 *
 * GET    /api/skills                    — List all loaded skills
 * GET    /api/skills/:id                — Get skill details
 * PUT    /api/skills/:id                — Update skill (enable/disable)
 * POST   /api/skills/reload             — Force reload all skills
 * GET    /api/skills/marketplace/search  — Search remote marketplace
 * POST   /api/skills/marketplace/install — Install from remote
 * GET    /api/skills/installed           — List installed skills
 * POST   /api/skills/:id/uninstall       — Uninstall a skill
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { sendSuccess, Errors } from "./response-helper.js";

/** Flatten a Skill object for the frontend (frontmatter → top-level fields). */
function serializeSkill(s: any) {
  return {
    id: s.id,
    name: s.frontmatter?.name ?? s.id,
    description: s.frontmatter?.description ?? "",
    version: s.frontmatter?.version ?? "",
    enabled: s.enabled ?? true,
    triggers: s.frontmatter?.triggers ?? [],
    content: s.content ?? "",
    filePath: s.filePath,
    loadedAt: s.loadedAt,
  };
}

export async function skillRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/skills", async (_req, reply) => {
    return sendSuccess(reply, { skills: ctx.skillLoader.listSkills().map(serializeSkill) });
  });

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const skill = ctx.skillLoader.getSkill(request.params.id);
    if (!skill) {
      return Errors.notFound(reply, "Skill not found");
    }
    return sendSuccess(reply, { skill: serializeSkill(skill) });
  });

  // Update skill (enable/disable)
  app.put<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const body = request.body as { enabled?: boolean };
    const skill = ctx.skillLoader.updateSkill(request.params.id, body);
    if (!skill) {
      return Errors.notFound(reply, "Skill not found");
    }
    return sendSuccess(reply, { skill });
  });

  app.post("/api/skills/reload", async (_req, reply) => {
    const skills = ctx.skillLoader.loadAll();
    return sendSuccess(reply, { reloaded: skills.length });
  });

  // ─── Marketplace ────────────────────────────────────────

  if (ctx.skillMarketplace) {
    const marketplace = ctx.skillMarketplace;

    /** Search remote marketplace */
    app.get<{
      Querystring: { q: string; source?: string };
    }>("/api/skills/marketplace/search", async (request, reply) => {
      const { q, source } = request.query;
      if (!q) return Errors.badRequest(reply, "q parameter is required");
      const results = await marketplace.search(q, { source });
      return sendSuccess(reply, { results, total: results.length });
    });

    /** Install a skill from marketplace */
    app.post<{
      Body: { sourceUrl: string; sourceName?: string };
    }>("/api/skills/marketplace/install", async (request, reply) => {
      const { sourceUrl, sourceName } = request.body ?? {};
      if (!sourceUrl) return Errors.badRequest(reply, "sourceUrl is required");
      const result = await marketplace.install(sourceUrl, sourceName);
      if (!result.success) {
        return Errors.internal(reply, result.error);
      }
      // Reload skills to pick up the new file
      ctx.skillLoader.loadAll();
      return sendSuccess(reply, result, 201);
    });

    /** List installed skills */
    app.get("/api/skills/installed", async (_req, reply) => {
      return sendSuccess(reply, { skills: marketplace.listInstalled() });
    });

    /** Uninstall a skill */
    app.post<{ Params: { id: string } }>("/api/skills/:id/uninstall", async (request, reply) => {
      try {
        await marketplace.uninstall(request.params.id);
        ctx.skillLoader.loadAll();
        return sendSuccess(reply, { status: "uninstalled" });
      } catch (err: any) {
        app.log.error({ id: request.params.id, err }, "Skill uninstall failed");
        return Errors.internal(reply, "Skill uninstall failed");
      }
    });

    /** Get marketplace sources */
    app.get("/api/skills/marketplace/sources", async (_req, reply) => {
      return sendSuccess(reply, { sources: marketplace.getSources() });
    });
  }
}
