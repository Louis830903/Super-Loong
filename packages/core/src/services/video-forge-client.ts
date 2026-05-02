/**
 * Video-Forge HTTP Client — 统一封装 video-forge 微服务的所有 HTTP 调用。
 *
 * 功能（对齐 Spec v1.4 §4.1 接口表）：
 * - 所有同步接口：超时 90s + 1 次自动重试（仅对可重试错误）
 * - /forge/video 异步 Job：提交 + 轮询
 * - 结构化错误返回（code/message/retryable），供 Agent 侧 fallback 使用
 * - SSRF 防护：强制只连 localhost:8199，不接受重定向
 */

import pino from "pino";

const logger = pino({ name: "video-forge-client" });

// ── 配置常量 ──────────────────────────────────────

/** 微服务基础 URL（可通过环境变量覆盖） */
const BASE_URL =
  process.env.VIDEO_FORGE_URL || "http://127.0.0.1:8199";

/** 同步接口默认超时（毫秒）— 通用值，适合 TTS/合成等秒级接口 */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * 图片生成专用超时（毫秒）。
 * RunningHub 真实出图通常 60-180s，极端 case 可达 240s，
 * 故在客户端保留充足余量（默认 5 分钟，可通过 VIDEO_FORGE_IMAGE_TIMEOUT_MS 覆盖）。
 */
const IMAGE_TIMEOUT_MS = Number(
  process.env.VIDEO_FORGE_IMAGE_TIMEOUT_MS || 300_000,
);

/** 最大重试次数 */
const MAX_RETRIES = 1;

// ── 错误类型 ──────────────────────────────────────

export interface VideoForgeError {
  code: string;
  message: string;
  retryable: boolean;
}

export class VideoForgeRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(code: string, message: string, retryable: boolean, statusCode?: number) {
    super(message);
    this.name = "VideoForgeRequestError";
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

// ── 响应类型 ──────────────────────────────────────

export interface ForgeImageResult {
  url?: string;
  local_path?: string;
  meta?: Record<string, unknown>;
}

export interface ForgeVideoSubmitResult {
  job_id: string;
  status: "queued";
}

export interface ForgeVideoJobStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  progress?: number;
  output?: {
    local_path?: string;
    url?: string;
  };
  error?: string;
}

export interface ForgeTtsResult {
  /**
   * TTS 音频本地路径。
   * 注意：服务端 /forge/tts 返回字段名为 `audio_path`（非 `local_path`），
   * 与 /forge/image 的 local_path 语义一致但命名差异历史原因保留。
   * 详见 services/video-forge/app/api/media.py forge_tts 路由。
   */
  audio_path: string;
  duration?: number;
}

export interface ForgeComposeResult {
  video_segment_path: string;
  duration?: number;
}

export interface ForgeConcatResult {
  output_path: string;
}

export interface ForgeBgmResult {
  output_path: string;
}

export interface ForgeAnalyseResult {
  description: string;
}

// ── 核心请求方法 ──────────────────────────────────

/**
 * 发送 HTTP 请求到 video-forge，带超时和重试。
 * 仅对网络错误和 502/503/504 重试。
 */
