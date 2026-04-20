/**
 * Vision Tools — vision_analyze / ocr_extract / vision_config × 3（延迟加载）。
 *
 * 使用 OpenAI 兼容 API 调用多模态 LLM（GPT-4o / Qwen-VL / Doubao-Vision 等）。
 * 完整图片处理管道（对标 Hermes vision_tools.py）：
 *   输入(URL/路径) → ①SSRF检查 → ②流式下载(50MB限) → ③MIME头检测
 *   → ④自适应缩放(sharp) → ⑤base64编码(20MB限) → ⑥API调用
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { getConfigStore, maskSecret } from "./config-store.js";
import { isSafeUrl, detectMimeFromHeader, isBlockedDevicePath } from "./shared-security.js";

const logger = pino({ name: "vision" });

// ── 常量 ──────────────────────────────────────

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;  // 50MB 下载上限
const RESIZE_TARGET = 5 * 1024 * 1024;         // 5MB base64 目标
const RESIZE_HARD_LIMIT = 20 * 1024 * 1024;    // 20MB base64 硬限
const DOWNLOAD_TIMEOUT = 15_000;               // 15s 下载超时

// ── 配置读取（ConfigStore → 环境变量 → 空） ──

interface VisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function getVisionConfig(): VisionConfig {
  const store = getConfigStore();
  return {
    apiKey: store.get("vision", "api_key") || process.env.VISION_API_KEY || "",
    baseUrl: store.get("vision", "base_url") || process.env.VISION_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
    model: store.get("vision", "model") || process.env.VISION_MODEL || "",
  };
}

function notConfiguredResult(): ToolResult {
  return {
    success: false,
    output:
      "vision_analyze 工具未配置独立视觉 API。\n\n" +
      "⚠️ 重要提示：如果用户刚刚发送了图片，图片已经嵌入在对话消息中，" +
      "你可以直接看到并分析，无需使用此工具。\n\n" +
      "vision_analyze 仅用于分析 URL 链接或本地文件路径指向的图片。" +
      "如需配置（通常不需要），请用户提供：\n" +
      "1. API Key\n2. Base URL\n3. Model ID",
    error: "not_configured",
  };
}

// ── 图片处理管道 ──────────────────────────────

/** MIME 扩展名映射（当 magic byte 检测失败时回退） */
const MIME_EXT_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

/**
 * Step 1+2: 安全下载图片（SSRF 防护 + 重定向检查 + 大小限制）。
 * 对标 Hermes _ssrf_redirect_guard + _download_image。
 */
async function safeImageFetch(url: string): Promise<Buffer> {
  // 1. 初始 URL SSRF 检查
  if (!isSafeUrl(url)) {
    throw new Error(`SSRF blocked: 目标地址不安全 — ${url}`);
  }

  // 2. 发起请求（follow redirect）
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    });

    // 3. 检查重定向后的最终 URL（对标 Hermes redirect guard）
    const finalUrl = res.url;
    if (finalUrl !== url && !isSafeUrl(finalUrl)) {
      throw new Error(`SSRF blocked: 重定向至不安全地址 — ${finalUrl}`);
    }

    if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);

    // 4. Content-Length 预检
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`图片过大 (${(contentLength / 1024 / 1024).toFixed(1)}MB)，上限 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB`);
    }

    // 5. 下载 + 实际大小校验
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`图片实际大小 ${(buffer.length / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 限制`);
    }

    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Step 3: 检测图片 MIME 类型。
 * 优先使用 magic byte，回退到扩展名。
 */
function detectImageMime(buffer: Buffer, filePath?: string): string {
  // 优先 magic byte 检测
  const mime = detectMimeFromHeader(buffer);
  if (mime) return mime;
  // 回退到扩展名
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (MIME_EXT_MAP[ext]) return MIME_EXT_MAP[ext];
  }
  return "image/png"; // 默认
}

/**
 * Step 4+5: 自适应缩放 + base64 编码。
 * 对标 Hermes _resize_image_for_vision（5 轮递减缩放策略）。
 */
