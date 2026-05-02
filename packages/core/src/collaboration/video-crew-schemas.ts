/**
 * video-crew-schemas.ts — ShortVideoCrew Task I/O Zod 契约
 *
 * 三类 Schema 分别约束 WriterAgent / DesignerAgent / StoryboardAgent 的输出格式，
 * 避免 LLM 输出 JSON 漂移污染下游工具链。
 *
 * guardrail 适配器 `buildGuardrail` 将 Zod Schema 转为 orchestrator 期望的
 * `(output: string) => { valid: boolean; feedback?: string }` 签名，
 * 配合 T2.0 改造的 feedback 注入，实现"告知→修正"闭环。
 *
 * @see Spec §4.3.1 Task I/O Zod Schema
 */

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

// ─── Task 1 - WriterAgent 输出：脚本 ────────────────────────

export const ScriptSchema = z.object({
  /** 视频标题，2-40 个字符 */
  title: z.string().min(2).max(40),
  /** 完整旁白文稿，20-1000 个字符 */
  narration_full: z.string().min(20).max(1000),
  /** 分段脚本，固定 6 段（MVP Phase 1/2） */
  scenes: z.array(z.object({
    index: z.number().int().min(0),
    narration_text: z.string().min(4).max(120),
    duration_s: z.number().min(3).max(10),
  })).length(6),
});

// ─── Task 2 - DesignerAgent 输出：图生 prompt 列表 ──────────

export const ImagePromptsSchema = z.object({
  /** 全局风格标签（如 "realistic_photo", "anime", "oil_painting"） */
  style_tag: z.string().min(1),
  /** 每段的图生 prompt，固定 6 段 */
  prompts: z.array(z.object({
    index: z.number().int().min(0),
    /** 送 ComfyUI 的英文 prompt（含风格/主体/镜头/光影等细节，上限放宽到 2000 避免 LLM 频繁踩限） */
    prompt_en: z.string().min(10).max(2000),
    /** 可选的反向 prompt */
    negative_prompt: z.string().optional(),
  })).length(6),
});

// ─── Task 3 - StoryboardAgent 输出：分镜聚合 ────────────────

export const StoryboardSchema = z.object({
  title: z.string().min(1),
  style_tag: z.string().min(1),
  /** 6 帧分镜，聚合 Script + ImagePrompts */
  frames: z.array(z.object({
    index: z.number().int().min(0),
    narration_text: z.string().min(1),
    image_prompt: z.string().min(1),
    duration_s: z.number().min(1),
  })).length(6),
});

// ─── guardrail 适配器 ──────────────────────────────────────

/**
 * 将 Zod Schema 适配为 orchestrator guardrail 回调签名。
 *
 * guardrail 签名：`(output: string) => { valid: boolean; feedback?: string }`
 * - valid: true → 校验通过，继续下游
 * - valid: false → 校验失败，feedback 字符串会被 T2.0 改造后的
 *   executeTask() 自动注入到下一轮 prompt 中，引导 LLM 修正
 *
 * @param schema - Zod 校验 schema
 * @returns guardrail 回调函数
 */
/**
 * 剥离 LLM 常见的 markdown code fence 包裹。
 *
 * LLM（尤其是 Qwen/DeepSeek）习惯把 JSON 包进 ```json ... ``` 或 ``` ... ``` 中，
 * 导致 JSON.parse 直接失败。此函数先尝试提取 fence 内部内容，若无 fence 则原样返回。
 *
 * P0-D：code handler 解析上游 LLM 输出时也需要复用，故 export。
 */
export function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  // 匹配 ```json\n...\n``` 或 ```\n...\n```（语言标签可选）
  const fenceMatch = trimmed.match(/^```(?:json|javascript|js)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // 退化：若开头是 ``` 但结构不严格，截取首个 { 到末尾 }
  if (trimmed.startsWith("```")) {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }
  }
  return trimmed;
}

export function buildGuardrail(schema: z.ZodType) {
  return (output: string): { valid: boolean; feedback?: string } => {
    try {
      // 先剥离 markdown fence，再尝试 JSON 解析
      const cleaned = stripMarkdownFence(output);
      const parsed = JSON.parse(cleaned);
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { valid: true };
      }
      // 将 Zod 错误转为人类可读的 feedback
      const feedback = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return { valid: false, feedback };
    } catch (e) {
      return { valid: false, feedback: `JSON 解析失败: ${(e as Error).message}` };
    }
  };
}

// ─── 便捷导出：预构建的 guardrail 实例 ─────────────────────

/** WriterAgent Task 1 输出校验 */
export const scriptGuardrail = buildGuardrail(ScriptSchema);

/** DesignerAgent Task 2 输出校验 */
export const imagePromptsGuardrail = buildGuardrail(ImagePromptsSchema);

/** StoryboardAgent Task 3 输出校验 */
export const storyboardGuardrail = buildGuardrail(StoryboardSchema);

// ─── Task 4 - VoiceAgent 输出：音频段 ───────────────────────

export const VoiceOutputSchema = z.object({
  audio_segments: z
    .array(
      z.object({
        index: z.number().int().min(0),
        /** 音频本地路径；允许 null 表示该段 TTS 失败 */
        audio_path: z.union([z.string().min(1), z.null()]),
        duration_s: z.number().min(0).max(120).optional(),
      }),
    )
    .length(6),
  errors: z.array(z.any()).optional(),
});

// ─── Task 5 - VideoAgent 输出：帧图像/视频 ──────────────────

export const VideoOutputSchema = z.object({
  frames: z
    .array(
      z.object({
        index: z.number().int().min(0),
        image_path: z.union([z.string().min(1), z.null()]),
        video_path: z.union([z.string().min(1), z.null()]).optional(),
      }),
    )
    .length(6),
  errors: z.array(z.any()).optional(),
});

