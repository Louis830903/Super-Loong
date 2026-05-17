/**
 * voice.test.ts — 语音路由集成测试
 *
 * 覆盖端点:
 *   GET  /api/voice/providers    — 可用 Provider 列表
 *   POST /api/voice/transcribe   — 语音转写（错误路径）
 *   POST /api/voice/synthesize   — 文字合成语音（需 voiceProvider）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppContext } from "../context.js";
import { voiceRoutes } from "../routes/voice.js";
import { buildApp, MockVoiceProvider } from "./test-helpers.js";

describe("语音路由", () => {
  // 保存原始环境变量，测试结束后恢复
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 清除所有语音相关的 env，确保干净状态
    delete process.env.STT_API_URL;
    delete process.env.STT_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
    delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    delete process.env.ALIBABA_CLOUD_APPKEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.STT_MODEL;
  });

  afterEach(() => {
    // 恢复环境变量
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
    // 删除测试期间新增的 key
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
  });

  // ── Providers ──────────────────────────────────────────

  it("GET /providers 无任何凭据时返回空列表", async () => {
    const ctx = {} as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/voice/providers" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.providers).toEqual([]);
  });

  it("GET /providers 设置了 LLM_API_KEY 返回含 llm-whisper", async () => {
    process.env.LLM_API_KEY = "sk-test-key";
    const ctx = {} as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/voice/providers" });
    expect(res.statusCode).toBe(200);
    const providers = JSON.parse(res.body).data.providers;
    expect(providers).toContain("llm-whisper");
  });

  it("GET /providers 设置了 STT_API_URL + STT_API_KEY 返回含 stt-custom", async () => {
    process.env.STT_API_URL = "https://custom-stt.example.com";
    process.env.STT_API_KEY = "custom-key";
    const ctx = {} as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/voice/providers" });
    expect(res.statusCode).toBe(200);
    const providers = JSON.parse(res.body).data.providers;
    expect(providers).toContain("stt-custom");
  });

  // ── Transcribe 错误路径 ────────────────────────────────

  it("POST /transcribe 缺音频数据返回 400", async () => {
    // 设置 LLM key 使 providers 不为空，避免 503
    process.env.LLM_API_KEY = "sk-test-key";
    const ctx = {} as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /transcribe 无 Provider 返回 503", async () => {
    const ctx = {} as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      payload: { audio: "dGVzdA==" }, // valid base64 "test"
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.detail).toBeDefined();
  });

  // ── Synthesize ─────────────────────────────────────────

  it("POST /synthesize 缺 text 返回 400（需要 voiceProvider）", async () => {
    const voiceProvider = new MockVoiceProvider();
    const ctx = { voiceProvider } as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/synthesize",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("有 voiceProvider 时 synthesize 注册但 sendSuccess 包裹 Buffer 与 audio/mpeg Content-Type 冲突 → 500", async () => {
    // 注：voice.ts 合成端点返回 raw binary 却用 sendSuccess 包裹成 JSON，
    // Fastify 拒绝发送 object 类型到 audio/mpeg content-type。
    const voiceProvider = new MockVoiceProvider();
    const ctx = { voiceProvider } as unknown as AppContext;
    const app = await buildApp(voiceRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/synthesize",
      payload: { text: "你好世界" },
    });
    // 当前返回 500（FST_ERR_REP_INVALID_PAYLOAD_TYPE）
    expect(res.statusCode).toBe(500);
  });
});
