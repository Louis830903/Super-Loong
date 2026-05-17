/**
 * settings.test.ts — Feature Flag 与迁移路由集成测试
 *
 * 覆盖端点:
 *   GET  /api/settings/flags        — 读取 Feature Flag 状态
 *   PUT  /api/settings/flags        — 批量更新 Feature Flag
 *   GET  /api/migration/preview     — 预览 OpenClaw 迁移
 *   POST /api/migration/execute     — 执行 OpenClaw 迁移
 *
 * Mock 策略:
 *   - vi.mock('@super-agent/core') 拦截 getConfigStore / invalidateToolCache /
 *     getAllBuiltinTools / builtinTools / injectSysopsSecurityRules
 *   - vi.mock('../services/openclaw-migration.js') 拦截 previewMigration / executeMigration
 *   - ctx: agentManager.registerGlobalTool + securityManager + skillLoader.loadAll
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { settingsRoutes } from "../routes/settings.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// ─── 保存/恢复 process.env ──────────────────────────────────

const FLAG_KEYS = [
  "SUPER_AGENT_SYSOPS_ENABLED",
  "SUPER_AGENT_OPS_TOOLS",
  "SUPER_AGENT_DEV_TOOLS",
  "SUPER_AGENT_DESKTOP_TOOLS",
  "SUPER_AGENT_COMPUTER_USE",
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of FLAG_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of FLAG_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// ─── Mock @super-agent/core ──────────────────────────────────

const mockConfigStoreData = new Map<string, string>();

vi.mock("@super-agent/core", () => ({
  getConfigStore: vi.fn(() => ({
    set: vi.fn((_ns: string, key: string, value: string) => {
      mockConfigStoreData.set(key, value);
    }),
    get: vi.fn((_ns: string, key: string) => mockConfigStoreData.get(key) ?? null),
  })),
  invalidateToolCache: vi.fn(),
  getAllBuiltinTools: vi.fn(async () => [
    { name: "bash", description: "execute bash" },
    { name: "file_read", description: "read file" },
  ]),
  builtinTools: [{ name: "bash", description: "execute bash" }],
  injectSysopsSecurityRules: vi.fn(),
}));

// ─── Mock OpenClaw 迁移服务 ──────────────────────────────────

vi.mock("../services/openclaw-migration.js", () => ({
  previewMigration: vi.fn(async () => ({
    sourceDir: "/mock/openclaw",
    totalFiles: 5,
    canMigrate: true,
    files: [
      { name: "agents.json", size: 1024, status: "will_migrate" },
      { name: "skills/example.md", size: 512, status: "will_migrate" },
    ],
  })),
  executeMigration: vi.fn(async (opts: { overwrite?: boolean }) => ({
    success: true,
    totalFiles: 5,
    migrated: 3,
    skipped: 2,
    overwritten: opts.overwrite ? 0 : 2,
  })),
}));

// ─── 测试套件 ────────────────────────────────────────────────

describe("Feature Flag 与迁移路由", () => {
  let envBefore: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    envBefore = saveEnv();
    // 清理所有 flag
    for (const key of FLAG_KEYS) delete process.env[key];
    mockConfigStoreData.clear();
  });

  afterEach(() => {
    restoreEnv(envBefore);
  });

  function buildCtx(): Partial<AppContext> {
    return {
      agentManager: {
        registerGlobalTool: vi.fn(),
      } as any,
      securityManager: {} as any,
      skillLoader: {
        loadAll: vi.fn(),
      } as any,
    };
  }

  // ── GET /api/settings/flags ──────────────────────────────

  it("GET /api/settings/flags 返回所有 Flag 默认关闭", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({ method: "GET", url: "/api/settings/flags" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.flags).toHaveLength(5);
    // 默认全部关闭
    for (const f of body.data.flags) {
      expect(f.enabled).toBe(false);
    }
  });

  it("GET /api/settings/flags 返回已启用的 Flag", async () => {
    process.env.SUPER_AGENT_SYSOPS_ENABLED = "true";
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({ method: "GET", url: "/api/settings/flags" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const master = body.data.flags.find((f: any) => f.key === "SUPER_AGENT_SYSOPS_ENABLED");
    expect(master.enabled).toBe(true);
  });

  // ── PUT /api/settings/flags ──────────────────────────────

  it("PUT /api/settings/flags 开启总开关", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: { SUPER_AGENT_SYSOPS_ENABLED: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.updated.SUPER_AGENT_SYSOPS_ENABLED).toBe(true);
    // process.env 已更新
    expect(process.env.SUPER_AGENT_SYSOPS_ENABLED).toBe("true");
  });

  it("PUT /api/settings/flags 关闭总开关联动关闭所有子开关", async () => {
    // 先开启总开关和子开关
    process.env.SUPER_AGENT_SYSOPS_ENABLED = "true";
    process.env.SUPER_AGENT_OPS_TOOLS = "true";
    process.env.SUPER_AGENT_DEV_TOOLS = "true";
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: { SUPER_AGENT_SYSOPS_ENABLED: false } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 子开关也被联动关闭
    expect(process.env.SUPER_AGENT_SYSOPS_ENABLED).toBe("false");
    expect(process.env.SUPER_AGENT_OPS_TOOLS).toBe("false");
    expect(process.env.SUPER_AGENT_DEV_TOOLS).toBe("false");
  });

  it("PUT /api/settings/flags 子开关开启时自动开启父开关", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: { SUPER_AGENT_OPS_TOOLS: true } },
    });
    expect(res.statusCode).toBe(200);
    // 父开关被联动开启
    expect(process.env.SUPER_AGENT_SYSOPS_ENABLED).toBe("true");
    expect(process.env.SUPER_AGENT_OPS_TOOLS).toBe("true");
  });

  it("PUT /api/settings/flags 缺少 body.flags 返回 400", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /api/settings/flags body.flags 非对象返回 400", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: "invalid-string" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT /api/settings/flags 无效 flag key 被静默忽略", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: { INVALID_FLAG: true } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // updated 中不包含无效 key
    expect(body.data.updated.INVALID_FLAG).toBeUndefined();
  });

  it("PUT /api/settings/flags 多次更新不冲突", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    // 第一次
    await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: { SUPER_AGENT_SYSOPS_ENABLED: true } },
    });
    // 第二次
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/flags",
      payload: { flags: { SUPER_AGENT_DEV_TOOLS: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(process.env.SUPER_AGENT_SYSOPS_ENABLED).toBe("true");
    expect(process.env.SUPER_AGENT_DEV_TOOLS).toBe("true");
  });

  // ── GET /api/migration/preview ───────────────────────────

  it("GET /api/migration/preview 返回迁移预览", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({ method: "GET", url: "/api/migration/preview" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalFiles).toBe(5);
    expect(body.data.canMigrate).toBe(true);
  });

  // ── POST /api/migration/execute ──────────────────────────

  it("POST /api/migration/execute 执行迁移成功", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "POST",
      url: "/api/migration/execute",
      payload: { overwrite: false },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.success).toBe(true);
    expect(body.data.migrated).toBe(3);
    expect(body.data.skipped).toBe(2);
  });

  it("POST /api/migration/execute 覆盖模式", async () => {
    const app = await buildApp(settingsRoutes, buildCtx());
    const res = await app.inject({
      method: "POST",
      url: "/api/migration/execute",
      payload: { overwrite: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.overwritten).toBe(0); // 覆盖模式下 overwritten 为 0（mock）
  });
});
