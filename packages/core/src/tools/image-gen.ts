/**
 * Image Generation Tools — 火山方舟 Seedream 图片生成 × 3
 * （image_generate / image_edit / image_config）。
 *
 * API 格式兼容 OpenAI Images API，支持同步/异步两种响应模式。
 * 配置优先级：ConfigStore → 环境变量 → 默认值。
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { getConfigStore, maskSecret } from "./config-store.js";

const logger = pino({ name: "image-gen" });

// ── 配置读取 ─────────────────────────────────────

interface ArkConfig {
  apiKey: string;
  endpointId: string;
  baseUrl: string;
}

function getArkConfig(): ArkConfig {
  const store = getConfigStore();
  return {
    apiKey: store.get("ark_seedream", "api_key") || process.env.ARK_API_KEY || "",
    endpointId: store.get("ark_seedream", "endpoint_id") || process.env.ARK_ENDPOINT_ID || "",
    baseUrl: store.get("ark_seedream", "base_url") || process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
  };
}

function notConfiguredResult(): ToolResult {
  return {
    success: false,
    output:
      "❌ 火山方舟 Seedream 未配置。请提供以下信息：\n\n" +
      "1. API Key — 在火山方舟控制台「API Key管理」中创建\n" +
      "2. Endpoint ID — 搜索 Seedream 模型 → 创建推理接入点 → 复制 ID\n\n" +
      "你可以直接告诉我这些信息，我会自动保存配置。\n" +
      "或访问 https://console.volcengine.com/ark/ 获取。",
    error: "not_configured",
  };
}

// ── API 请求封装 ──────────────────────────────────

interface ArkImageResult {
  url?: string;
  b64_json?: string;
}

/**
 * 调用火山方舟 Images API，兼容同步/异步响应。
 * 同步：直接返回 data[]
 * 异步：轮询 task_id 直到完成
 */
