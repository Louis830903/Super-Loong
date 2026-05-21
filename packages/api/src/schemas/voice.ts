/**
 * v3 Task 6 — Voice 路由 zod schema
 *
 * @why 语音转写/合成端点有 multipart 和 binary 特殊场景，此处定义 JSON body 格式。
 *      binary audio response (synthesize) 走 skipEnvelope = true。
 *
 * 端点：
 *   POST /api/voice/transcribe  — 语音转文字（base64 / raw buffer）
 *   POST /api/voice/synthesize  — 文字转语音（返回二进制音频）
 *   GET  /api/voice/providers   — 可用 STT Provider 列表
 */

import { z } from "zod";
import { registry } from "./registry-singleton.js";
import { apiSuccessEnvelope } from "./envelope.js";

// ─── Transcribe ─────────────────────────────────────────────

/** @why POST /api/voice/transcribe 请求体，含 base64 音频和幻觉过滤参数 */
export const TranscribeBodySchema = z.object({
  audio: z.string().describe("base64 encoded audio data"),
  language: z.string().default("zh").optional(),
  format: z.string().default("webm").optional(),
  rmsPeak: z.number().optional().describe("前端 AudioContext RMS 峰值，用于幻觉过滤"),
});
registry.register("TranscribeBody", TranscribeBodySchema);

const TranscribeResultData = z.object({
  text: z.string(),
  filtered: z.boolean().optional().describe("true = Whisper 幻觉已过滤"),
});

// ─── Synthesize ─────────────────────────────────────────────

/** @why POST /api/voice/synthesize 请求体，文字转语音参数 */
export const SynthesizeBodySchema = z.object({
  text: z.string(),
  voice: z.string().optional(),
  speed: z.number().optional(),
  volume: z.number().optional(),
  format: z.string().optional(),
});
registry.register("SynthesizeBody", SynthesizeBodySchema);

// ─── Providers ──────────────────────────────────────────────

const SttProviderEnum = z.enum(["stt-custom", "aliyun-nls", "llm-whisper", "groq"]);
const ProvidersData = z.object({ providers: z.array(SttProviderEnum) });

// ─── 注册路径 ───────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/voice/transcribe",
  summary: "语音转文字（多 Provider 自动降级）",
  request: { body: { content: { "application/json": { schema: TranscribeBodySchema } } } },
  responses: {
    200: { description: "转写结果", content: { "application/json": { schema: apiSuccessEnvelope(TranscribeResultData) } } },
    503: { description: "所有 STT 服务不可用" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/voice/synthesize",
  summary: "文字转语音（返回 audio/mpeg 二进制）",
  request: { body: { content: { "application/json": { schema: SynthesizeBodySchema } } } },
  responses: {
    200: { description: "音频二进制流", content: { "audio/mpeg": { schema: z.any() } } },
    400: { description: "text 字段缺失" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/voice/providers",
  summary: "获取可用 STT Provider 列表",
  responses: {
    200: { description: "Provider 列表", content: { "application/json": { schema: apiSuccessEnvelope(ProvidersData) } } },
  },
});
