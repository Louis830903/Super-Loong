/**
 * P0-D — video-crew-handlers 单元测试
 *
 * 覆盖 4 个 Code Node handler 的核心路径：
 *   1. voiceSynthesisHandler：成功 / 部分失败 / 上游缺失
 *   2. visualProductionHandler：成功 / 部分失败
 *   3. frameCompositionHandler：正常对齐 / 部分缺素材 / 全部缺素材抛错
 *   4. finalMergeHandler：正常 / segments < 2 抛错
 *
 * 通过 vi.mock 模块级替换 video-forge-client，完全离线可跑。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodeTaskContext } from "../collaboration/orchestrator.js";
import { VIDEO_TASK_IDS } from "../collaboration/video-crew-presets.js";

// ── 先 mock forge 客户端再 import handlers，确保 handlers 拿到 mock 版 ──
vi.mock("../services/video-forge-client.js", () => {
  class VideoForgeRequestError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    forgeTts: vi.fn(),
    forgeImage: vi.fn(),
    forgeComposeFrame: vi.fn(),
    forgeConcat: vi.fn(),
    VideoForgeRequestError,
  };
});

import {
  voiceSynthesisHandler,
  visualProductionHandler,
  frameCompositionHandler,
  finalMergeHandler,
} from "../collaboration/video-crew-handlers.js";
import {
  forgeTts,
  forgeImage,
  forgeComposeFrame,
  forgeConcat,
} from "../services/video-forge-client.js";

// ─── 测试夹具 ──────────────────────────────────────────────

function makeCtx(outputs: Record<string, string>): CodeTaskContext {
  return {
    taskId: "t-test",
    crewId: "crew-test",
    outputMap: new Map(Object.entries(outputs)),
    workspaceDir: undefined,
    inputs: undefined,
    signal: undefined,
  };
}

/** 构造一份合法的 ScriptSchema JSON（6 段，每段 narration 长度合规） */
function makeScriptJson(): string {
  return JSON.stringify({
    title: "测试视频",
    narration_full: "这是一段用于测试的完整旁白内容，长度足够满足 min20 字符校验要求。",
    scenes: Array.from({ length: 6 }, (_, i) => ({
      index: i,
      narration_text: `第 ${i} 段旁白文字`,
      duration_s: 5,
    })),
  });
}

/** 构造一份合法的 StoryboardSchema JSON */
function makeStoryboardJson(): string {
  return JSON.stringify({
    title: "测试视频",
    style_tag: "realistic",
    frames: Array.from({ length: 6 }, (_, i) => ({
      index: i,
      narration_text: `第 ${i} 段旁白文字`,
      image_prompt: `a photorealistic scene of frame ${i}`,
      duration_s: 5,
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── voiceSynthesisHandler ─────────────────────────────────

describe("voiceSynthesisHandler", () => {
  it("全部成功：6 段都调 forge_tts 并返回 audio_segments", async () => {
    (forgeTts as any).mockImplementation(async ({ text }: { text: string }) => ({
      audio_path: `/tmp/audio_${text.slice(-1)}.mp3`,
      duration: 4.5,
    }));

    const ctx = makeCtx({ [VIDEO_TASK_IDS.SCRIPT_GENERATION]: makeScriptJson() });
    const result = await voiceSynthesisHandler(ctx);

    expect(forgeTts).toHaveBeenCalledTimes(6);
    const parsed = JSON.parse(result.output);
    expect(parsed.audio_segments).toHaveLength(6);
    expect(parsed.errors).toBeUndefined();
    expect(parsed.audio_segments.every((s: any) => s.audio_path?.startsWith("/tmp/"))).toBe(true);
    expect(result.attachments).toHaveLength(6);
  });

  it("部分失败：第 2 段抛错时 audio_path=null 且 errors 含该 index", async () => {
    let call = 0;
    (forgeTts as any).mockImplementation(async () => {
      call++;
      if (call === 3) throw new Error("tts timeout");
      return { local_path: `/tmp/audio_${call}.mp3` };
    });

    const ctx = makeCtx({ [VIDEO_TASK_IDS.SCRIPT_GENERATION]: makeScriptJson() });
    const result = await voiceSynthesisHandler(ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.audio_segments).toHaveLength(6);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].index).toBe(2);
    expect(parsed.audio_segments[2].audio_path).toBeNull();
  });

  it("上游缺失：抛错让 orchestrator 走重试", async () => {
    const ctx = makeCtx({});
    await expect(voiceSynthesisHandler(ctx)).rejects.toThrow(/缺少上游/);
    expect(forgeTts).not.toHaveBeenCalled();
  });
});

// ─── visualProductionHandler ───────────────────────────────

describe("visualProductionHandler", () => {
  it("全部成功：6 帧都调 forge_image，video_path 固定为 null", async () => {
    (forgeImage as any).mockImplementation(async (_p: any) => ({
      local_path: "/tmp/img.png",
      url: "http://x/img.png",
    }));

    const ctx = makeCtx({ [VIDEO_TASK_IDS.STORYBOARD_INIT]: makeStoryboardJson() });
    const result = await visualProductionHandler(ctx);

    expect(forgeImage).toHaveBeenCalledTimes(6);
    const parsed = JSON.parse(result.output);
    expect(parsed.frames).toHaveLength(6);
    expect(parsed.frames.every((f: any) => f.video_path === null)).toBe(true);
    expect(parsed.errors).toBeUndefined();
  });

  it("部分失败：失败帧 image_path=null 但不中断", async () => {
    let call = 0;
    (forgeImage as any).mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error("runninghub 503");
      return { local_path: `/tmp/img_${call}.png` };
    });

    const ctx = makeCtx({ [VIDEO_TASK_IDS.STORYBOARD_INIT]: makeStoryboardJson() });
    const result = await visualProductionHandler(ctx);

    const parsed = JSON.parse(result.output);
    expect(parsed.frames).toHaveLength(6);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].index).toBe(1);
    expect(parsed.frames[1].image_path).toBeNull();
  });
});

