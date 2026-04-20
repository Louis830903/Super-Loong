/**
 * Voice Provider Interface — abstract interface for TTS/STT providers.
 */

export interface STTOptions {
  language?: string;     // Default: "zh-CN"
  format?: string;       // "pcm" | "wav" | "mp3" | "ogg"
  sampleRate?: number;   // Default: 16000
}

export interface TTSOptions {
  voice?: string;        // Voice name/ID
  speed?: number;        // Speed adjustment (-500~500)
  volume?: number;       // Volume (0~100)
  format?: string;       // Output format: "mp3" | "wav" | "pcm"
}

export interface STTResult {
  text: string;
  confidence?: number;
  language?: string;
  duration?: number;
}

export interface VoiceProvider {
  readonly name: string;

  /** Speech to Text — transcribe audio buffer to text */
  transcribe(audio: Buffer, options?: STTOptions): Promise<STTResult>;

  /** Text to Speech — synthesize text to audio buffer */
  synthesize(text: string, options?: TTSOptions): Promise<Buffer>;

  /** Check if the provider is configured and available */
  isAvailable(): boolean;
}

export interface VoiceConfig {
  provider: "aliyun" | "iflytek" | "none";
  aliyun?: {
    accessKeyId: string;
    accessKeySecret: string;
    appKey: string;
    region?: string;
  };
  iflytek?: {
    appId: string;
    apiKey: string;
    apiSecret: string;
  };
}
