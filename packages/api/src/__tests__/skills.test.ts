/**
 * skills.test.ts — 技能路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/skills                    — 技能列表
 *   GET    /api/skills/:id                — 技能详情
 *   PUT    /api/skills/:id                — 启用/禁用
 *   POST   /api/skills/reload             — 强制重载
 *   GET    /api/skills/marketplace/search — 市场搜索
 *   POST   /api/skills/marketplace/install— 市场安装
 *   GET    /api/skills/installed           — 已安装列表
 *   POST   /api/skills/:id/uninstall       — 卸载
 *   GET    /api/skills/marketplace/sources — 市场源列表
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { skillRoutes } from "../routes/skills.js";
import { buildApp, MockSkillLoader, MockSkillMarketplace } from "./test-helpers.js";

describe("技能路由", () => {
  let loader: MockSkillLoader;
  let marketplace: MockSkillMarketplace;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    loader = new MockSkillLoader([
      {
        id: "skill-a",
        frontmatter: { name: "Skill A", description: "描述A", version: "1.0", triggers: ["test"] },
        enabled: true,
        content: "内容A",
      },
      {
        id: "skill-b",
        frontmatter: { name: "Skill B", description: "描述B", version: "2.0", triggers: ["deploy"] },
        enabled: false,
        content: "内容B",
        loadedAt: "2025-01-01",
      },
    ]);
    marketplace = new MockSkillMarketplace();
    ctx = { skillLoader: loader as any, skillMarketplace: marketplace as any } as unknown as Partial<AppContext>;
  });

  // ── GET /api/skills ────────────────────────────────────

  it("GET /skills 返回技能列表", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.skills).toHaveLength(2);
    expect(body.data.skills[0].id).toBe("skill-a");
    expect(body.data.skills[0].name).toBe("Skill A");
  });

  // ── GET /api/skills/:id ────────────────────────────────

  it("GET /skills/:id 存在时返回详情", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/skill-a" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.skill.id).toBe("skill-a");
    expect(body.data.skill.name).toBe("Skill A");
  });

  it("GET /skills/:id 不存在返回 404", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── PUT /api/skills/:id ────────────────────────────────

  it("PUT /skills/:id 启用技能", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    // skill-b 当前 disabled
    const res = await app.inject({
      method: "PUT",
      url: "/api/skills/skill-b",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.skill.enabled).toBe(true);
    // 确认持久化
    expect(loader.getSkill("skill-b")!.enabled).toBe(true);
  });

  it("PUT /skills/:id 禁用技能", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT",
      url: "/api/skills/skill-a",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.skill.enabled).toBe(false);
  });

  it("PUT /skills/:id 不存在返回 404", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "PUT",
      url: "/api/skills/nonexistent",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /api/skills/reload ────────────────────────────

  it("POST /skills/reload 返回 reloaded 数量", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "POST", url: "/api/skills/reload" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.reloaded).toBe(2);
  });

  // ── 无 marketplace 时不注册市场路由 ───────────────────

  it("无 skillMarketplace 时不注册市场搜索路由", async () => {
    const noMpCtx = { skillLoader: loader as any } as unknown as Partial<AppContext>;
    const app = await buildApp(skillRoutes, noMpCtx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/marketplace/search?q=test" });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /api/skills/marketplace/search ──────────────────

  it("GET /marketplace/search 缺 q 参数返回 400", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/marketplace/search" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /marketplace/search 返回搜索结果", async () => {
    marketplace.searchResults = [
      { name: "remote-skill", description: "远程技能", version: "1.0.0" },
    ];
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/marketplace/search?q=remote" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.results).toHaveLength(1);
    expect(body.data.total).toBe(1);
  });

  // ── POST /api/skills/marketplace/install ───────────────

  it("POST /marketplace/install 缺 sourceUrl 返回 400", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /marketplace/install 成功返回 201", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { sourceUrl: "https://example.com/skill.md" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("POST /marketplace/install 失败返回 500", async () => {
    marketplace.installResult = { success: false, error: "网络错误" };
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/skills/marketplace/install",
      payload: { sourceUrl: "https://bad.example.com/" },
    });
    expect(res.statusCode).toBe(500);
  });

  // ── GET /api/skills/installed ──────────────────────────

  it("GET /skills/installed 返回已安装列表", async () => {
    marketplace.installed = [{ id: "remote-1", name: "Remote Skill" }];
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/installed" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.skills).toHaveLength(1);
  });

  // ── POST /api/skills/:id/uninstall ─────────────────────

  it("POST /skills/:id/uninstall 成功", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "POST", url: "/api/skills/remote-1/uninstall" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("uninstalled");
  });

  // ── GET /api/skills/marketplace/sources ────────────────

  it("GET /marketplace/sources 返回源列表", async () => {
    const app = await buildApp(skillRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/skills/marketplace/sources" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.sources).toHaveLength(1);
  });
});
