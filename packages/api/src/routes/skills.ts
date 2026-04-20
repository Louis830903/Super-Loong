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
  app.get("/api/skills", async () => {
    return { skills: ctx.skillLoader.listSkills().map(serializeSkill) };
  });

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const skill = ctx.skillLoader.getSkill(request.params.id);
    if (!skill) {
      return reply.status(404).send({ error: "Skill not found" });
    }
    return { skill: serializeSkill(skill) };
  });

  // Update skill (enable/disable)
  app.put<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    const body = request.body as { enabled?: boolean };
    const skill = ctx.skillLoader.updateSkill(request.params.id, body);
    if (!skill) {
      return reply.status(404).send({ error: "Skill not found" });
    }
    return { skill };
  });

  app.post("/api/skills/reload", async () => {
    const skills = ctx.skillLoader.loadAll();
    return { reloaded: skills.length };
  });

  // ─── Marketplace ────────────────────────────────────────

  if (ctx.skillMarketplace) {
    const marketplace = ctx.skillMarketplace;

    /** Search remote marketplace */
    app.get<{
      Querystring: { q: string; source?: string };
    }>("/api/skills/marketplace/search", async (request, reply) => {
      const { q, source } = request.query;
      if (!q) return reply.status(400).send({ error: "q parameter is required" });
      const results = await marketplace.search(q, { source });
      return { results, total: results.length };
    });

    /** Install a skill from marketplace */
    app.post<{
      Body: { sourceUrl: string; sourceName?: string };
    }>("/api/skills/marketplace/install", async (request, reply) => {
      const { sourceUrl, sourceName } = request.body ?? {};
      if (!sourceUrl) return reply.status(400).send({ error: "sourceUrl is required" });
      const result = await marketplace.install(sourceUrl, sourceName);
      if (!result.success) {
        return reply.status(500).send({ error: result.error });
      }
      // Reload skills to pick up the new file
      ctx.skillLoader.loadAll();
      return reply.status(201).send(result);
    });

    /** List installed skills */
    app.get("/api/skills/installed", async () => {
      return { skills: marketplace.listInstalled() };
    });

    /** Uninstall a skill */
    app.post<{ Params: { id: string } }>("/api/skills/:id/uninstall", async (request, reply) => {
      try {
        await marketplace.uninstall(request.params.id);
        ctx.skillLoader.loadAll();
        return { status: "uninstalled" };
      } catch (err: any) {
        return reply.status(500).send({ error: err.message });
      }
    });

    /** Get marketplace sources */
    app.get("/api/skills/marketplace/sources", async () => {
      return { sources: marketplace.getSources() };
    });
  }
}
