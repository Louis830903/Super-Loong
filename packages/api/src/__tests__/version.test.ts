/**
 * 版本与更新路由集成测试（version.test.ts）
 *
 * 覆盖：
 *   GET /api/version — 返回版本信息（含更新检查结果）
 *   POST /api/update/install — 一键安装更新（仅测已达最新版路径）
 *
 * Mock 策略：🟢 低依赖。两个路由都不需要 AppContext，
 *   调用 core 的 checkForUpdates()，测试时 mock 其返回值。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { versionRoutes, clearVersionCache } from "../routes/version.js";
import { updateRoutes } from "../routes/update.js";

// Mock @super-agent/core 的 checkForUpdates 和 installUpdate
vi.mock("@super-agent/core", async () => {
  const actual = await vi.importActual("@super-agent/core");
  return {
    ...actual,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    detectRunMode: vi.fn(() => "monorepo"),
  };
});

import { checkForUpdates, installUpdate } from "@super-agent/core";

let app: FastifyInstance;

beforeEach(async () => {
  clearVersionCache(); // 清除模块级 TTL 缓存，避免跨测试污染
  app = Fastify({ logger: false });
  versionRoutes(app);
  updateRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ─── 版本查询 ────────────────────────────────────────

describe("GET /api/version", () => {
  it("成功返回 version 信息", async () => {
    const mockResult = {
      success: true,
      current: "1.0.0",
      latest: "1.1.0",
      outdated: true,
      releaseUrl: "https://github.com/test/releases/v1.1.0",
      downloadUrl: null,
      source: "github" as const,
    };
    vi.mocked(checkForUpdates).mockResolvedValueOnce(mockResult);

    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.success).toBe(true);
    expect(body.data.current).toBe("1.0.0");
    expect(body.data.latest).toBe("1.1.0");
  });

  it("无更新时 outdated 为 false", async () => {
    const mockResult = {
      success: true,
      current: "1.1.0",
      latest: "1.1.0",
      outdated: false,
      releaseUrl: null,
      downloadUrl: null,
      source: "github" as const,
    };
    vi.mocked(checkForUpdates).mockResolvedValueOnce(mockResult);

    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.outdated).toBe(false);
  });

  it("GitHub API 不可达时仍返回成功（含错误信息）", async () => {
    const mockResult = {
      success: false,
      current: "",
      latest: null,
      outdated: false,
      releaseUrl: null,
      downloadUrl: null,
      source: null,
    };
    vi.mocked(checkForUpdates).mockResolvedValueOnce(mockResult);

    const res = await app.inject({ method: "GET", url: "/api/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.success).toBe(false);
  });
});

// ─── 更新安装 ────────────────────────────────────────

describe("POST /api/update/install", () => {
  it("已是最新版时返回 'Already up to date'", async () => {
    const mockResult = {
      success: true,
      current: "1.2.0",
      latest: "1.2.0",
      outdated: false,
      releaseUrl: null,
      downloadUrl: null,
      source: "github" as const,
    };
    vi.mocked(checkForUpdates).mockResolvedValueOnce(mockResult);

    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.message).toContain("Already up to date");
  });

  it("无法检查更新时返回 400", async () => {
    const mockResult = {
      success: false,
      current: "",
      latest: null,
      outdated: false,
      releaseUrl: null,
      downloadUrl: null,
      source: null,
    };
    vi.mocked(checkForUpdates).mockResolvedValueOnce(mockResult);

    const res = await app.inject({ method: "POST", url: "/api/update/install" });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });
});
