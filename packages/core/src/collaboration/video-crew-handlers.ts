/**
 * video-crew-handlers.ts — ShortVideoCrew Code Node 执行器（P0-D 重构）
 *
 * 将 T4/T5/T6/T7 这类"纯机械循环 + 调工具"的任务从 LLM Agent 下放到确定性代码，
 * 彻底消除 LLM 的三类不确定性：
 *   1. 路径幻觉（编造 hex 假路径）
 *   2. 调用遗漏（不调工具直接拼返回）
 *   3. JSON 解析失败（输出散句无结构）
 *
 * 设计约束：
 *   - 每个 handler 独立纯函数，入参只能通过 CodeTaskContext 获取
 *   - 上游输入解析失败 → 抛错让 orchestrator 按 maxRetries 重试
 *   - 单点工具调用失败 → 记录 errors 但不中断整个 handler（T4/T5），
 *     由下游 guardrail 决定是否放行
 *   - T6/T7 任一单点失败即视为致命错误，直接抛错
 */

import pino from "pino";
import type { CodeTaskContext, CodeTaskResult } from "./orchestrator.js";
import type { Attachment } from "../types/index.js";
import { stripMarkdownFence, ScriptSchema, StoryboardSchema } from "./video-crew-schemas.js";
import { VIDEO_TASK_IDS } from "./video-crew-presets.js";
import {
  forgeTts,
  forgeImage,
  forgeComposeFrame,
  forgeConcat,
  VideoForgeRequestError,
} from "../services/video-forge-client.js";

const logger = pino({ name: "video-crew-handlers" });

// ─── 内部工具 ──────────────────────────────────────────────

/** 从上游 task 输出中提取 JSON（剥 fence）并解析，失败抛错 */
function parseUpstream(raw: string | undefined, taskLabel: string): unknown {
  if (!raw || !raw.trim()) {
    throw new Error(`code handler 缺少上游 ${taskLabel} 输出`);
  }
  try {
    return JSON.parse(stripMarkdownFence(raw));
  } catch (e) {
    throw new Error(
      `code handler 解析上游 ${taskLabel} JSON 失败: ${(e as Error).message}; 原文前 200 字符: ${raw.slice(0, 200)}`,
    );
  }
}