async function forgeRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error", // SSRF 防护：禁止重定向
      });

      if (resp.ok) {
        return (await resp.json()) as T;
      }

      // 4xx/5xx 错误
      const errBody = await resp.text().catch(() => "");
      let parsed: { detail?: string; code?: string } = {};
      try {
        parsed = JSON.parse(errBody);
      } catch {
        // 非 JSON 响应
      }

      const errCode = parsed.code || `HTTP_${resp.status}`;
      const errMsg = parsed.detail || errBody || `HTTP ${resp.status}`;
      const retryable = resp.status >= 500 && resp.status !== 501;

      // 5xx 可重试时继续
      if (retryable && attempt < MAX_RETRIES) {
        logger.warn(
          { path, status: resp.status, attempt },
          "video-forge 请求失败，准备重试",
        );
        await sleep(1000 * (attempt + 1));
        continue;
      }

      throw new VideoForgeRequestError(errCode, errMsg, retryable, resp.status);
    } catch (err) {
      if (err instanceof VideoForgeRequestError) {
        throw err;
      }

      // 网络错误 / 超时
      lastError = err as Error;
      const isTimeout = (err as Error).name === "TimeoutError" ||
        (err as Error).message?.includes("abort");

      if (attempt < MAX_RETRIES) {
        logger.warn(
          { path, attempt, error: (err as Error).message },
          "video-forge 网络错误，准备重试",
        );
        await sleep(1000 * (attempt + 1));
        continue;
      }

      throw new VideoForgeRequestError(
        isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
        `video-forge 请求失败: ${(err as Error).message}`,
        true,
      );
    }
  }

  // 理论上不会到达这里，但作为安全兜底
  throw lastError || new Error("unknown error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 公开 API ──────────────────────────────────────

/**
 * 图片生成（同步）
 * POST /forge/image
 *
 * 使用专用超时（IMAGE_TIMEOUT_MS，默认 5 分钟），避免 RunningHub 真实出图 2-3 分钟
 * 时客户端先 abort 导致算力浪费 + agent 误判失败。
 */
export async function forgeImage(params: {
  prompt: string;
  workflow?: string;
  width?: number;
  height?: number;
}): Promise<ForgeImageResult> {
  return forgeRequest<ForgeImageResult>(
    "POST",
    "/forge/image",
    params,
    IMAGE_TIMEOUT_MS,
  );
}

/**
 * 视频生成 — 提交异步任务
 * POST /forge/video
 */
export async function forgeVideoSubmit(params: {
  prompt: string;
  workflow?: string;
  duration?: number;
  ref_image?: string;
}): Promise<ForgeVideoSubmitResult> {
  return forgeRequest<ForgeVideoSubmitResult>("POST", "/forge/video", params);
}

/**
 * 视频生成 — 查询 Job 状态
 * GET /forge/video/jobs/:id
 */
export async function forgeVideoStatus(
  jobId: string,
): Promise<ForgeVideoJobStatus> {
  return forgeRequest<ForgeVideoJobStatus>(
    "GET",
    `/forge/video/jobs/${encodeURIComponent(jobId)}`,
  );
}

/**
 * TTS 语音合成（同步）
 * POST /forge/tts
 */
export async function forgeTts(params: {
  text: string;
  workflow?: string;
  voice?: string;
  speed?: number;
}): Promise<ForgeTtsResult> {
  return forgeRequest<ForgeTtsResult>("POST", "/forge/tts", params);
}

/**
 * 帧合成（同步）
 * POST /forge/compose-frame
 */
export async function forgeComposeFrame(params: {
  image_path: string;
  audio_path: string;
  subtitle?: string;
  template?: string;
}): Promise<ForgeComposeResult> {
  return forgeRequest<ForgeComposeResult>(
    "POST",
    "/forge/compose-frame",
    params,
  );
}

/**
 * 视频拼接（同步）
 * POST /forge/concat
 */
export async function forgeConcat(params: {
  segments: string[];
  output?: string;
}): Promise<ForgeConcatResult> {
  return forgeRequest<ForgeConcatResult>("POST", "/forge/concat", params);
}

/**
 * 添加背景音乐（同步）
 * POST /forge/add-bgm
 */
export async function forgeAddBgm(params: {
  video_path: string;
  bgm_path: string;
  volume?: number;
}): Promise<ForgeBgmResult> {
  return forgeRequest<ForgeBgmResult>("POST", "/forge/add-bgm", params);
}

/**
 * 图片分析（同步）
 * POST /forge/analyse-image
 */
export async function forgeAnalyseImage(params: {
  image_path: string;
  workflow?: string;
}): Promise<ForgeAnalyseResult> {
  return forgeRequest<ForgeAnalyseResult>(
    "POST",
    "/forge/analyse-image",
    params,
  );
}

/**
 * 健康检查
 * GET /health
 */
export async function forgeHealthCheck(): Promise<{
  status: string;
  comfykit_ready: boolean;
}> {
  return forgeRequest("GET", "/health", undefined, 5000);
}

// ── 成本估算（Spec §4.5 闸门 1）──────────────────

/**
 * 默认工作流单价表（CNY / 每次生成）
 * 与 services/video-forge/config.yaml 的 pricing 段保持同步
 */
const DEFAULT_PRICING: Record<string, number> = {
  "runninghub/video_wan2.1_fusionx.json": 1.5,
  "runninghub/video_wan2.2.json": 1.8,
  "runninghub/video_qwen_wan2.2.json": 2.0,
  "runninghub/video_Z_image_wan2.2.json": 2.0,
  "runninghub/i2v_LTX2.json": 1.2,
  "runninghub/image_flux.json": 0.3,
  "runninghub/image_sdxl.json": 0.2,
  "_default": 1.0,
};

export interface CostEstimate {
  /** 预估总成本 (CNY) */
  estimate_cny: number;
  /** 单次工作流单价 */
  unit_price: number;
  /** 场景数 */
  scenes: number;
  /** 使用的工作流 */
  workflow: string;
}

/**
 * 估算 VideoJob 成本（闸门 1 前置检查）
 *
 * 公式：cost_estimate = scenes × workflow_unit_price
 * 用于在 POST /api/video/jobs 入口检查是否超预算
 *
 * @param workflow 工作流标识（如 runninghub/video_wan2.1_fusionx.json）
 * @param scenes 场景数（默认 6，对应 Spec 附录 A3）
 * @param pricingOverride 可选单价覆盖（从 config.yaml 加载）
 */
export function estimateCost(
  workflow: string,
  scenes = 6,
  pricingOverride?: Record<string, number>,
): CostEstimate {
  const pricing = pricingOverride ?? DEFAULT_PRICING;
  const defaultPrice = pricing["_default"] ?? 1.0;
  const unitPrice = pricing[workflow] ?? defaultPrice;
  return {
    estimate_cny: scenes * unitPrice,
    unit_price: unitPrice,
    scenes,
    workflow,
  };
}
