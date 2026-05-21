/**
 * v3 Task 6 — Files 文件解析路由 zod schema
 *
 * @why 文件上传解析是 Agent 知识注入的关键路径，需要明确支持类型与大小限制。
 *
 * 端点：
 *   POST /api/files/parse     — 解析 base64 文件，返回提取的文本
 *   GET  /api/files/supported — 列出支持的文件类型和限制
 */

import { z } from "zod";
import { registry } from "./registry-singleton.js";
import { apiSuccessEnvelope } from "./envelope.js";

// ─── Parse Body ─────────────────────────────────────────────

/** @why POST /api/files/parse 请求体，base64 文件内容 + 文件名 */
export const FileParseBodySchema = z.object({
  filename: z.string().describe("文件名（含扩展名），如 report.pdf"),
  data: z.string().describe("base64 编码的文件内容"),
});
registry.register("FileParseBody", FileParseBodySchema);

// ─── Parse Result ───────────────────────────────────────────

const FileParseResultData = z.object({
  text: z.string(),
  filename: z.string(),
  type: z.string(),
  truncated: z.boolean(),
  originalLength: z.number().optional(),
  meta: z.record(z.unknown()).optional(),
});

// ─── Supported Types ────────────────────────────────────────

const FileSupportedData = z.object({
  types: z.array(z.object({
    extension: z.string(),
    type: z.string(),
  })),
  maxSize: z.number().describe("最大文件大小（字节）"),
  maxTextLength: z.number().describe("文本截断阈值（字符）"),
});

// ─── 注册路径 ───────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/files/parse",
  summary: "解析文件，提取文本内容",
  request: { body: { content: { "application/json": { schema: FileParseBodySchema } } } },
  responses: {
    200: { description: "解析结果", content: { "application/json": { schema: apiSuccessEnvelope(FileParseResultData) } } },
    400: { description: "不支持的文件类型或无效数据" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/files/supported",
  summary: "获取支持的文件类型和限制",
  responses: {
    200: { description: "支持信息", content: { "application/json": { schema: apiSuccessEnvelope(FileSupportedData) } } },
  },
});
