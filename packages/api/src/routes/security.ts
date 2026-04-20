/**
 * Security REST API routes.
 *
 * Policies:
 *   GET    /api/security/policies              — List all policies
 *   GET    /api/security/policies/:id          — Get a policy
 *   PUT    /api/security/policies/:id          — Create/update a policy
 *   DELETE /api/security/policies/:id          — Delete a policy
 *
 * Permissions:
 *   POST   /api/security/check                 — Check tool permission
 *
 * Credentials:
 *   GET    /api/security/credentials           — List credentials (no values)
 *   POST   /api/security/credentials           — Store a credential
 *   DELETE /api/security/credentials/:name     — Delete a credential
 *
 * Audit:
 *   GET    /api/security/audit                 — Get audit log
 *
 * Stats:
 *   GET    /api/security/stats                 — Get security stats
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { queryConfigAuditLog } from "@super-agent/core";
import { requirePermission } from "../auth/index.js";

export async function securityRoutes(app: FastifyInstance, ctx: AppContext) {
  const security = ctx.securityManager;

  // ─── Policies ──────────────────────────────────────────────

  app.get("/api/security/policies", async (_req, reply) => {
    return reply.send(security.listPolicies());
  });

  app.get("/api/security/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const policy = security.getPolicy(id);
    if (!policy) return reply.status(404).send({ error: "Policy not found" });
    return reply.send(policy);
  });

  app.put("/api/security/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name: string;
      description?: string;
      defaultSandbox?: string;
      defaultPermission?: string;
      toolPermissions?: Array<{
        toolName: string;
        action: string;
        sandboxLevel: string;
        restrictions?: Record<string, unknown>;
      }>;
      blockedTools?: string[];
      maxConcurrentSandboxes?: number;
      auditEnabled?: boolean;
    };

    if (!body?.name) {
      return reply.status(400).send({ error: "name is required" });
    }

    security.setPolicy({
      id,
      name: body.name,
      description: body.description,
      defaultSandbox: (body.defaultSandbox as any) ?? "none",
      defaultPermission: (body.defaultPermission as any) ?? "allow",
      toolPermissions: (body.toolPermissions as any) ?? [],
      blockedTools: body.blockedTools ?? [],
      maxConcurrentSandboxes: body.maxConcurrentSandboxes ?? 10,
      auditEnabled: body.auditEnabled ?? true,
    });

    return reply.send(security.getPolicy(id));
  });

  app.delete("/api/security/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === "default") {
      return reply.status(400).send({ error: "Cannot delete default policy" });
    }
    const result = security.deletePolicy(id);
    return reply.send({ deleted: result });
  });

  // ─── Permissions ───────────────────────────────────────────

  app.post("/api/security/check", async (req, reply) => {
    const body = req.body as {
      toolName: string;
      agentId: string;
      policyId?: string;
    };

    if (!body?.toolName || !body?.agentId) {
      return reply.status(400).send({ error: "toolName and agentId are required" });
    }

    const result = security.checkPermission(body.toolName, body.agentId, body.policyId);
    return reply.send(result);
  });

  // ─── Credentials ───────────────────────────────────────────

  app.get("/api/security/credentials", {
    preHandler: requirePermission("*"),
  }, async (_req, reply) => {
    return reply.send({ credentials: security.listCredentials() });
  });

  app.post("/api/security/credentials", {
    preHandler: requirePermission("*"),
  }, async (req, reply) => {
    const body = req.body as {
      name: string;
      value: string;
      description?: string;
      allowedAgents?: string[];
      allowedTools?: string[];
    };

    if (!body?.name || !body?.value) {
      return reply.status(400).send({ error: "name and value are required" });
    }

    const entry = security.storeCredential(body.name, body.value, {
      description: body.description,
      allowedAgents: body.allowedAgents,
      allowedTools: body.allowedTools,
    });

    return reply.send(entry);
  });

  app.delete("/api/security/credentials/:name", {
    preHandler: requirePermission("*"),
  }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = security.deleteCredential(name);
    return reply.send({ deleted: result });
  });

  // ─── Audit ─────────────────────────────────────────────────

  app.get("/api/security/audit", async (req, reply) => {
    const query = req.query as {
      limit?: string;
      action?: string;
      agentId?: string;
      category?: string;
    };

    // If category=config, use the config audit log query
    if (query.category === "config") {
      const entries = queryConfigAuditLog({
        category: "config",
        action: query.action,
        agentId: query.agentId,
        limit: query.limit ? parseInt(query.limit, 10) : 100,
      });
      return reply.send({ entries });
    }

    const entries = security.getAuditLog({
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      action: query.action as any,
      agentId: query.agentId,
    });

    return reply.send({ entries });
  });

  // ─── Stats ─────────────────────────────────────────────────

  app.get("/api/security/stats", async (_req, reply) => {
    return reply.send(security.getStats());
  });

  app.log.info("Security routes registered");
}
