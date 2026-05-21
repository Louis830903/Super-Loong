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
import { randomUUID } from "node:crypto";
import pino from "pino";
import type { AppContext } from "../context.js";
import { safeEqualSecret } from "./secret-equal.js";
import { sendError } from "../routes/response-helper.js";

const logger = pino({ name: "auth" });

// ─── Types ───────────────────────────────────────────────────

/** @why RBAC 四级角色枚举，权限矩阵和 JWT payload 均依赖此类型 */
export type Role = "admin" | "operator" | "viewer" | "agent";

/** @why JWT 解码后的用户对象结构，贯穿 request.authUser 全链路 */
export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  apiKey?: string;
  iat?: number;
  exp?: number;
}

/** @why API Key 记录结构，支持 X-API-Key 头认证和密钥生命周期管理 */
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

/** @why 权限判定核心函数，requirePermission 守卫和前端权限展示均复用 */
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
    const key = `sk-${randomUUID().replace(/-/g, "")}`;
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

/** @why Fastify 认证插件注册入口，控制 JWT/API-Key 双通道鉴权的启停 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  const enabled = process.env.AUTH_ENABLED === "true";

  // v3 Task 12：生产环境未启用鉴权时给出醒目警告（非阻断）
  // @why 允许用户首次部署后在 UI 中完成所有配置（包括鉴权），
  //       不应在启动阶段 crash 阻止用户进入界面。
  if (!enabled && process.env.NODE_ENV === "production") {
    app.log.warn(
      "[SECURITY] AUTH_ENABLED 未开启，所有 API 以匿名身份访问。\n" +
      "  建议在系统设置中启用鉴权并配置 JWT_SECRET / ADMIN_PASSWORD。"
    );
  }

  if (!enabled) {
    // v3 Task 12：非生产也应明示提醒，运维能在日志里 grep 到匿名状态
    app.log.warn(
      "[AUTH] 鉴权已禁用（AUTH_ENABLED 非 true）——所有 API 以匿名身份访问。\n" +
      "  生产环境必须 AUTH_ENABLED=true；开发可保持默认。"
    );
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

  // 已知的弱密码/占位符集合（参考 OpenClaw startup-auth.ts）
  const KNOWN_WEAK_SECRETS = new Set([
    "super-agent-dev-secret-change-me",
    "change-me",
    "changeme",
    "dev-token",
    "test-token",
    "your-api-key-here",
    "sk-xxx",
  ]);

  // 启动时检测 JWT_SECRET 是否为已知弱密码
  if (jwtSecret && KNOWN_WEAK_SECRETS.has(jwtSecret)) {
    throw new Error(
      "[SECURITY] JWT_SECRET 使用了已知的弱密码/占位符。" +
      "请生成强密钥: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\""
    );
  }

  // 检测 ADMIN_PASSWORD 是否为已知弱密码
  if (process.env.ADMIN_PASSWORD && KNOWN_WEAK_SECRETS.has(process.env.ADMIN_PASSWORD)) {
    throw new Error(
      "[SECURITY] ADMIN_PASSWORD 使用了已知的弱密码/占位符，请设置强密码。"
    );
  }

  const secret = jwtSecret ?? "super-agent-dev-secret-change-me";
  if (!jwtSecret) {
    app.log.warn("Using default JWT secret — NOT safe for production. Set JWT_SECRET env var.");
  }

  // 安全提示：未配置 WebSocket 网关认证密钥
  if (!process.env.API_KEY && !process.env.AUTH_SECRET) {
    app.log.warn(
      "[AUTH] API_KEY / AUTH_SECRET 未配置，WebSocket 网关端点无鉴权保护。\n" +
      "  生产环境请配置 API_KEY 并同步到 IM 网关的 SUPER_AGENT_API_KEY。\n" +
      "  生成方法: node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\""
    );
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
        return sendError(reply, 401, "INVALID_API_KEY", "API Key 无效或已禁用");
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
        return sendError(reply, 401, "INVALID_TOKEN", "Token 无效或已过期");
      }
    }

    return sendError(reply, 401, "UNAUTHORIZED", "请提供 API Key 或 Bearer Token 进行身份认证");
  });

  app.log.info("Auth enabled: JWT + API Key");
}

// ─── Require Permission Decorator ────────────────────────────

/** @why 路由级权限守卫工厂，按 RBAC 矩阵拦截无权限请求 */
export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.AUTH_ENABLED !== "true") return;

    const user = (request as any).authUser as AuthUser | null;
    if (!user) {
      return sendError(reply, 401, "UNAUTHORIZED", "未登录");
    }
    if (!hasPermission(user.role, permission)) {
      return sendError(reply, 403, "FORBIDDEN", `角色 '${user.role}' 无权限执行 '${permission}'`);
    }
  };
}

// ─── Auth API Routes ─────────────────────────────────────────

/** @why 认证相关 REST 路由（登录/刷新/密钥管理），仅 AUTH_ENABLED=true 时注册 */
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
      return sendError(
        reply, 503, "SERVICE_UNAVAILABLE",
        "密码登录未配置，请设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 环境变量",
      );
    }

    if (username !== adminUser || !safeEqualSecret(password, adminPass)) {
      return sendError(reply, 401, "UNAUTHORIZED", "用户名或密码错误");
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
      return sendError(reply, 401, "INVALID_TOKEN", "Token 无效，请重新登录");
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
