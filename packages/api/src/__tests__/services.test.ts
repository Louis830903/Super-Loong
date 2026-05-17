/**
 * services.test.ts — 服务配置路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/services                 — 列出所有服务 + 配置状态
 *   GET    /api/services/:id             — 查看单个服务配置
 *   PUT    /api/services/:id             — 更新服务配置
 *   DELETE /api/services/:id             — 清除服务配置
 *   POST   /api/services/browser/detect  — 触发本地浏览器探测
 *
 * Mock 策略:
 *   - vi.mock('@super-agent/core') 拦截 SERVICE_CATALOG / syncEnvVarToFile
 *   - ctx: MockConfigStore（listServices / set / delete）
 *   - browser/detect 读取 node:fs，mock existsSync 控制探测结果
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { serviceRoutes } from "../routes/services.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// ─── Mock @super-agent/core ──────────────────────────────────

const { mockServiceCatalog } = vi.hoisted(() => ({
  mockServiceCatalog: [
    {
      id: "aliyun_voice",
      name: "阿里云语音",
      description: "TTS 语音合成 + STT 语音识别",
      website: "https://nls-portal.console.aliyun.com/",
      keys: [
        { key: "access_key_id", label: "AccessKey ID", envKey: "ALIBABA_CLOUD_ACCESS_KEY_ID", secret: true },
        { key: "access_key_secret", label: "AccessKey Secret", envKey: "ALIBABA_CLOUD_ACCESS_KEY_SECRET", secret: true },
        { key: "appkey", label: "AppKey", envKey: "ALIBABA_CLOUD_APPKEY", secret: false },
      ],
    },
    {
      id: "browser",
      name: "浏览器自动化",
      description: "浏览器控制与截图",
      keys: [
        { key: "browser_path", label: "浏览器路径", envKey: "BROWSER_PATH", secret: false },
        { key: "ws_endpoint", label: "WebSocket 地址", envKey: "BROWSER_WS_ENDPOINT", secret: false },
      ],
    },
  ],
}));

vi.mock("@super-agent/core", () => ({
  SERVICE_CATALOG: mockServiceCatalog,
  syncEnvVarToFile: vi.fn(),
}));

// ─── Mock ConfigStore ────────────────────────────────────────

class MockConfigStore {
  private store = new Map<string, Map<string, string>>();

  constructor() {
    // 初始化每个服务一个子 map
    for (const svc of mockServiceCatalog as any[]) {
      this.store.set(svc.id, new Map());
    }
  }

  listServices() {
    const result: Array<{
      id: string;
      name: string;
      description?: string;
      website?: string;
      configured: boolean;
      config: Record<string, string>;
    }> = [];
    for (const svc of mockServiceCatalog) {
      const config = this.store.get(svc.id)!;
      const configObj: Record<string, string> = {};
      let configured = false;
      for (const [k, v] of config) {
        configObj[k] = v;
        if (v) configured = true;
      }
      result.push({
        id: svc.id,
        name: svc.name,
        description: svc.description,
        website: svc.website,
        configured,
        config: configObj,
      });
    }
    return result;
  }

  set(serviceId: string, key: string, value: string) {
    const svc = this.store.get(serviceId);
    if (!svc) throw new Error(`Unknown service: ${serviceId}`);
    svc.set(key, value);
  }

  delete(serviceId: string) {
    const svc = this.store.get(serviceId);
    if (svc) svc.clear();
  }

  /** 测试辅助：预置配置 */
  _seed(serviceId: string, key: string, value: string) {
    this.set(serviceId, key, value);
  }
}

// ─── Mock node:fs existsSync ─────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

// ─── 测试套件 ────────────────────────────────────────────────

describe("服务配置路由", () => {
  let configStore: MockConfigStore;
  let ctx: AppContext;

  beforeEach(() => {
    vi.clearAllMocks();
    configStore = new MockConfigStore();
    ctx = {
      configStore: configStore as any,
    } as unknown as AppContext;
  });

  // ── GET /api/services ────────────────────────────────────

  it("GET /api/services 返回服务列表", async () => {
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/services" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.services).toHaveLength(2);
    expect(body.data.services[0].id).toBe("aliyun_voice");
    expect(body.data.services[0].configured).toBe(false);
  });

  it("GET /api/services 已配置服务显示 configured=true", async () => {
    configStore._seed("aliyun_voice", "access_key_id", "ak-test");
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/services" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const svc = body.data.services.find((s: any) => s.id === "aliyun_voice");
    expect(svc.configured).toBe(true);
    expect(svc.config.access_key_id).toBe("ak-test");
  });

  // ── GET /api/services/:id ────────────────────────────────

  it("GET /api/services/:id 返回单个服务详情", async () => {
    configStore._seed("aliyun_voice", "appkey", "my-app-key");
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/services/aliyun_voice" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.service).toBeTruthy();
    expect(body.data.service.id).toBe("aliyun_voice");
  });

  it("GET /api/services/:id 未知服务返回 404", async () => {
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/services/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── PUT /api/services/:id ────────────────────────────────

  it("PUT /api/services/:id 更新服务配置成功", async () => {
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({
      method: "PUT",
      url: "/api/services/aliyun_voice",
      payload: { access_key_id: "new-ak-id", access_key_secret: "new-ak-secret" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.service.configured).toBe(true);
  });

  it("PUT /api/services/:id 未知服务返回 404", async () => {
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({
      method: "PUT",
      url: "/api/services/nonexistent",
      payload: { some_key: "value" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE /api/services/:id ─────────────────────────────

  it("DELETE /api/services/:id 清除服务配置成功", async () => {
    configStore._seed("aliyun_voice", "access_key_id", "ak-test");
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({ method: "DELETE", url: "/api/services/aliyun_voice" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.success).toBe(true);
    // 验证已清除
    const svc = configStore.listServices().find((s) => s.id === "aliyun_voice");
    expect(svc!.configured).toBe(false);
  });

  it("DELETE /api/services/:id 未知服务返回 404", async () => {
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({ method: "DELETE", url: "/api/services/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /api/services/browser/detect ────────────────────

  it("POST /api/services/browser/detect 探测到浏览器时返回 found", async () => {
    const { existsSync } = await import("node:fs");
    (existsSync as any).mockImplementation((path: string) => path.includes("msedge.exe"));
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/services/browser/detect",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.detected).toHaveLength(1);
    expect(body.data.detected[0].name).toBe("Edge");
    expect(body.data.recommended).toBeTruthy();
  });

  it("POST /api/services/browser/detect 无浏览器时返回空", async () => {
    const { existsSync } = await import("node:fs");
    (existsSync as any).mockReturnValue(false);
    const app = await buildApp(serviceRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/services/browser/detect",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.detected).toHaveLength(0);
    expect(body.data.recommended).toBeNull();
  });
});