/** 把 forge 抛出的错误压扁为可序列化的简短字符串 */
function flattenForgeError(err: unknown): string {
  if (err instanceof VideoForgeRequestError) {
    return `[${err.code}] ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ─── Handler 1：T4 - 音频合成（顺序调 forge_tts）─────────────

/**
 * 读 T1 脚本的 scenes 数组，顺序为每段 narration_text 调用 forge_tts。
 * 单段失败：audio_path=null 并记入 errors，整体仍可前进。
 */
export async function voiceSynthesisHandler(
  ctx: CodeTaskContext,
): Promise<CodeTaskResult> {
  const raw = ctx.outputMap.get(VIDEO_TASK_IDS.SCRIPT_GENERATION);
  const parsed = parseUpstream(raw, "T1 script");
  const script = ScriptSchema.parse(parsed); // 严格校验，失败抛错进入重试

  const segments: Array<{
    index: number;
    audio_path: string | null;
    duration_s?: number;
  }> = [];
  const errors: Array<{ index: number; reason: string }> = [];
  const attachments: Attachment[] = [];

  for (const scene of script.scenes) {
    if (ctx.signal?.aborted) throw new Error("Execution cancelled by user");
    try {
      const result = await forgeTts({ text: scene.narration_text });
      // 服务端 /forge/tts 返回字段为 audio_path（非 local_path），见 ForgeTtsResult 注释。
      // 之前误读 result.local_path 导致全部 undefined → guardrail 失败 → T6 读空崩溃
      segments.push({
        index: scene.index,
        audio_path: result.audio_path,
        duration_s: result.duration,
      });
      attachments.push({
        path: result.audio_path,
        kind: "audio",
        filename: `audio_${scene.index}.mp3`,
        caption: `Scene ${scene.index} TTS`,
      });
      logger.info(
        { taskId: ctx.taskId, index: scene.index, path: result.audio_path },
        "forge_tts 完成",
      );
    } catch (err) {
      const reason = flattenForgeError(err);
      segments.push({ index: scene.index, audio_path: null });
      errors.push({ index: scene.index, reason });
      logger.warn({ taskId: ctx.taskId, index: scene.index, reason }, "forge_tts 失败");
    }
  }

  const output = {
    audio_segments: segments,
    errors: errors.length ? errors : undefined,
  };
  return { output: JSON.stringify(output, null, 2), attachments };
}

// ─── Handler 2：T5 - 视觉制作（顺序调 forge_image）───────────

/**
 * 读 T3 storyboard 的 frames 数组，顺序为每帧调用 forge_image。
 *
 * MVP 策略：只生成图像，不生成视频（video_path=null）。
 * 理由：
 *   - 单张视频生成 60-150s，6 帧 ≈ 10-15 分钟，E2E 先求通，后续按需启用
 *   - forge_image 已是 RunningHub 默认工作流的同步调用，稳定性更高
 */
export async function visualProductionHandler(
  ctx: CodeTaskContext,
): Promise<CodeTaskResult> {
  const raw = ctx.outputMap.get(VIDEO_TASK_IDS.STORYBOARD_INIT);
  const parsed = parseUpstream(raw, "T3 storyboard");
  const storyboard = StoryboardSchema.parse(parsed);

  const frames: Array<{
    index: number;
    image_path: string | null;
    video_path: string | null;
  }> = [];
  const errors: Array<{ index: number; reason: string }> = [];
  const attachments: Attachment[] = [];

  for (const frame of storyboard.frames) {
    if (ctx.signal?.aborted) throw new Error("Execution cancelled by user");
    try {
      const result = await forgeImage({ prompt: frame.image_prompt });
      const imgPath = result.local_path || result.url || null;
      frames.push({
        index: frame.index,
        image_path: imgPath,
        video_path: null,
      });
      if (imgPath && result.local_path) {
        attachments.push({
          path: result.local_path,
          kind: "image",
          filename: `image_${frame.index}.png`,
          caption: `Frame ${frame.index}`,
        });
      }
      logger.info(
        { taskId: ctx.taskId, index: frame.index, path: imgPath },
        "forge_image 完成",
      );
    } catch (err) {
      const reason = flattenForgeError(err);
      frames.push({ index: frame.index, image_path: null, video_path: null });
      errors.push({ index: frame.index, reason });
      logger.warn({ taskId: ctx.taskId, index: frame.index, reason }, "forge_image 失败");
    }
  }

  const output = {
    frames,
    errors: errors.length ? errors : undefined,
  };
  return { output: JSON.stringify(output, null, 2), attachments };
}

// ─── Handler 3：T6 - 帧合成（顺序调 forge_compose_frame）────

/**
 * 按 index 对齐 T4 音频 + T5 图像，逐帧合成视频片段。
 * 任一帧缺少 audio_path / image_path 时跳过并记 errors，
 * 真正成功的帧会进入 segments 列表。
 */
export async function frameCompositionHandler(
  ctx: CodeTaskContext,
): Promise<CodeTaskResult> {
  const audioParsed = parseUpstream(
    ctx.outputMap.get(VIDEO_TASK_IDS.AUDIO_SYNTHESIS),
    "T4 audio",
  ) as { audio_segments: Array<{ index: number; audio_path: string | null }> };
  const videoParsed = parseUpstream(
    ctx.outputMap.get(VIDEO_TASK_IDS.VISUAL_PRODUCTION),
    "T5 video",
  ) as { frames: Array<{ index: number; image_path: string | null }> };

  const audioMap = new Map(audioParsed.audio_segments.map((a) => [a.index, a.audio_path]));
  const imageMap = new Map(videoParsed.frames.map((f) => [f.index, f.image_path]));

  const indices = [...new Set([...audioMap.keys(), ...imageMap.keys()])].sort((a, b) => a - b);
  const segments: Array<{ index: number; path: string }> = [];
  const errors: Array<{ index: number; reason: string }> = [];
  const attachments: Attachment[] = [];

  for (const idx of indices) {
    if (ctx.signal?.aborted) throw new Error("Execution cancelled by user");
    const audio = audioMap.get(idx);
    const image = imageMap.get(idx);
    if (!audio || !image) {
      errors.push({
        index: idx,
        reason: `缺少素材：audio=${audio ?? "null"} image=${image ?? "null"}`,
      });
      continue;
    }
    try {
      const result = await forgeComposeFrame({ image_path: image, audio_path: audio });
      segments.push({ index: idx, path: result.video_segment_path });
      attachments.push({
        path: result.video_segment_path,
        kind: "video",
        filename: `segment_${idx}.mp4`,
        caption: `Segment ${idx}`,
      });
      logger.info(
        { taskId: ctx.taskId, index: idx, path: result.video_segment_path },
        "forge_compose_frame 完成",
      );
    } catch (err) {
      const reason = flattenForgeError(err);
      errors.push({ index: idx, reason });
      logger.warn({ taskId: ctx.taskId, index: idx, reason }, "forge_compose_frame 失败");
    }
  }

  if (segments.length === 0) {
    throw new Error(`T6 帧合成全部失败：${JSON.stringify(errors)}`);
  }

  const output = {
    segments,
    errors: errors.length ? errors : undefined,
  };
  return { output: JSON.stringify(output, null, 2), attachments };
}

// ─── Handler 4：T7 - 最终拼接（forge_concat）────────────────

/**
 * 读 T6 segments，按 index 升序拼接为最终视频。
 * 少于 2 段时直接抛错（forge_concat 要求至少 2 段）。
 */
export async function finalMergeHandler(
  ctx: CodeTaskContext,
): Promise<CodeTaskResult> {
  const parsed = parseUpstream(
    ctx.outputMap.get(VIDEO_TASK_IDS.FRAME_COMPOSITION),
    "T6 segments",
  ) as { segments: Array<{ index: number; path: string }> };

  if (!Array.isArray(parsed.segments) || parsed.segments.length < 2) {
    throw new Error(
      `T7 最终拼接需要至少 2 段视频片段，当前只有 ${parsed.segments?.length ?? 0} 段`,
    );
  }

  // 按 index 升序确保播放顺序正确
  const ordered = [...parsed.segments].sort((a, b) => a.index - b.index);
  const paths = ordered.map((s) => s.path);

  if (ctx.signal?.aborted) throw new Error("Execution cancelled by user");

  const result = await forgeConcat({ segments: paths });

  const attachments: Attachment[] = [
    {
      path: result.output_path,
      kind: "video",
      filename: "final.mp4",
      caption: "Final Video",
    },
  ];

  const output = {
    final_video_path: result.output_path,
    duration_s: null, // forge_concat 未返回 duration，后续如需可加 ffprobe
    segment_count: ordered.length,
  };
  return { output: JSON.stringify(output, null, 2), attachments };
}