async function encodeForVision(buffer: Buffer, mime: string): Promise<string> {
  // 尝试使用 sharp 进行自适应缩放
  try {
    const sharpModName = "sharp";
    const sharpMod = await import(/* webpackIgnore: true */ sharpModName);
    const sharp = sharpMod.default || sharpMod;

    let currentBuffer = buffer;
    for (let attempt = 0; attempt < 5; attempt++) {
      const b64 = currentBuffer.toString("base64");
      if (b64.length <= RESIZE_TARGET) {
        return `data:${mime};base64,${b64}`;
      }

      // 获取当前尺寸
      const metadata = await sharp(currentBuffer).metadata();
      const w = metadata.width || 512;
      const h = metadata.height || 512;

      // 尺寸减半（最小 64px）
      const newW = Math.max(64, Math.floor(w / 2));
      const newH = Math.max(64, Math.floor(h / 2));

      logger.debug({ attempt, w, h, newW, newH }, "Vision: 缩放图片");

      // 缩放并转为 JPEG（质量递降）
      const quality = [85, 70, 50, 35, 25][attempt] || 25;
      currentBuffer = await sharp(currentBuffer)  // 使用上一轮缩放结果（而非原始 buffer）
        .resize(newW, newH, { fit: "inside" })
        .jpeg({ quality })
        .toBuffer();
      mime = "image/jpeg"; // 缩放后统一 JPEG
    }

    // 5 轮缩放后仍然过大
    const finalB64 = currentBuffer.toString("base64");
    if (finalB64.length <= RESIZE_HARD_LIMIT) {
      return `data:${mime};base64,${finalB64}`;
    }
    throw new Error("图片缩放后仍然过大");
  } catch (err: any) {
    // sharp 未安装或处理失败，直接编码
    if (err.message?.includes("图片缩放后仍然过大")) throw err;

    const b64 = buffer.toString("base64");
    if (b64.length > RESIZE_HARD_LIMIT) {
      throw new Error(`图片过大 (base64 ${(b64.length / 1024 / 1024).toFixed(1)}MB)，请安装 sharp 以启用自适应缩放: pnpm add sharp`);
    }
    return `data:${mime};base64,${b64}`;
  }
}

/**
 * 完整图片处理管道：输入 → SSRF检查 → 下载/读取 → MIME检测 → 缩放 → base64。
 */
async function processImage(image: string): Promise<string> {
  let buffer: Buffer;
  let filePath: string | undefined;

  if (image.startsWith("http://") || image.startsWith("https://")) {
    // URL: 安全下载
    buffer = await safeImageFetch(image);
  } else {
    // 本地路径：路径安全校验
    filePath = image;
    const ALLOWED_ROOTS = [path.resolve(process.cwd()), path.resolve(os.homedir()), path.resolve(os.tmpdir())];
    const resolved = path.resolve(filePath);
    if (!ALLOWED_ROOTS.some(r => resolved.startsWith(r + path.sep) || resolved === r)) {
      throw new Error(`路径 '${filePath}' 超出允许范围`);
    }
    const devErr = isBlockedDevicePath(filePath);
    if (devErr) throw new Error(devErr);
    if (!fs.existsSync(filePath)) {
      throw new Error(`图片文件不存在: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`图片文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    }
    buffer = fs.readFileSync(filePath);
  }

  const mime = detectImageMime(buffer, filePath);
  return encodeForVision(buffer, mime);
}

// ── API 调用 ─────────────────────────────────

/** 调用多模态 LLM（OpenAI 兼容格式） */
async function callVisionAPI(cfg: VisionConfig, imageDataUrl: string, prompt: string): Promise<string> {
  // 复用 openai SDK
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });

  const response = await openai.chat.completions.create({
    model: cfg.model,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: prompt },
      ],
    }],
    max_tokens: 4096,
  });

  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error("API 未返回有效响应");
  return text;
}

// ── 工具定义 ────────────────────────────────────

