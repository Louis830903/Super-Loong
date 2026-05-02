/**
 * Video-Forge Atomic Tools — 7 个原子工具封装 HTTP 调用。
 *
 * 对齐 Spec v1.4 §4.1 接口表 + §5.1 T1.9：
 * 1. forge_image      — 图片生成（同步）
 * 2. forge_video       — 视频生成（异步提交）
 * 3. forge_video_status — 视频 Job 状态轮询（v1.4 新增）
 * 4. forge_tts          — TTS 语音合成（同步）
 * 5. forge_compose_frame — 帧合成（同步）
 * 6. forge_concat       — 视频拼接（同步）
 * 7. forge_add_bgm      — 添加背景音乐（同步）
 *
 * 工具返回 ToolResult 结构，含结构化错误供 ReflectionEngine 自愈使用。
 */

import { z } from "zod";
import pino from "pino";
import fs from "node:fs";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import {
  forgeImage,
  forgeVideoSubmit,
  forgeVideoStatus,
  forgeTts,
  forgeComposeFrame,
  forgeConcat,
  forgeAddBgm,
  VideoForgeRequestError,
} from "../services/video-forge-client.js";

const logger = pino({ name: "video-forge-tools" });

// ─── P0-D：tool schema 硬约束常量 ─────────────────────────────
// 允许的 TTS 发音人白名单（对齐 forge 微服务 edge-tts 受支持音色）。
// 枚举化后 LLM 只能传这几个值，无法再编造 "female-young" / "default" 等胡乱音色。
const TTS_VOICES = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunyangNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunxiaNeural",
  "en-US-AriaNeural",
  "en-US-GuyNeural",
] as const;

/** 路径真实性硬校验 refine：解决 LLM 编造 hex 假路径的类问题。 */
const existingFilePath = z
  .string()
  .refine((p) => p.trim().length > 0 && fs.existsSync(p), {
    message: "文件路径必须真实存在于磁盘",
  });

// ── 工具辅助 ──────────────────────────────────────

