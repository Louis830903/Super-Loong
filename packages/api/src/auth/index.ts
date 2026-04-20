/**
 * Authentication & Authorization module.
 *
 * Supports:
 * - API Key authentication (header: X-API-Key)
 * - JWT Bearer token authentication
 * - Role-Based Access Control (RBAC)
 *
 * Enable via AUTH_ENABLED=true in environment.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fastifyJwt from "@fastify/jwt";
import pino from "pino";
import type { AppContext } from "../context.js";

const logger = pino({ name: "auth" });

// ─── Types ───────────────────────────────────────────────────

export type Role = "admin" | "operator" | "viewer" | "agent";

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  apiKey?: string;
  iat?: number;
  exp?: number;
}

export interface ApiKeyRecord {
  key: string;
  name: string;
  role: Role;
  createdAt: Date;
  lastUsedAt: Date | null;
  enabled: boolean;
}

// ─── Permission Matrix ───────────────────────────────────────

const PERMISSIONS: Record<Role, Set<string>> = {
  admin: new Set(["*"]),
  operator: new Set([
    "agents:read", "agents:write",
    "chat:read", "chat:write",
    "skills:read", "skills:write",
    "channels:read", "channels:write",
    "memory:read", "memory:write",
    "sessions:read", "sessions:write",
  ]),
  viewer: new Set([
    "agents:read", "chat:read", "skills:read",
    "channels:read", "memory:read", "sessions:read",
  ]),
  agent: new Set([
    "chat:read", "chat:write",
    "memory:read", "memory:write",
    "sessions:read",
  ]),
};

export function hasPermission(role: Role, permission: string): boolean {
  const perms = PERMISSIONS[role];
  return perms.has("*") || perms.has(permission);
}

// ─── In-Memory API Key Store ─────────────────────────────────

class ApiKeyStore {
  private keys = new Map<string, ApiKeyRecord>();

  constructor() {
    // Bootstrap from env: SUPER_AGENT_API_KEYS=name1:key1:role1,name2:key2:role2
    const raw = process.env.SUPER_AGENT_API_KEYS ?? "";
    for (const entry of raw.split(",").filter(Boolean)) {
      const [name, key, role] = entry.split(":");
      if (name && key) {
        this.keys.set(key, {
          key,
          name,
          role: (role as Role) ?? "operator",
          createdAt: new Date(),
          lastUsedAt: null,
          enabled: true,
        });
      }
    }
  }

  validate(key: string): ApiKeyRecord | null {
    const record = this.keys.get(key);
    if (!record || !record.enabled) return null;
    record.lastUsedAt = new Date();
    return record;
  }

  list(): ApiKeyRecord[] {
    return [...this.keys.values()].map((k) => ({ ...k, key: k.key.slice(0, 8) + "..." }));
  }

  create(name: string, role: Role): ApiKeyRecord {
    const key = `sk-${crypto.randomUUID().replace(/-/g, "")}`;
    const record: ApiKeyRecord = {
      key,
      name,
      role,
      createdAt: new Date(),
      lastUsedAt: null,
      enabled: true,
    };
    this.keys.set(key, record);
    return record;
  }

  revoke(key: string): boolean {
    const record = this.keys.get(key);
    if (!record) return false;
    record.enabled = false;
    return true;
  }

  delete(key: string): boolean {
    return this.keys.delete(key);
  }
}

// ─── Singleton ───────────────────────────────────────────────

let apiKeyStore: ApiKeyStore;

function getApiKeyStore(): ApiKeyStore {
  if (!apiKeyStore) apiKeyStore = new ApiKeyStore();
  return apiKeyStore;
}

// ─── Register Auth Plugin ────────────────────────────────────

export async function registerAuth(app: FastifyInstance): Promise<void> {
  const enabled = process.env.AUTH_ENABLED === "true";
  if (!enabled) {
    app.log.info("Auth disabled (set AUTH_ENABLED=true to enable)");
    return;
  }

  // P0-A1: 生产环境强制配置 JWT_SECRET，拒绝使用硬编码默认值
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret && process.env.NODE_ENV === "production") {
    throw new Error(
      "[SECURITY] JWT_SECRET must be set in production. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
    );
  }
  const secret = jwtSecret ?? "super-agent-dev-secret-change-me";
  if (!jwtSecret) {
    app.log.warn("Using default JWT secret — NOT safe for production. Set JWT_SECRET env var.");
  }

  await app.register(fastifyJwt, {
    secret: secret,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? "24h" },
  });

  // Decorate request with auth user
  app.decorateRequest("authUser", null);

  // Global preHandler hook for authentication
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health check, OpenAI compat, and auth routes
    const skipPaths = [
      "/api/system/health",
      "/api/auth/login",
      "/api/auth/token",
      "/v1/models",
    ];
    if (skipPaths.some((p) => request.url.startsWith(p))) return;

    // Try API Key first
    const apiKey = request.headers["x-api-key"] as string | undefined;
    if (apiKey) {
      const record = getApiKeyStore().validate(apiKey);
      if (!record) {
        return reply.status(401).send({ error: "Invalid API key" });
      }
      (request as any).authUser = {
        id: `apikey:${record.name}`,
        name: record.name,
        role: record.role,
      } satisfies AuthUser;
      return;
    }

    // Try JWT Bearer token
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const decoded = await request.jwtVerify<AuthUser>();
        (request as any).authUser = decoded;
        return;
      } catch {
        return reply.status(401).send({ error: "Invalid or expired token" });
      }
    }

    return reply.status(401).send({ error: "Authentication required (API Key or Bearer token)" });
  });

  app.log.info("Auth enabled: JWT + API Key");
}

// ─── Require Permission Decorator ────────────────────────────

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.AUTH_ENABLED !== "true") return;

    const user = (request as any).authUser as AuthUser | null;
    if (!user) {
      return reply.status(401).send({ error: "Not authenticated" });
    }
    if (!hasPermission(user.role, permission)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: `Role '${user.role}' lacks permission '${permission}'`,
      });
    }
  };
}

// ─── Auth API Routes ─────────────────────────────────────────

export async function authRoutes(app: FastifyInstance): Promise<void> {
  if (process.env.AUTH_ENABLED !== "true") return;

  // POST /api/auth/login — exchange credentials for JWT
  app.post<{
    Body: { username: string; password: string };
  }>("/api/auth/login", async (request, reply) => {
    const { username, password } = request.body ?? {};

    // Simple credential check (replace with DB in production)
    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!adminUser || !adminPass) {
      logger.warn("ADMIN_USERNAME/ADMIN_PASSWORD not set, password login disabled");
      return reply.status(503).send({ error: "Password login not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD environment variables." });
    }

    if (username !== adminUser || password !== adminPass) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }

    const token = app.jwt.sign({
      id: `user:${username}`,
      name: username,
      role: "admin" as Role,
    });

    return { token, expiresIn: process.env.JWT_EXPIRES_IN ?? "24h" };
  });

  // POST /api/auth/token — refresh JWT
  app.post("/api/auth/token/refresh", async (request, reply) => {
    try {
      const user = await request.jwtVerify<AuthUser>();
      const token = app.jwt.sign({
        id: user.id,
        name: user.name,
        role: user.role,
      });
      return { token, expiresIn: process.env.JWT_EXPIRES_IN ?? "24h" };
    } catch {
      return reply.status(401).send({ error: "Invalid token" });
    }
  });

  // GET /api/auth/me — current user info
  app.get("/api/auth/me", async (request) => {
    const user = (request as any).authUser as AuthUser;
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      permissions: [...(PERMISSIONS[user.role] ?? [])],
    };
  });

  // ─── API Key Management (admin only) ─────────────────────

  // GET /api/auth/keys — list API keys
  app.get("/api/auth/keys", {
    preHandler: requirePermission("*"),
  }, async () => {
    return { keys: getApiKeyStore().list() };
  });

  // POST /api/auth/keys — create API key
  app.post<{
    Body: { name: string; role?: Role };
  }>("/api/auth/keys", {
    preHandler: requirePermission("*"),
  }, async (request) => {
    const { name, role } = request.body ?? {};
    if (!name) return { error: "Name required" };
    const record = getApiKeyStore().create(name, role ?? "operator");
    return { key: record.key, name: record.name, role: record.role };
  });

  // DELETE /api/auth/keys/:key — revoke API key
  app.delete<{ Params: { key: string } }>("/api/auth/keys/:key", {
    preHandler: requirePermission("*"),
  }, async (request, reply) => {
    const ok = getApiKeyStore().revoke(request.params.key);
    if (!ok) return reply.status(404).send({ error: "Key not found" });
    return { status: "revoked" };
  });
}
