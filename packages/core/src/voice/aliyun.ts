/**
 * Aliyun Voice Provider — ASR (Speech-to-Text) and TTS (Text-to-Speech)
 * via Alibaba Cloud Intelligent Speech Interaction REST API.
 *
 * Configuration via environment variables:
 * - ALIBABA_CLOUD_ACCESS_KEY_ID
 * - ALIBABA_CLOUD_ACCESS_KEY_SECRET
 * - ALIBABA_CLOUD_APPKEY
 */

import { createHmac } from "node:crypto";
import pino from "pino";
import type { VoiceProvider, STTOptions, TTSOptions, STTResult } from "./provider.js";

const logger = pino({ name: "aliyun-voice" });

export interface AliyunVoiceConfig {
  accessKeyId: string;
  accessKeySecret: string;
  appKey: string;
  region?: string; // Default: "cn-shanghai"
}

export class AliyunVoiceProvider implements VoiceProvider {
  readonly name = "aliyun";
  private config: AliyunVoiceConfig;

  constructor(config?: Partial<AliyunVoiceConfig>) {
    this.config = {
      accessKeyId: config?.accessKeyId ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? "",
      accessKeySecret: config?.accessKeySecret ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? "",
      appKey: config?.appKey ?? process.env.ALIBABA_CLOUD_APPKEY ?? "",
      region: config?.region ?? "cn-shanghai",
    };
  }

  isAvailable(): boolean {
    return !!(this.config.accessKeyId && this.config.accessKeySecret && this.config.appKey);
  }

  /**
   * Speech-to-Text: Transcribe audio buffer using Aliyun One-Sentence Recognition REST API.
   *
   * API: POST https://nls-gateway-{region}.aliyuncs.com/stream/v1/asr
   */
  async transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult> {
    if (!this.isAvailable()) {
      throw new Error("Aliyun voice not configured. Set ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET, ALIBABA_CLOUD_APPKEY");
    }

    const format = options?.format ?? "wav";
    const sampleRate = options?.sampleRate ?? 16000;
    const language = options?.language ?? "zh-CN";

    const url = `https://nls-gateway-${this.config.region}.aliyuncs.com/stream/v1/asr`;
    const params = new URLSearchParams({
      appkey: this.config.appKey,
      format,
      sample_rate: String(sampleRate),
    });

    try {
      const token = await this.getToken();
      const response = await fetch(`${url}?${params}`, {
        method: "POST",
        headers: {
          "X-NLS-Token": token,
          "Content-Type": `audio/${format}; samplerate=${sampleRate}`,
          "Content-Length": String(audio.length),
        },
        body: audio,
      });

      const result = await response.json() as {
        status: number;
        result: string;
        message?: string;
      };

      if (result.status !== 20000000) {
        throw new Error(`ASR error: ${result.message ?? result.status}`);
      }

      return {
        text: result.result,
        language,
      };
    } catch (err: any) {
      logger.error({ error: err.message }, "ASR transcription failed");
      throw err;
    }
  }

  /**
   * Text-to-Speech: Synthesize text using Aliyun TTS REST API.
   *
   * API: POST https://nls-gateway-{region}.aliyuncs.com/stream/v1/tts
   */
  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    if (!this.isAvailable()) {
      throw new Error("Aliyun voice not configured");
    }

    const voice = options?.voice ?? "xiaoyun";
    const format = options?.format ?? "mp3";
    const speed = options?.speed ?? 0;
    const volume = options?.volume ?? 50;

    const url = `https://nls-gateway-${this.config.region}.aliyuncs.com/stream/v1/tts`;

    try {
      const token = await this.getToken();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "X-NLS-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appkey: this.config.appKey,
          text,
          format,
          voice,
          sample_rate: 16000,
          volume,
          speech_rate: speed,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`TTS error: ${response.status} ${errText}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("audio")) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      // If JSON response, it's an error
      const result = await response.json() as { message?: string };
      throw new Error(`TTS error: ${result.message ?? "Unknown error"}`);
    } catch (err: any) {
      logger.error({ error: err.message }, "TTS synthesis failed");
      throw err;
    }
  }

  /**
   * Get an NLS token using AccessKey authentication.
   * In production, this should be cached and refreshed periodically.
   */
  private async getToken(): Promise<string> {
    const url = "https://nls-meta.cn-shanghai.aliyuncs.com/";
    const params: Record<string, string> = {
      Action: "CreateToken",
      Version: "2019-02-28",
      Format: "JSON",
      AccessKeyId: this.config.accessKeyId,
      SignatureMethod: "HMAC-SHA1",
      SignatureVersion: "1.0",
      SignatureNonce: String(Math.random()),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };

    // Create signature
    const sorted = Object.keys(params).sort();
    const canonicalized = sorted.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
    const stringToSign = `GET&${encodeURIComponent("/")}&${encodeURIComponent(canonicalized)}`;
    const signature = createHmac("sha1", this.config.accessKeySecret + "&")
      .update(stringToSign)
      .digest("base64");

    params.Signature = signature;
    const queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

    try {
      const response = await fetch(`${url}?${queryString}`);
      const data = await response.json() as { Token?: { Id: string } };
      if (!data.Token?.Id) {
        throw new Error("Failed to get NLS token");
      }
      return data.Token.Id;
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to get Aliyun NLS token");
      throw err;
    }
  }
}
