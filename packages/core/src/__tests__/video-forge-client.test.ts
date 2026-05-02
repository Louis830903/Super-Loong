/**
 * Video-Forge Client Tests — mock fetch 层验证 HTTP 调用、重试、超时、错误结构。
 *
 * T1.10 Spec: mock HTTP 层覆盖入参/重试/熔断
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 辅助：构造正常 Response
function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// 辅助：构造错误 Response
function errResponse(status: number, body?: unknown) {
  return new Response(
    body ? JSON.stringify(body) : "",
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("video-forge-client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── forgeImage ──
  it("forgeImage happy path — POST /forge/image", async () => {
    const { forgeImage } = await import("../services/video-forge-client.js");
    const mockResult = { url: "https://cdn.test/img.png", local_path: "/tmp/img.png" };
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(okResponse(mockResult));

    const result = await forgeImage({ prompt: "a cat" });
    expect(result.url).toBe("https://cdn.test/img.png");
    expect(result.local_path).toBe("/tmp/img.png");

    const [url, opts] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toContain("/forge/image");
    expect(opts?.method).toBe("POST");
    expect(opts?.redirect).toBe("error"); // SSRF 防护
  });

  // ── forgeTts ──
  it("forgeTts happy path", async () => {
    const { forgeTts } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      okResponse({ audio_path: "/tmp/tts.mp3", duration: 3.5 }),
    );

    const result = await forgeTts({ text: "你好世界" });
    expect(result.audio_path).toBe("/tmp/tts.mp3");
    expect(result.duration).toBe(3.5);
  });

  // ── forgeVideoSubmit ──
  it("forgeVideoSubmit returns job_id", async () => {
    const { forgeVideoSubmit } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      okResponse({ job_id: "vj_abc123", status: "queued" }),
    );

    const result = await forgeVideoSubmit({ prompt: "running dog" });
    expect(result.job_id).toBe("vj_abc123");
    expect(result.status).toBe("queued");
  });

  // ── forgeVideoStatus ──
  it("forgeVideoStatus returns job state", async () => {
    const { forgeVideoStatus } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      okResponse({ status: "running", progress: 50 }),
    );

    const result = await forgeVideoStatus("vj_abc123");
    expect(result.status).toBe("running");
    expect(result.progress).toBe(50);
  });

  // ── forgeConcat ──
  it("forgeConcat happy path", async () => {
    const { forgeConcat } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      okResponse({ output_path: "/tmp/concat.mp4" }),
    );

    const result = await forgeConcat({ segments: ["/a.mp4", "/b.mp4"] });
    expect(result.output_path).toBe("/tmp/concat.mp4");
  });

  // ── forgeAddBgm ──
  it("forgeAddBgm happy path", async () => {
    const { forgeAddBgm } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      okResponse({ output_path: "/tmp/bgm_out.mp4" }),
    );

    const result = await forgeAddBgm({
      video_path: "/tmp/main.mp4",
      bgm_path: "/tmp/music.mp3",
      volume: 0.3,
    });
    expect(result.output_path).toBe("/tmp/bgm_out.mp4");
  });

  // ── 4xx 不重试 ──
  it("4xx error throws VideoForgeRequestError (non-retryable)", async () => {
    const { forgeImage, VideoForgeRequestError } = await import(
      "../services/video-forge-client.js"
    );
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      errResponse(422, { detail: "Validation Error", code: "VALIDATION" }),
    );

    try {
      await forgeImage({ prompt: "test" });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VideoForgeRequestError);
      const err = e as InstanceType<typeof VideoForgeRequestError>;
      expect(err.code).toBe("VALIDATION");
      expect(err.retryable).toBe(false);
      expect(err.statusCode).toBe(422);
    }

    // 422 不重试：只调了 1 次
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  // ── 5xx 重试后仍失败 ──
  it("5xx error retries then throws VideoForgeRequestError", async () => {
    const { forgeImage, VideoForgeRequestError } = await import(
      "../services/video-forge-client.js"
    );
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(errResponse(503, { detail: "Service Unavailable" }))
      .mockResolvedValueOnce(errResponse(503, { detail: "Service Unavailable" }));

    await expect(forgeImage({ prompt: "retry test" })).rejects.toThrow(VideoForgeRequestError);

    // fetch 被调了 2 次（初次 + 1 次重试）
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  // ── 5xx 重试后成功 ──
  it("5xx retry then success", async () => {
    const { forgeImage } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(errResponse(502))
      .mockResolvedValueOnce(okResponse({ url: "https://cdn.test/retry.png" }));

    const result = await forgeImage({ prompt: "retry success" });
    expect(result.url).toBe("https://cdn.test/retry.png");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  // ── 网络错误重试 ──
  it("network error retries then throws NETWORK_ERROR", async () => {
    const { forgeImage, VideoForgeRequestError } = await import(
      "../services/video-forge-client.js"
    );
    vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    try {
      await forgeImage({ prompt: "network fail" });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(VideoForgeRequestError);
      const err = e as InstanceType<typeof VideoForgeRequestError>;
      expect(err.code).toBe("NETWORK_ERROR");
      expect(err.retryable).toBe(true);
    }
  });

  // ── forgeHealthCheck 短超时 ──
  it("forgeHealthCheck uses short timeout", async () => {
    const { forgeHealthCheck } = await import("../services/video-forge-client.js");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      okResponse({ status: "ok", comfykit_ready: true }),
    );

    const result = await forgeHealthCheck();
    expect(result.status).toBe("ok");
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]?.signal).toBeDefined();
  });
});

// ━━ estimateCost 测试 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("estimateCost", () => {
  it("已知工作流使用配置单价", async () => {
    const { estimateCost } = await import("../services/video-forge-client.js");
    const result = estimateCost("runninghub/video_wan2.1_fusionx.json", 6);
    expect(result.estimate_cny).toBe(9.0);
    expect(result.unit_price).toBe(1.5);
    expect(result.scenes).toBe(6);
  });

  it("未知工作流退化为 _default 单价", async () => {
    const { estimateCost } = await import("../services/video-forge-client.js");
    const result = estimateCost("some/unknown.json", 3);
    expect(result.estimate_cny).toBe(3.0);
    expect(result.unit_price).toBe(1.0);
  });

  it("自定义 pricing 覆盖默认", async () => {
    const { estimateCost } = await import("../services/video-forge-client.js");
    const custom = { "my/workflow.json": 5.0, "_default": 2.0 };
    const result = estimateCost("my/workflow.json", 4, custom);
    expect(result.estimate_cny).toBe(20.0);
  });

  it("默认场景数为 6", async () => {
    const { estimateCost } = await import("../services/video-forge-client.js");
    const result = estimateCost("runninghub/image_flux.json");
    expect(result.scenes).toBe(6);
    expect(result.estimate_cny).toBeCloseTo(1.8, 5); // 6 × 0.3 浮点精度
  });
});