async function callArkImagesAPI(
  cfg: ArkConfig,
  body: Record<string, unknown>
): Promise<ArkImageResult[]> {
  const url = `${cfg.baseUrl}/images/generations`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: cfg.endpointId, ...body }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API 错误 (${response.status}): ${errText}`);
  }

  const json = await response.json() as any;

  // 同步模式：直接返回结果
  if (json.data && Array.isArray(json.data)) {
    return json.data as ArkImageResult[];
  }

  // 异步模式：轮询 task_id
  const taskId = json.id || json.task_id;
  if (!taskId) {
    throw new Error("API 返回格式异常：既无 data 也无 task_id");
  }

  return await pollTaskResult(cfg, taskId);
}

/** 异步轮询：前20秒每2秒，之后每5秒，最多120秒 */
async function pollTaskResult(cfg: ArkConfig, taskId: string): Promise<ArkImageResult[]> {
  const startTime = Date.now();
  const maxWait = 120_000;

  while (Date.now() - startTime < maxWait) {
    const elapsed = Date.now() - startTime;
    const interval = elapsed < 20_000 ? 2_000 : 5_000;
    await new Promise(r => setTimeout(r, interval));

    const pollUrl = `${cfg.baseUrl}/images/generations/${taskId}`;
    const res = await fetch(pollUrl, {
      headers: { "Authorization": `Bearer ${cfg.apiKey}` },
    });

    if (!res.ok) continue;

    const data = await res.json() as any;
    if (data.status === "failed" || data.status === "cancelled") {
      throw new Error(`图片生成任务${data.status === "failed" ? "失败" : "已取消"}`);
    }
    if (data.data && Array.isArray(data.data)) {
      return data.data as ArkImageResult[];
    }
    // 还在处理中，继续轮询
  }

  throw new Error("图片生成超时（超过 120 秒）");
}

/** 将图片下载保存到本地 */
async function downloadImage(url: string, savePath: string): Promise<void> {
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(savePath, buffer);
}

/** 本地图片转 base64 data URI */
function localImageToBase64(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const mime = mimeMap[ext] || "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// ── 工具定义 ─────────────────────────────────────

/** image_generate — 文生图 */
const imageGenerateTool: ToolDefinition = {
  name: "image_generate",
  description:
    "根据文字描述生成图片（火山方舟 Seedream）。" +
    "返回图片本地文件路径。需要配置 ARK_API_KEY 和 ARK_ENDPOINT_ID。",
  parameters: z.object({
    prompt: z.string().describe("图片描述（中英文均可）"),
    size: z.string().default("1024x1024").describe("图片尺寸，如 1024x1024 / 512x512"),
    n: z.number().min(1).max(4).default(1).describe("生成数量 (1-4)"),
    quality: z.string().optional().describe("质量参数，如 standard / 2K"),
    savePath: z.string().optional().describe("保存路径（默认临时目录）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { prompt, size, n, quality, savePath } = params as {
      prompt: string; size: string; n: number; quality?: string; savePath?: string;
    };

    const cfg = getArkConfig();
    if (!cfg.apiKey || !cfg.endpointId) return notConfiguredResult();

    try {
      const body: Record<string, unknown> = { prompt, size, n };
      if (quality) body.quality = quality;

      const results = await callArkImagesAPI(cfg, body);
      const savedPaths: string[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        let outPath: string;
        if (savePath) {
          if (results.length > 1) {
            const hasExt = /\.\w+$/.test(savePath);
            outPath = hasExt
              ? savePath.replace(/(\.[\w]+)$/, `_${i + 1}$1`)
              : `${savePath}_${i + 1}`;
          } else {
            outPath = savePath;
          }
        } else {
          outPath = path.join(os.tmpdir(), `sa_img_${Date.now()}_${i + 1}.png`);
        }

        if (result.url) {
          await downloadImage(result.url, outPath);
        } else if (result.b64_json) {
          const dir = path.dirname(outPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(outPath, Buffer.from(result.b64_json, "base64"));
        }
        savedPaths.push(outPath);
      }

      return {
        success: true,
        output: `✅ 图片生成完成（${results.length} 张）\n${savedPaths.map(p => `📁 ${p}`).join("\n")}`,
        data: { filePaths: savedPaths, count: results.length },
      };
    } catch (err: any) {
      return { success: false, output: `图片生成失败：${err.message}`, error: err.message };
    }
  },
};

/** image_edit — 图编图 */
const imageEditTool: ToolDefinition = {
  name: "image_edit",
  description:
    "基于参考图片+文字指令进行图片编辑。" +
    "imageUrl 支持 URL 或本地文件路径（自动转 base64）。",
  parameters: z.object({
    prompt: z.string().describe("编辑指令描述"),
    imageUrl: z.string().describe("参考图片 URL 或本地文件路径"),
    size: z.string().default("1024x1024").describe("输出尺寸"),
    savePath: z.string().optional().describe("保存路径（默认临时目录）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { prompt, imageUrl, size, savePath } = params as {
      prompt: string; imageUrl: string; size: string; savePath?: string;
    };

    const cfg = getArkConfig();
    if (!cfg.apiKey || !cfg.endpointId) return notConfiguredResult();

    try {
      // 本地文件自动转 base64
      let resolvedImage = imageUrl;
      if (!imageUrl.startsWith("http") && fs.existsSync(imageUrl)) {
        resolvedImage = localImageToBase64(imageUrl);
      }

      const body: Record<string, unknown> = {
        prompt,
        image: resolvedImage,
        size,
        n: 1,
      };

      const results = await callArkImagesAPI(cfg, body);
      if (!results.length || (!results[0].url && !results[0].b64_json)) {
        throw new Error("API 未返回有效的图片结果");
      }
      const outPath = savePath || path.join(os.tmpdir(), `sa_edit_${Date.now()}.png`);

      if (results[0]?.url) {
        await downloadImage(results[0].url, outPath);
      } else if (results[0]?.b64_json) {
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(outPath, Buffer.from(results[0].b64_json, "base64"));
      }

      return {
        success: true,
        output: `✅ 图片编辑完成\n📁 ${outPath}`,
        data: { filePath: outPath },
      };
    } catch (err: any) {
      return { success: false, output: `图片编辑失败：${err.message}`, error: err.message };
    }
  },
};

/** image_config — 查看配置状态 */
const imageConfigTool: ToolDefinition = {
  name: "image_config",
  description: "查看火山方舟 Seedream 图片生成的配置状态和使用说明。",
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    const cfg = getArkConfig();
    const configured = !!(cfg.apiKey && cfg.endpointId);
    const statusIcon = configured ? "✅ 已配置" : "⚠️ 未配置";

    const lines = [
      `火山方舟 Seedream 图片生成状态：${statusIcon}`,
      "",
      configured
        ? [
            `API Key: ${maskSecret(cfg.apiKey)}`,
            `Endpoint ID: ${cfg.endpointId}`,
            `Base URL: ${cfg.baseUrl}`,
          ].join("\n")
        : "请提供 API Key 和 Endpoint ID 以启用图片生成功能。",
      "",
      "配置步骤：",
      "1. 访问 https://console.volcengine.com/ark 注册方舟平台",
      "2. 在「API Key 管理」中创建密钥 → API Key",
      "3. 搜索 Seedream 模型 → 创建推理接入点 → 复制 Endpoint ID",
      "",
      "支持的功能：",
      "- image_generate: 文生图（文字描述 → 图片）",
      "- image_edit: 图编图（参考图 + 文字指令 → 新图片）",
    ];

    return {
      success: true,
      output: lines.join("\n"),
      data: { configured, endpointId: cfg.endpointId || null },
    };
  },
};

export const imageGenTools: ToolDefinition[] = [imageGenerateTool, imageEditTool, imageConfigTool];
