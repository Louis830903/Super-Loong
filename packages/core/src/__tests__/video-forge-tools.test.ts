/**
 * Video-Forge Tools Tests — 7 个原子工具层测试。
 *
 * mock client 模块，验证工具结构化返回、错误传播、工具数量。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// mock 整个 client 模块
vi.mock("../services/video-forge-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/video-forge-client.js")>();
  return {
    ...original,
    forgeImage: vi.fn(),
    forgeVideoSubmit: vi.fn(),
    forgeVideoStatus: vi.fn(),
    forgeTts: vi.fn(),
    forgeComposeFrame: vi.fn(),
    forgeConcat: vi.fn(),
    forgeAddBgm: vi.fn(),
  };
});

// 空 ToolContext 占位（工具实际不使用 context）
const dummyCtx = {} as any;

describe("video-forge atomic tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("videoForgeTools 导出 7 个工具", async () => {
    const { videoForgeTools } = await import("../tools/video-forge.js");
    expect(videoForgeTools).toHaveLength(7);
    const names = videoForgeTools.map((t) => t.name);
    expect(names).toContain("forge_image");
    expect(names).toContain("forge_video");
    expect(names).toContain("forge_video_status");
    expect(names).toContain("forge_tts");
    expect(names).toContain("forge_compose_frame");
    expect(names).toContain("forge_concat");
    expect(names).toContain("forge_add_bgm");
  });

  it("forge_image — happy path", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeImage).mockResolvedValueOnce({
      url: "https://cdn.test/img.png",
      local_path: "/tmp/img.png",
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_image")!;
    const result = await tool.execute({ prompt: "a beautiful sunset" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("图片生成完成");
    expect((result.data as any)?.local_path).toBe("/tmp/img.png");
  });

  it("forge_image — 错误返回结构化 data", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeImage).mockRejectedValueOnce(
      new client.VideoForgeRequestError("HTTP_503", "Service Unavailable", true, 503),
    );

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_image")!;
    const result = await tool.execute({ prompt: "fail test" }, dummyCtx);

    expect(result.success).toBe(false);
    expect((result.data as any)?.code).toBe("HTTP_503");
    expect((result.data as any)?.retryable).toBe(true);
    expect((result.data as any)?.statusCode).toBe(503);
  });

  it("forge_video — 返回 job_id", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeVideoSubmit).mockResolvedValueOnce({
      job_id: "vj_test123",
      status: "queued",
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_video")!;
    const result = await tool.execute({ prompt: "running cat" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("vj_test123");
    expect((result.data as any)?.job_id).toBe("vj_test123");
  });

  it("forge_video_status — succeeded", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeVideoStatus).mockResolvedValueOnce({
      status: "succeeded",
      progress: 100,
      output: { local_path: "/tmp/video.mp4" },
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_video_status")!;
    const result = await tool.execute({ job_id: "vj_done" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("succeeded");
  });

  it("forge_video_status — failed", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeVideoStatus).mockResolvedValueOnce({
      status: "failed",
      error: "ffmpeg crash",
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_video_status")!;
    const result = await tool.execute({ job_id: "vj_fail" }, dummyCtx);

    expect(result.success).toBe(false);
    expect(result.output).toContain("ffmpeg crash");
  });

  it("forge_tts — 返回 audio_path + duration", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeTts).mockResolvedValueOnce({
      audio_path: "/tmp/tts.mp3",
      duration: 4.2,
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_tts")!;
    const result = await tool.execute({ text: "你好" }, dummyCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("TTS 合成完成");
    expect(result.output).toContain("4.2");
  });

  it("forge_compose_frame — 返回 video_segment_path", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeComposeFrame).mockResolvedValueOnce({
      video_segment_path: "/tmp/seg_01.mp4",
      duration: 5.0,
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_compose_frame")!;
    const result = await tool.execute({
      image_path: "/tmp/frame.png",
      audio_path: "/tmp/tts.mp3",
    }, dummyCtx);

    expect(result.success).toBe(true);
    expect((result.data as any)?.video_segment_path).toBe("/tmp/seg_01.mp4");
  });

  it("forge_concat — 返回 output_path", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeConcat).mockResolvedValueOnce({
      output_path: "/tmp/final.mp4",
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_concat")!;
    const result = await tool.execute({
      segments: ["/tmp/a.mp4", "/tmp/b.mp4"],
    }, dummyCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("2 段");
  });

  it("forge_add_bgm — 返回 output_path", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeAddBgm).mockResolvedValueOnce({
      output_path: "/tmp/bgm_final.mp4",
    });

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_add_bgm")!;
    const result = await tool.execute({
      video_path: "/tmp/video.mp4",
      bgm_path: "/tmp/music.mp3",
      volume: 0.2,
    }, dummyCtx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("背景音乐添加完成");
  });

  it("未知错误返回 UNKNOWN code", async () => {
    const client = await import("../services/video-forge-client.js");
    vi.mocked(client.forgeImage).mockRejectedValueOnce(new Error("unexpected crash"));

    const { videoForgeTools } = await import("../tools/video-forge.js");
    const tool = videoForgeTools.find((t) => t.name === "forge_image")!;
    const result = await tool.execute({ prompt: "crash" }, dummyCtx);

    expect(result.success).toBe(false);
    expect((result.data as any)?.code).toBe("UNKNOWN");
    expect((result.data as any)?.retryable).toBe(false);
  });
});
