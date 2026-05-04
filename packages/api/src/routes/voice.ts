/**
 * Voice Routes — TTS/STT API endpoints.
 *
 * POST /api/voice/transcribe  — Speech to text (upload audio)
 * POST /api/voice/synthesize  — Text to speech (returns audio)
 * GET  /api/voice/providers   — List available voice providers
 */

import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "@super-agent/core";
import type { AppContext } from "../context.js";

// ─── 多 Provider 自动降级链类型 ─────────────────────────────
type SttProvider = "stt-custom" | "aliyun-nls" | "llm-whisper" | "groq";

// ─── 启动时静态检测可用 Provider（纯静态检查，不发网络请求）──
// configStore 可选：传入则可检查 UI 设置页面持久化的凭据（阿里云等）
export function detectAvailableProviders(configStore?: ConfigStore): SttProvider[] {
  const providers: SttProvider[] = [];

  // 0. stt-custom: 用户显式配了 STT_API_URL + STT_API_KEY（独立 STT 服务，最高优先）
  // 两者缺一不可：只有 URL 没有 Key 无法鉴权
  if (process.env.STT_API_URL && process.env.STT_API_KEY) {
    providers.push("stt-custom");
  }

  // 1. aliyun-nls: 阿里云语音识别（企业级，需 AccessKey ID + Secret + AppKey）
  // 优先读取 ConfigStore（UI 设置页持久化值），降级到环境变量
  const aliyunCfg = configStore?.getAll("aliyun_voice");
  const hasAliyunAK =
    (aliyunCfg?.access_key_id || process.env.ALIBABA_CLOUD_ACCESS_KEY_ID) &&
    (aliyunCfg?.access_key_secret || process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) &&
    (aliyunCfg?.appkey || process.env.ALIBABA_CLOUD_APPKEY);
  if (hasAliyunAK) {
    providers.push("aliyun-nls");
  }

  // 2. llm-whisper: OpenAI 官方 API 白名单（零配置，LLM key 自动复用）
  const llmBaseUrl = (process.env.LLM_BASE_URL || "").toLowerCase();
  const llmApiKey = process.env.LLM_API_KEY || "";
  if (llmApiKey && llmBaseUrl.includes("api.openai.com")) {
    providers.push("llm-whisper");
  }

  // 3. groq: 免费层 Whisper API（只需去 groq.com 拿 key）
  if (process.env.GROQ_API_KEY) {
    providers.push("groq");
  }

  return providers;
}

// ─── Whisper-compatible STT ──────────────────────────────────
// STT_API_URL 独立设置优先；LLM_BASE_URL 可能含 /v1 后缀（如 Kimi），需归一化
const rawSTTUrl = process.env.STT_API_URL || process.env.LLM_BASE_URL || "https://api.openai.com";
// 归一化：去尾部 /v1 和 /，统一拼接 /v1/audio/transcriptions
const STT_API_URL = rawSTTUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
// STT_API_KEY 独立设置优先；LLM_API_KEY 作为 fallback（OpenAI 用户零配置）
const STT_API_KEY = process.env.STT_API_KEY || process.env.LLM_API_KEY || "";
const STT_MODEL = process.env.STT_MODEL || "whisper-1";

// ─── WhisperTranscribe 配置参数 ───────────────────────────────────
interface WhisperConfig {
  /** API 基础 URL（不含 /v1 后缀），如 https://api.openai.com */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 模型名，如 whisper-1 / whisper-large-v3-turbo */
  model: string;
}

