/**
 * Voice Routes — TTS/STT API endpoints.
 *
 * POST /api/voice/transcribe  — Speech to text (upload audio)
 * POST /api/voice/synthesize  — Text to speech (returns audio)
 * GET  /api/voice/providers   — List available voice providers
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

// ─── Whisper-compatible STT (always available) ────────────────────
const STT_API_URL = process.env.STT_API_URL || process.env.LLM_BASE_URL || "https://api.openai.com";
const STT_API_KEY = process.env.STT_API_KEY || process.env.LLM_API_KEY || "";
const STT_MODEL = process.env.STT_MODEL || "whisper-1";

async function whisperTranscribe(
  audioBuffer: Buffer,
  language: string = "zh",
  format: string = "webm",
): Promise<{ text: string }> {
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
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${STT_MODEL}\r\n`
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
  const baseUrl = STT_API_URL.replace(/\/$/, "");
  const url = `${baseUrl}/v1/audio/transcriptions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STT_API_KEY}`,
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

export async function voiceRoutes(app: FastifyInstance, ctx: AppContext) {
  // ===== Whisper-compatible transcribe (always available) =====
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

      // 两级降级策略：阿里云 NLS 优先 → Whisper API 兜底
      // 两者可同时配置不冲突，用户只配一个也能用

      // 第一优先级：阿里云 NLS（如果已配置）
      if (ctx.voiceProvider) {
        try {
          const result = await ctx.voiceProvider.transcribe(audioBuffer, { language, format });
          if (result && result.text) {
            app.log.info("STT via Aliyun NLS OK (%d chars)", result.text.length);
            return result;
          }
        } catch (aliyunErr: any) {
          app.log.warn({ err: aliyunErr }, "Aliyun NLS transcription failed, trying Whisper fallback");
        }
      }

      // 第二优先级：Whisper 兼容 API（如果有 STT_API_KEY）
      if (STT_API_KEY) {
        const result = await whisperTranscribe(audioBuffer, language, format);
        if (result && result.text) {
          app.log.info("STT via Whisper API OK (%d chars)", result.text.length);
        }
        return result;
      }

      // 两个都没配 → 503
      return reply.status(503).send({
        error: "语音识别未配置",
        message: "请在系统设置中配置阿里云语音（AccessKey + AppKey），或设置 STT_API_KEY 环境变量使用 Whisper API",
      });
    } catch (err: any) {
      app.log.error({ err }, "Voice transcription failed");
      return reply.status(500).send({ error: err.message });
    }
  });

  // 启动日志：显示 STT 两级降级状态
  const hasAliyun = !!ctx.voiceProvider;
  const hasWhisper = !!STT_API_KEY;
  if (hasAliyun && hasWhisper) {
    app.log.info({ sttUrl: STT_API_URL, model: STT_MODEL }, "STT: Aliyun NLS (primary) + Whisper API (fallback)");
  } else if (hasAliyun) {
    app.log.info("STT: Aliyun NLS only (no Whisper fallback)");
  } else if (hasWhisper) {
    app.log.info({ sttUrl: STT_API_URL, model: STT_MODEL }, "STT: Whisper API only (no Aliyun)");
  } else {
    app.log.warn("STT: not configured — set Aliyun credentials or STT_API_KEY");
  }

  if (!ctx.voiceProvider) {
    if (STT_API_KEY) {
      app.log.info({ sttUrl: STT_API_URL, model: STT_MODEL }, "Voice transcribe enabled via Whisper API");
    } else {
      app.log.warn("Voice provider not available and no STT_API_KEY set, transcribe will return 503");
    }
    // Still register providers endpoint
    app.get("/api/voice/providers", async () => {
      return { providers: [{ name: "whisper", available: !!STT_API_KEY, status: STT_API_KEY ? "configured" : "not_configured" }] };
    });
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
      return reply.status(500).send({ error: err.message });
    }
  });

  /** List available voice providers */
  app.get("/api/voice/providers", async () => {
    return {
      providers: [
        {
          name: voice.name,
          available: voice.isAvailable(),
          status: voice.isAvailable() ? "configured" : "not_configured",
        },
      ],
    };
  });

  app.log.info("Voice routes registered");
}