/** vision_analyze — 图片视觉分析 */
const visionAnalyzeTool: ToolDefinition = {
  name: "vision_analyze",
  description:
    "图片视觉分析：描述图片内容、回答关于图片的问题。" +
    "支持 URL 或本地文件路径。需要配置 VISION_API_KEY 和 VISION_MODEL。",
  parameters: z.object({
    image: z.string().describe("图片 URL 或本地文件路径"),
    prompt: z.string().default("请详细描述这张图片的内容。").describe("分析指令/问题"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { image, prompt } = params as { image: string; prompt: string };
    const cfg = getVisionConfig();
    if (!cfg.apiKey || !cfg.model) return notConfiguredResult();

    try {
      const dataUrl = await processImage(image);
      const analysis = await callVisionAPI(cfg, dataUrl, prompt);

      return {
        success: true,
        output: `📷 视觉分析结果：\n\n${analysis}`,
        data: { imageSource: image.startsWith("http") ? "url" : "local", promptUsed: prompt },
      };
    } catch (err: any) {
      return { success: false, output: `视觉分析失败: ${err.message}`, error: err.message };
    }
  },
};

/** ocr_extract — OCR 文字识别 */
const ocrExtractTool: ToolDefinition = {
  name: "ocr_extract",
  description:
    "光学字符识别（OCR）：提取图片中的文字内容。" +
    "支持中英文混合识别。需要配置 VISION_API_KEY 和 VISION_MODEL。",
  parameters: z.object({
    image: z.string().describe("图片 URL 或本地文件路径"),
    language: z.string().default("auto").describe("识别语言（auto=自动, zh=中文, en=英文）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { image, language } = params as { image: string; language: string };
    const cfg = getVisionConfig();
    if (!cfg.apiKey || !cfg.model) return notConfiguredResult();

    const langHint = language === "auto" ? "" : `（主要语言: ${language}）`;
    const ocrPrompt =
      `请仔细识别并提取图片中的所有文字内容${langHint}。` +
      "要求：1) 按原始布局排列文字 2) 保留段落结构 3) 表格用 | 分隔 4) 只输出识别到的文字，不要额外描述。";

    try {
      const dataUrl = await processImage(image);
      const text = await callVisionAPI(cfg, dataUrl, ocrPrompt);

      return {
        success: true,
        output: `📝 OCR 识别结果：\n\n${text}`,
        data: { imageSource: image.startsWith("http") ? "url" : "local", language, textLength: text.length },
      };
    } catch (err: any) {
      return { success: false, output: `OCR 识别失败: ${err.message}`, error: err.message };
    }
  },
};

/** vision_config — 查看视觉服务配置状态 */
const visionConfigTool: ToolDefinition = {
  name: "vision_config",
  description: "查看视觉分析服务的配置状态和使用说明。",
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const cfg = getVisionConfig();
    const configured = !!(cfg.apiKey && cfg.model);
    const statusIcon = configured ? "✅ 已配置" : "⚠️ 未配置";

    // 检测 sharp 可用性
    let sharpAvailable = false;
    try {
      const sharpModName = "sharp";
      await import(/* webpackIgnore: true */ sharpModName);
      sharpAvailable = true;
    } catch { /* sharp 未安装 */ }

    const lines = [
      `视觉分析服务状态：${statusIcon}`,
      "",
      configured
        ? [
            `API Key: ${maskSecret(cfg.apiKey)}`,
            `Model: ${cfg.model}`,
            `Base URL: ${cfg.baseUrl}`,
          ].join("\n")
        : "请提供 API Key、Model ID 和 Base URL 以启用视觉功能。",
      "",
      `图片处理能力：`,
      `  - 自适应缩放: ${sharpAvailable ? "✅ 已启用（sharp）" : "⚠️ 未启用（pnpm add sharp）"}`,
      `  - SSRF 防护: ✅`,
      `  - MIME 头检测: ✅`,
      `  - 最大下载: 50MB`,
      `  - base64 硬限: 20MB`,
      "",
      "支持的功能：",
      "  - vision_analyze: 图片内容分析与问答",
      "  - ocr_extract: 图片文字识别（OCR）",
    ];

    return {
      success: true,
      output: lines.join("\n"),
      data: { configured, model: cfg.model || null, sharpAvailable },
    };
  },
};

export const visionTools: ToolDefinition[] = [visionAnalyzeTool, ocrExtractTool, visionConfigTool];