async function whisperTranscribe(
  audioBuffer: Buffer,
  language: string = "zh",
  format: string = "webm",
  config?: WhisperConfig,
): Promise<{ text: string }> {
  // 允许调用方注入配置（用于 Groq 复用），未传则用模块级默认值
  const baseUrl = (config?.baseUrl || STT_API_URL).replace(/\/$/, "");
  const apiKey = config?.apiKey || STT_API_KEY;
  const model = config?.model || STT_MODEL;

  // Build multipart/form-data manually
  const boundary = "----SuperAgentAudio" + Date.now();
  const filename = `audio.${format}`;
  const MIME_MAP: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    webm: "audio/webm",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    silk: "audio/silk",
    amr: "audio/amr",
    aac: "audio/aac",
    flac: "audio/flac",
  };
  const mimeType = MIME_MAP[format] ?? "audio/webm";

  const parts: Buffer[] = [];
  // file field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from("\r\n"));
  // model field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`
  ));
  // language field
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`
  ));
  // response_format
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`
  ));
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);
  const url = `${baseUrl}/v1/audio/transcriptions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "Unknown error");
    throw new Error(`STT API returned ${resp.status}: ${err}`);
  }

  const result = await resp.json() as any;
  return { text: result.text || "" };
}

// ─── 按优先级依次尝试转写 ───────────────────────────────────
async function transcribeWithFallback(
  audioBuffer: Buffer,
  language: string,
  format: string,
  providers: SttProvider[],
  ctx: AppContext,
  log: (level: "info" | "warn" | "error", msg: string, extra?: any) => void,
): Promise<{ text: string }> {
  for (const provider of providers) {
    try {
      let result: { text: string } | null = null;

      switch (provider) {
        case "stt-custom":
          // 用户显式配的 STT 服务（STT_API_URL + STT_API_KEY）
          result = await whisperTranscribe(audioBuffer, language, format, {
            baseUrl: STT_API_URL,
            apiKey: process.env.STT_API_KEY || "",
            model: STT_MODEL,
          });
          log("info", `STT via stt-custom OK (${result.text.length} chars)`);
          break;

        case "aliyun-nls":
          // 阿里云 NLS（企业级语音识别）
          if (ctx.voiceProvider) {
            result = await ctx.voiceProvider.transcribe(audioBuffer, { language, format });
            if (result && result.text) {
              log("info", `STT via Aliyun NLS OK (${result.text.length} chars)`);
            }
          } else {
            log("warn", "aliyun-nls in provider chain but voiceProvider is undefined (credentials incomplete?)");
          }
          break;

        case "llm-whisper":
          // OpenAI 官方 Whisper API（零配置，复用 LLM key）
          result = await whisperTranscribe(audioBuffer, language, format, {
            baseUrl: STT_API_URL,
            apiKey: STT_API_KEY,
            model: STT_MODEL,
          });
          log("info", `STT via llm-whisper OK (${result.text.length} chars)`);
          break;

        case "groq":
          // Groq Whisper API（免费层，兼容 OpenAI 格式）
          // baseUrl 不含 /v1，函数内部自动拼接 /v1/audio/transcriptions
          result = await whisperTranscribe(audioBuffer, language, format, {
            baseUrl: "https://api.groq.com/openai",
            apiKey: process.env.GROQ_API_KEY || "",
            model: process.env.STT_GROQ_MODEL || "whisper-large-v3-turbo",
          });
          log("info", `STT via groq OK (${result.text.length} chars)`);
          break;
      }

      if (result && result.text) return result;
    } catch (err: any) {
      log("warn", `STT provider "${provider}" failed, trying next`, { err: err.message });
      // 继续尝试下一个 provider
    }
  }

  throw new Error("所有语音识别服务均不可用");
}

// ─── Whisper 幻觉过滤器 ─────────────────────────────────────
// 静音/近静音录音被 Whisper 错误转写为 "谢谢观看" 等垃圾文本时直接丢弃。
// 词表移植自 Hermes voice_mode.py WHISPER_HALLUCINATIONS (行 735-763)，
// 并补充中文常见幻觉短语。

const WHISPER_HALLUCINATIONS = new Set([
  // 英文幻觉
  "thank you.", "thank you", "thanks for watching.", "thanks for watching",
  "subscribe to my channel.", "subscribe to my channel",
  "like and subscribe.", "like and subscribe",
  "please subscribe.", "please subscribe",
  "thank you for watching.", "thank you for watching",
  "bye.", "bye", "you", "the end.", "the end",
  // 非英幻觉（Hermes 原词表）
  "продолжение следует", "продолжение следует...",
  "sous-titres", "sous-titres réalisés par la communauté d'amara.org",
  "sottotitoli creati dalla comunità amara.org",
  "untertitel von stephanie geiges",
  "amara.org", "www.mooji.org",
  "ご視聴ありがとうございました",
  // 中文幻觉（Hermes 原词表缺失的，补充）
  "谢谢观看", "感谢观看", "再见", "字幕由", "请订阅",
  "谢谢大家的观看", "感谢大家的收看",
]);

// 重复模式正则：纯标点/单字循环（如 "你 你 你 你"）
const HALLUCINATION_REPEAT_RE = /^(?:thank you|thanks|bye|you|ok|okay|the end|再见|谢谢|你|好|嗯|哦|\.|\s|,|!)+$/i;

/**
 * 检查转写结果是否为 Whisper 静音幻觉。
 *
 * @param transcript - 转写文本
 * @param rmsPeak    - 录音 RMS 峰值（可选，来自前端 Task 1 的 AudioContext 分析）。
 *                     如果峰值 > 阈值说明确实有人说话，跳过过滤避免误杀。
 * @returns true 如果是幻觉，false 如果是正常转写
 */
function isWhisperHallucination(transcript: string, rmsPeak?: number): boolean {
  // Context guard：如果用户确实在说话（RMS 峰值 > 阈值），跳过过滤
  // RMS 阈值：Web Audio getByteTimeDomainData 基于 sample-128 计算，RMS=8 为初始阈值
  if (rmsPeak !== undefined && rmsPeak > 8) {
    return false;
  }

  const cleaned = transcript.trim().toLowerCase();
  if (!cleaned) return true;

  // 精确匹配已知幻觉短语
  if (WHISPER_HALLUCINATIONS.has(cleaned) || WHISPER_HALLUCINATIONS.has(cleaned.replace(/[.!]+$/, ""))) {
    return true;
  }

  // 重复模式检测（如 "Thank you. Thank you. you you you"）
  if (HALLUCINATION_REPEAT_RE.test(cleaned)) {
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// Voice Routes
// ═══════════════════════════════════════════════════════════════

export async function voiceRoutes(app: FastifyInstance, ctx: AppContext) {

  // ─── 启动时检测可用 provider 并写入 context ──────────────
  // 传入 configStore 以检查 UI 设置页持久化的凭据（弥补纯 env 检测的盲区）
  const providers = detectAvailableProviders(ctx.configStore);
  ctx.availableSTTProviders = providers;
  app.log.info({ providers }, "STT providers detected");

  // ===== Speech-to-Text: 多 Provider 自动降级 =====
  app.post("/api/voice/transcribe", async (request, reply) => {
    try {
      const body = request.body as any;
      let audioBuffer: Buffer;

      if (Buffer.isBuffer(body)) {
        audioBuffer = body;
      } else if (typeof body === "object" && body.audio) {
        // Base64 encoded audio
        audioBuffer = Buffer.from(body.audio, "base64");
      } else {
        return reply.status(400).send({ error: "Audio data required (raw body or base64 'audio' field)" });
      }

      const language = (typeof body === "object" && body.language) || "zh";
      const format = (typeof body === "object" && body.format) || "webm";
      // RMS 峰值（可选，前端 Task 1/3 的 AudioContext 提供，用于幻觉过滤的 context guard）
      const rmsPeak: number | undefined = (typeof body === "object" && typeof body.rmsPeak === "number")
        ? body.rmsPeak : undefined;

      // 无可用 provider → 503
      if (providers.length === 0) {
        return reply.status(503).send({
          error: "语音识别未配置",
          detail: "请前往设置页面配置语音识别服务。",
          hint: "零配置方案：使用 OpenAI API Key 即可直接用语音输入。免费方案：去 groq.com 获取免费 API Key 并设置 GROQ_API_KEY 环境变量。",
          providers: [],
        });
      }

      // 多 Provider 自动降级尝试
      const result = await transcribeWithFallback(
        audioBuffer, language, format, providers, ctx,
        (level, msg, extra) => {
          if (level === "info") app.log.info(extra || {}, msg);
          else if (level === "warn") app.log.warn(extra || {}, msg);
          else app.log.error(extra || {}, msg);
        },
      );

      // ─── Whisper 幻觉过滤（所有 provider 返回后统一执行）───
      // 阿里云 NLS 不会产生 Whisper 特有幻觉，但过滤无害；Groq/llm-whisper 是 Whisper 模型，需要过滤
      if (isWhisperHallucination(result.text, rmsPeak)) {
        app.log.info({ original: result.text, rmsPeak }, "Whisper hallucination filtered — silent recording");
        return { text: "", filtered: true };
      }

      return result;
    } catch (err: any) {
      app.log.error({ err }, "Voice transcription failed");
      // API-P1-03：内部栈仅进日志
      return reply.status(500).send({
        error: "Voice transcription failed",
        detail: err.message || "所有语音识别服务均不可用",
        hint: "请检查 STT_API_URL、ALIBABA_CLOUD_*、GROQ_API_KEY 等环境变量配置。",
      });
    }
  });

  // 启动日志：多 Provider 状态
  if (providers.length === 0) {
    app.log.warn("STT: no providers available — voice input disabled");
  } else {
    app.log.info({ providers, count: providers.length }, "STT: multi-provider fallback chain ready");
  }

  // ===== STT Providers 列表（始终注册，前端据此决定语音按钮状态）=====
  app.get("/api/voice/providers", async () => {
    return { providers };
  });

  // ===== Text-to-Speech（仅阿里云 NLS，需 voiceProvider）=====
  if (!ctx.voiceProvider) {
    app.log.info("TTS not available (Aliyun NLS not configured)");
    app.log.info("Voice routes registered (STT only)");
    return;
  }

  const voice = ctx.voiceProvider;

  /** Text-to-Speech: synthesize audio from text */
  app.post<{
    Body: { text: string; voice?: string; speed?: number; volume?: number; format?: string };
  }>("/api/voice/synthesize", async (request, reply) => {
    const { text, voice: voiceName, speed, volume, format } = request.body ?? {};
    if (!text) {
      return reply.status(400).send({ error: "text is required" });
    }

    try {
      const audioBuffer = await voice.synthesize(text, {
        voice: voiceName,
        speed,
        volume,
        format: format ?? "mp3",
      });

      const contentType = format === "wav" ? "audio/wav" : "audio/mpeg";
      reply.header("Content-Type", contentType);
      reply.header("Content-Length", audioBuffer.length);
      return reply.send(audioBuffer);
    } catch (err: any) {
      app.log.error({ err }, "Voice synthesis failed");
      // API-P1-03：内部栈仅进日志
      return reply.status(500).send({ error: "Voice synthesis failed" });
    }
  });

  app.log.info("Voice routes registered (STT + TTS)");
}