// ─── 路径真实性硬校验（P0-C） ─────────────────────────────

/**
 * 可疑规律化路径模式 —— 命中即判定为"Agent 合理化编造"。
 *
 * 真实 forge_tts / forge_image 产物命名规则：
 *   - edge_tts: `output/{uuid32hex}.mp3`  (如 4d476268854346629e1fb25d6f564164.mp3)
 *   - standard_api: `output/standard_api/YYYYMMDD/HHMMSS_{8hex}.{ext}`
 * Agent 常犯的编造模式：scene_0/1/2、audio_0/1/2、tts_001、frame_0、纯数字等。
 */
const SUSPICIOUS_PATH_PATTERNS: RegExp[] = [
  // scene_0.mp3 / scene_1.png 等按 index 编号
  /(?:^|[\\/])scene[_-]?\d+\.(mp3|wav|m4a|png|jpg|jpeg|mp4)$/i,
  // audio_0 / frame_0 / video_0 / img_0 等"类型_序号"
  /(?:^|[\\/])(audio|frame|video|img|image|clip|seg|segment)[_-]?\d+\.(mp3|wav|m4a|png|jpg|jpeg|mp4)$/i,
  // tts_001 / tts-002
  /(?:^|[\\/])tts[_-]?\d+\.(mp3|wav|m4a)$/i,
  // 纯数字 output/0.mp3 / 1.png
  /(?:^|[\\/])\d+\.(mp3|wav|m4a|png|jpg|jpeg|mp4)$/i,
];

/** video-forge 服务根目录（相对路径解析起点，兼容 dev 与 prod 布局）。 */
const VIDEO_FORGE_ROOT_CANDIDATES = [
  path.resolve(process.cwd(), "services/video-forge"),
  path.resolve(process.cwd(), "../services/video-forge"),
  path.resolve(process.cwd(), "../../services/video-forge"),
];

/**
 * 尽力判定一个路径是否真实存在。
 * - 绝对路径：直接 fs.existsSync
 * - 相对路径：在 cwd 及 video-forge 服务目录下多点尝试
 * 找不到返回 false；此时 guardrail 会判假。
 */
function pathExistsSmart(p: string): boolean {
  try {
    if (path.isAbsolute(p)) return fs.existsSync(p);
    if (fs.existsSync(path.resolve(process.cwd(), p))) return true;
    for (const root of VIDEO_FORGE_ROOT_CANDIDATES) {
      if (fs.existsSync(path.resolve(root, p))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 通用路径硬校验：检查路径是否编造（模式 + 存在性）。
 * 返回校验错误列表；空数组表示全部通过。
 */
function validatePathList(
  pairs: Array<{ field: string; index: number; value: string | null | undefined }>,
): string[] {
  const errors: string[] = [];
  for (const { field, index, value } of pairs) {
    if (value == null || value === "") continue; // null = 失败声明，放行
    // 1) 规律化模式检测
    for (const rx of SUSPICIOUS_PATH_PATTERNS) {
      if (rx.test(value)) {
        errors.push(
          `${field}[${index}]="${value}" 疑似规律化编造（真实路径应为 uuid hex 或时间戳_shortid 命名）`,
        );
        break;
      }
    }
    // 2) 磁盘存在性检测（只要不匹配模式，继续查文件系统）
    if (!pathExistsSmart(value)) {
      errors.push(
        `${field}[${index}]="${value}" 在磁盘上找不到（cwd + video-forge 候选目录均 miss）`,
      );
    }
  }
  return errors;
}

/**
 * VoiceAgent Task 4 输出校验：Schema + 路径真实性。
 */
export const voiceGuardrail = (output: string): { valid: boolean; feedback?: string } => {
  const base = buildGuardrail(VoiceOutputSchema)(output);
  if (!base.valid) return base;
  try {
    const parsed = JSON.parse(stripMarkdownFence(output));
    const pathErrors = validatePathList(
      parsed.audio_segments.map((s: any) => ({
        field: "audio_path",
        index: s.index,
        value: s.audio_path,
      })),
    );
    if (pathErrors.length > 0) {
      return {
        valid: false,
        feedback:
          `路径校验失败（违反真实路径守则）：${pathErrors.join("；")}。` +
          `请重新调用 forge_tts 并把返回的 local_path 原样复制到 audio_path。` +
          `真实路径形如 output/4d476268854346629e1fb25d6f564164.mp3，禁止出现 scene_0/audio_0 等规律编号。`,
      };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, feedback: `voice 输出解析失败: ${(e as Error).message}` };
  }
};

/**
 * VideoAgent Task 5 输出校验：Schema + 路径真实性。
 */
export const videoGuardrail = (output: string): { valid: boolean; feedback?: string } => {
  const base = buildGuardrail(VideoOutputSchema)(output);
  if (!base.valid) return base;
  try {
    const parsed = JSON.parse(stripMarkdownFence(output));
    const pairs = [];
    for (const f of parsed.frames) {
      pairs.push({ field: "image_path", index: f.index, value: f.image_path });
      pairs.push({ field: "video_path", index: f.index, value: f.video_path });
    }
    const pathErrors = validatePathList(pairs);
    if (pathErrors.length > 0) {
      return {
        valid: false,
        feedback:
          `路径校验失败（违反真实路径守则）：${pathErrors.join("；")}。` +
          `请重新调用 forge_image / forge_video_status 并原样使用返回的 local_path。` +
          `禁止出现 frame_0.png / video_0.mp4 等规律编号；失败的帧请置 null 并在 errors 里记录。`,
      };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, feedback: `video 输出解析失败: ${(e as Error).message}` };
  }
};