// ─── frameCompositionHandler ───────────────────────────────

describe("frameCompositionHandler", () => {
  function audioJson(paths: Array<string | null>): string {
    return JSON.stringify({
      audio_segments: paths.map((p, i) => ({ index: i, audio_path: p })),
    });
  }
  function videoJson(paths: Array<string | null>): string {
    return JSON.stringify({
      frames: paths.map((p, i) => ({ index: i, image_path: p })),
    });
  }

  it("正常对齐：6 帧都有音频+图像，全部 compose 成功", async () => {
    (forgeComposeFrame as any).mockImplementation(async ({ image_path }: any) => ({
      video_segment_path: `/tmp/seg_${image_path.split("_")[1]}`,
    }));

    const ctx = makeCtx({
      [VIDEO_TASK_IDS.AUDIO_SYNTHESIS]: audioJson(["/tmp/a0", "/tmp/a1", "/tmp/a2", "/tmp/a3", "/tmp/a4", "/tmp/a5"]),
      [VIDEO_TASK_IDS.VISUAL_PRODUCTION]: videoJson(["/tmp/i_0", "/tmp/i_1", "/tmp/i_2", "/tmp/i_3", "/tmp/i_4", "/tmp/i_5"]),
    });
    const result = await frameCompositionHandler(ctx);

    expect(forgeComposeFrame).toHaveBeenCalledTimes(6);
    const parsed = JSON.parse(result.output);
    expect(parsed.segments).toHaveLength(6);
    expect(parsed.errors).toBeUndefined();
  });

  it("部分缺素材：缺 audio/image 的 index 进 errors，其余正常合成", async () => {
    (forgeComposeFrame as any).mockImplementation(async () => ({
      video_segment_path: "/tmp/seg.mp4",
    }));

    const ctx = makeCtx({
      [VIDEO_TASK_IDS.AUDIO_SYNTHESIS]: audioJson(["/tmp/a0", null, "/tmp/a2", "/tmp/a3", "/tmp/a4", "/tmp/a5"]),
      [VIDEO_TASK_IDS.VISUAL_PRODUCTION]: videoJson(["/tmp/i0", "/tmp/i1", null, "/tmp/i3", "/tmp/i4", "/tmp/i5"]),
    });
    const result = await frameCompositionHandler(ctx);

    const parsed = JSON.parse(result.output);
    // index 1 缺 audio, index 2 缺 image，其余 4 帧成功
    expect(parsed.segments).toHaveLength(4);
    expect(parsed.errors).toHaveLength(2);
    const errIdx = parsed.errors.map((e: any) => e.index).sort();
    expect(errIdx).toEqual([1, 2]);
  });

  it("全部失败：无一成功 → 抛错让 orchestrator 重试", async () => {
    const ctx = makeCtx({
      [VIDEO_TASK_IDS.AUDIO_SYNTHESIS]: audioJson([null, null, null, null, null, null]),
      [VIDEO_TASK_IDS.VISUAL_PRODUCTION]: videoJson([null, null, null, null, null, null]),
    });
    await expect(frameCompositionHandler(ctx)).rejects.toThrow(/T6 帧合成全部失败/);
  });
});

// ─── finalMergeHandler ─────────────────────────────────────

describe("finalMergeHandler", () => {
  it("正常拼接：调 forge_concat 并返回 final_video_path", async () => {
    (forgeConcat as any).mockResolvedValue({ output_path: "/tmp/final.mp4" });

    const ctx = makeCtx({
      [VIDEO_TASK_IDS.FRAME_COMPOSITION]: JSON.stringify({
        segments: [
          { index: 2, path: "/tmp/s2" },
          { index: 0, path: "/tmp/s0" },
          { index: 1, path: "/tmp/s1" },
        ],
      }),
    });
    const result = await finalMergeHandler(ctx);

    expect(forgeConcat).toHaveBeenCalledTimes(1);
    // 必须按 index 升序
    const call = (forgeConcat as any).mock.calls[0][0];
    expect(call.segments).toEqual(["/tmp/s0", "/tmp/s1", "/tmp/s2"]);
    const parsed = JSON.parse(result.output);
    expect(parsed.final_video_path).toBe("/tmp/final.mp4");
    expect(parsed.segment_count).toBe(3);
    expect(result.attachments).toHaveLength(1);
  });

  it("segments < 2：直接抛错不调 forge_concat", async () => {
    const ctx = makeCtx({
      [VIDEO_TASK_IDS.FRAME_COMPOSITION]: JSON.stringify({
        segments: [{ index: 0, path: "/tmp/s0" }],
      }),
    });
    await expect(finalMergeHandler(ctx)).rejects.toThrow(/至少 2 段/);
    expect(forgeConcat).not.toHaveBeenCalled();
  });
});