/** 将 VideoForgeRequestError 转为 Agent 可识别的结构化 ToolResult */
function errorResult(err: unknown): ToolResult {
  if (err instanceof VideoForgeRequestError) {
    // RunningHub 内容审核失败 → 给出明确的 prompt 重写指引，让 reflection 能针对性修正
    // 不标记为 retryable（同样 prompt 再送还会被拒）；由上层 reflection 决定重写后重试
    if (err.code === "AUDIT_REJECTED") {
      return {
        success: false,
        output:
          "\u274c RunningHub \u5185\u5bb9\u5ba1\u6838\u62d2\u7edd\u3002\n" +
          "\u7406\u7531\uff1a" + err.message + "\n\n" +
          "\ud83d\udccc **\u8bf7\u91cd\u5199 prompt**\uff0c\u9075\u5b88\u4ee5\u4e0b\u7ea6\u675f\uff1a\n" +
          "1. \u7981\u6b62\u8eab\u4f53\u8fd1\u666f\uff08\u7279\u522b\u662f\u8db3\u90e8/\u76ae\u80a4/\u5934\u53d1\u7279\u5199\uff09\n" +
          "2. \u7981\u6b62\u88f8\u9732\u63cf\u8ff0\uff08barefoot / shirtless / rolled sock / rumpled clothes\uff09\n" +
          "3. \u7981\u6b62\u76ae\u80a4\u7eb9\u7406\u8bcd\uff08freckles / pores / skin texture / fabric weave on body\uff09\n" +
          "4. \u7981\u6b62\u5177\u4f53\u8eab\u4f53\u90e8\u4f4d\u8bed\uff08toes / feet / lips / neck \u7279\u5199\uff09\n" +
          "5. \u4fdd\u7559\u5e74\u9f84\u6027\u522b\u7b49\u89d2\u8272\u5fc5\u8981\u4fe1\u606f\u4ee5\u652f\u6491\u5267\u60c5\n" +
          "6. \u591a\u7528\u8fdc\u666f/\u4e2d\u666f + \u73af\u5883/\u60c5\u7eea/\u5149\u7ebf \u63cf\u8ff0\uff0c\u907f\u514d\u4eba\u7269\u8eab\u4f53\u5199\u5b9e\u7ec6\u8282\n" +
          "7. \u53ef\u52a0\u6b63\u5411\u7ea6\u675f\uff1aSFW, family-friendly, wholesome scene",
        error: err.message,
        data: {
          code: err.code,
          retryable: false,
          statusCode: err.statusCode,
          guidance: "rewrite_prompt_sfw",
        },
      };
    }
    return {
      success: false,
      output: `\u274c video-forge \u9519\u8bef: ${err.message}`,
      error: err.message,
      data: {
        code: err.code,
        retryable: err.retryable,
        statusCode: err.statusCode,
      },
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    output: `\u274c video-forge \u8c03\u7528\u5931\u8d25: ${msg}`,
    error: msg,
    data: { code: "UNKNOWN", retryable: false },
  };
}

// ── 工具定义 ──────────────────────────────────────

/** 1. forge_image — 文生图 / 图生图（ComfyUI 工作流） */
const forgeImageTool: ToolDefinition = {
  name: "forge_image",
  description:
    "通过 video-forge 微服务生成图片。把画面的风格、光照、构图等写进 prompt 即可。" +
    "除非明确知道工作流文件名（如 runninghub/image_flux.json），否则不要填 workflow 参数。" +
    "返回图片 URL 或本地路径。适用于短视频帧图、封面图等场景。",
  parameters: z.object({
    prompt: z.string().describe(
      "图片描述（中英文均可）。风格、光照、画面构图等都放到 prompt 里。"
    ),
    workflow: z
      .string()
      .optional()
      .describe(
        "可选。ComfyUI 工作流 JSON 路径，必须形如 'runninghub/image_flux.json'，以 '.json' 结尾且带目录前缀。" +
        "不确定时请 **留空**（勿传风格/光照等关键词），微服务会使用默认工作流。"
      ),
    width: z.number().optional().describe("图片宽度（默认由工作流决定）"),
    height: z.number().optional().describe("图片高度（默认由工作流决定）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { prompt, workflow, width, height } = params as {
      prompt: string;
      workflow?: string;
      width?: number;
      height?: number;
    };

    // 防御：LLM 经常把 "cinematic_soft_light" 这类风格关键词误传为 workflow。
    // 仅接受带 '/' 和 '.json' 后缀的合法工作流路径，否则丢弃由微服务使用默认值。
    const safeWorkflow =
      workflow && /\//.test(workflow) && /\.json$/i.test(workflow)
        ? workflow
        : undefined;
    const workflowWarning =
      workflow && !safeWorkflow
        ? `⚠️ 你传入的 workflow="${workflow}" 不是合法的工作流 JSON 路径（需形如 runninghub/xxx.json），已被自动丢弃并使用默认工作流。下次调用请把风格词写进 prompt，workflow 留空。\n`
        : "";
    if (workflow && !safeWorkflow) {
      logger.warn(
        { invalidWorkflow: workflow },
        "forge_image: workflow 参数疑似风格关键词，已丢弃改用默认工作流"
      );
    }

    try {
      const result = await forgeImage({ prompt, workflow: safeWorkflow, width, height });
      return {
        success: true,
        // [P2-2] 把"workflow 被丢弃"的事实柔性回传给 LLM，
        // 便于下一次调用自我纠正（相比静默 warn 只记日志，LLM 永远看不到）。
        output: `${workflowWarning}✅ 图片生成完成\n📁 ${result.local_path || result.url || "未知路径"}`,
        data: result,
      };
    } catch (err) {
      logger.error({ err, prompt }, "forge_image 失败");
      return errorResult(err);
    }
  },
};

/** 2. forge_video — 视频生成（异步提交，返回 job_id） */
const forgeVideoTool: ToolDefinition = {
  name: "forge_video",
  description:
    "通过 video-forge 微服务生成视频片段（异步任务）。" +
    "调用后返回 job_id，需使用 forge_video_status 轮询结果。" +
    "典型耗时 30-120 秒。",
  parameters: z.object({
    prompt: z.string().describe("视频描述（中英文均可）"),
    workflow: z
      .string()
      .optional()
      .describe(
        "可选。视频 ComfyUI 工作流 JSON 路径，必须形如 'runninghub/video_wan2.1_fusionx.json'，带 '/' 且以 '.json' 结尾。" +
        "不确定时请 **留空**（勿传风格/光照等关键词），微服务会使用默认工作流。"
      ),
    duration: z.number().optional().describe("视频时长（秒），默认 5"),
    ref_image: z
      .string()
      .optional()
      .describe("参考图片路径（图生视频模式）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { prompt, workflow, duration, ref_image } = params as {
      prompt: string;
      workflow?: string;
      duration?: number;
      ref_image?: string;
    };

    // [P2-2] 同 forge_image：LLM 可能误传风格词作为 workflow，做同样防御。
    const safeWorkflow =
      workflow && /\//.test(workflow) && /\.json$/i.test(workflow)
        ? workflow
        : undefined;
    const workflowWarning =
      workflow && !safeWorkflow
        ? `⚠️ 你传入的 workflow="${workflow}" 不是合法的工作流 JSON 路径（需形如 runninghub/xxx.json），已被自动丢弃并使用默认工作流。下次调用请把风格词写进 prompt，workflow 留空。\n`
        : "";
    if (workflow && !safeWorkflow) {
      logger.warn(
        { invalidWorkflow: workflow },
        "forge_video: workflow 参数疑似风格关键词，已丢弃改用默认工作流"
      );
    }

    try {
      const result = await forgeVideoSubmit({
        prompt,
        workflow: safeWorkflow,
        duration,
        ref_image,
      });
      return {
        success: true,
        output: `${workflowWarning}✅ 视频任务已提交\n🆔 Job ID: ${result.job_id}\n📊 状态: ${result.status}\n请使用 forge_video_status 轮询结果。`,
        data: result,
      };
    } catch (err) {
      logger.error({ err, prompt }, "forge_video 失败");
      return errorResult(err);
    }
  },
};

/** 3. forge_video_status — 查询视频 Job 状态（v1.4 新增） */
const forgeVideoStatusTool: ToolDefinition = {
  name: "forge_video_status",
  description:
    "查询 forge_video 提交的异步视频生成任务的状态。" +
    "状态枚举：queued（排队中）、running（生成中）、succeeded（成功）、failed（失败）。" +
    "succeeded 时返回视频文件路径。",
  parameters: z.object({
    job_id: z.string().describe("forge_video 返回的 Job ID"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { job_id } = params as { job_id: string };

    try {
      const result = await forgeVideoStatus(job_id);
      const statusEmoji: Record<string, string> = {
        queued: "⏳",
        running: "🔄",
        succeeded: "✅",
        failed: "❌",
      };
      const emoji = statusEmoji[result.status] || "❓";

      let output = `${emoji} 视频任务状态: ${result.status}`;
      if (result.progress !== undefined) {
        output += `\n📊 进度: ${result.progress}%`;
      }
      if (result.status === "succeeded" && result.output) {
        output += `\n📁 ${result.output.local_path || result.output.url || ""}`;
      }
      if (result.status === "failed" && result.error) {
        output += `\n❌ 错误: ${result.error}`;
      }

      return {
        success: result.status !== "failed",
        output,
        data: result,
      };
    } catch (err) {
      logger.error({ err, job_id }, "forge_video_status 失败");
      return errorResult(err);
    }
  },
};

/** 4. forge_tts — TTS 语音合成 */
const forgeTtsTool: ToolDefinition = {
  name: "forge_tts",
  description:
    "通过 video-forge 微服务将文字转换为语音（TTS）。" +
    "支持 Edge TTS 和 ComfyUI 两种模式。返回 mp3 文件路径和时长。",
  parameters: z.object({
    text: z.string().min(1).describe("要转换的文字"),
    // P0-D：voice 改为枚举白名单，防御 LLM 编造音色名导致 forge 服务拒绝
    voice: z
      .enum(TTS_VOICES)
      .optional()
      .describe(
        `发音人（仅支持以下白名单：${TTS_VOICES.join(" / ")}），留空使用默认`,
      ),
    speed: z
      .number()
      .min(0.5)
      .max(2.0)
      .optional()
      .describe("语速倍率（0.5-2.0），留空使用默认 1.0"),
    workflow: z
      .string()
      .optional()
      .describe("TTS 工作流（使用 ComfyUI 模式时指定）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { text, voice, speed, workflow } = params as {
      text: string;
      voice?: string;
      speed?: number;
      workflow?: string;
    };

    try {
      const result = await forgeTts({ text, voice, speed, workflow });
      // 服务端 /forge/tts 返回字段为 audio_path（见 ForgeTtsResult 类型注释）
      let output = `✅ TTS 合成完成\n📁 ${result.audio_path}`;
      if (result.duration) {
        output += `\n⏱️ 时长: ${result.duration.toFixed(1)}s`;
      }
      return { success: true, output, data: result };
    } catch (err) {
      logger.error({ err, textLen: text.length }, "forge_tts 失败");
      return errorResult(err);
    }
  },
};

/** 5. forge_compose_frame — 帧合成（图+音→视频段） */
const forgeComposeFrameTool: ToolDefinition = {
  name: "forge_compose_frame",
  description:
    "将图片和音频合成为一个视频片段。" +
    "用于将 TTS 旁白叠加到帧图上，可选添加字幕和 HTML 模板。",
  parameters: z.object({
    // P0-D：image_path / audio_path 加 fs.existsSync refine，LLM 编造路径立刻被拦截
    image_path: existingFilePath.describe("帧图片路径（必须真实存在于磁盘）"),
    audio_path: existingFilePath.describe("音频路径（必须真实存在于磁盘，TTS mp3）"),
    subtitle: z.string().optional().describe("字幕文本"),
    template: z
      .string()
      .optional()
      .describe("HTML 模板路径（如 1080x1920/image_default.html）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { image_path, audio_path, subtitle, template } = params as {
      image_path: string;
      audio_path: string;
      subtitle?: string;
      template?: string;
    };

    try {
      const result = await forgeComposeFrame({
        image_path,
        audio_path,
        subtitle,
        template,
      });
      let output = `✅ 帧合成完成\n📁 ${result.video_segment_path}`;
      if (result.duration) {
        output += `\n⏱️ 时长: ${result.duration.toFixed(1)}s`;
      }
      return { success: true, output, data: result };
    } catch (err) {
      logger.error({ err }, "forge_compose_frame 失败");
      return errorResult(err);
    }
  },
};

/** 6. forge_concat — 视频拼接 */
const forgeConcatTool: ToolDefinition = {
  name: "forge_concat",
  description:
    "将多个视频片段按顺序拼接为一个完整视频。" +
    "输入为视频文件路径数组，输出为拼接后的视频路径。",
  parameters: z.object({
    segments: z
      .array(z.string())
      .min(2)
      .describe("视频片段路径数组（按顺序拼接）"),
    output: z.string().optional().describe("输出文件路径（留空自动生成）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { segments, output } = params as {
      segments: string[];
      output?: string;
    };

    try {
      const result = await forgeConcat({ segments, output });
      return {
        success: true,
        output: `✅ 视频拼接完成（${segments.length} 段）\n📁 ${result.output_path}`,
        data: result,
      };
    } catch (err) {
      logger.error({ err, segmentCount: segments.length }, "forge_concat 失败");
      return errorResult(err);
    }
  },
};

/** 7. forge_add_bgm — 添加背景音乐 */
const forgeAddBgmTool: ToolDefinition = {
  name: "forge_add_bgm",
  description:
    "为视频添加背景音乐（BGM）。" +
    "音乐时长自动适配视频长度，支持调节音量。",
  parameters: z.object({
    video_path: z.string().describe("输入视频路径"),
    bgm_path: z.string().describe("BGM 音频路径"),
    volume: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("BGM 音量（0-1），默认 0.3"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { video_path, bgm_path, volume } = params as {
      video_path: string;
      bgm_path: string;
      volume?: number;
    };

    try {
      const result = await forgeAddBgm({ video_path, bgm_path, volume });
      return {
        success: true,
        output: `✅ 背景音乐添加完成\n📁 ${result.output_path}`,
        data: result,
      };
    } catch (err) {
      logger.error({ err }, "forge_add_bgm 失败");
      return errorResult(err);
    }
  },
};

// ── 导出 ──────────────────────────────────────────

export const videoForgeTools: ToolDefinition[] = [
  forgeImageTool,
  forgeVideoTool,
  forgeVideoStatusTool,
  forgeTtsTool,
  forgeComposeFrameTool,
  forgeConcatTool,
  forgeAddBgmTool,
];
