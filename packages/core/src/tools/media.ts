/**
 * Media Tools — pdf_extract / markdown_render / qrcode_generate × 3（延迟加载）。
 *
 * - pdf_extract: 动态 import("pdf-parse")，提取 PDF 文本
 * - markdown_render: gray-matter 解析 frontmatter + 正文输出（已在 deps 中）
 * - qrcode_generate: 动态 import("qrcode")，生成二维码图片
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { checkFileSize, truncateResult, validateWritePath } from "./shared-security.js";

// ── 路径验证 ──────────────────────────────────

const ALLOWED_ROOTS = [
  path.resolve(process.cwd()),
  path.resolve(os.homedir()),
  path.resolve(os.tmpdir()),
];

function validatePath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
    return `Error: Path '${filePath}' is outside allowed directories`;
  }
  return null;
}

// ── 工具定义 ────────────────────────────────────

/** pdf_extract — 提取 PDF 文件文本 */
const pdfExtractTool: ToolDefinition = {
  name: "pdf_extract",
  description: "提取 PDF 文件中的文本内容。需要安装 pdf-parse 库（pnpm add pdf-parse）。",
  parameters: z.object({
    path: z.string().describe("PDF 文件路径"),
    pages: z.string().optional().describe("页码范围，如 '1-5' 或 '1,3,5'（默认全部）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { path: filePath, pages } = params as { path: string; pages?: string };
    const pathErr = validatePath(filePath);
    if (pathErr) return { success: false, output: pathErr, error: pathErr };
    const sizeErr = checkFileSize(filePath, 100 * 1024 * 1024); // 100MB 上限
    if (sizeErr) return { success: false, output: sizeErr, error: sizeErr };

    if (!fs.existsSync(filePath)) {
      return { success: false, output: `文件不存在: ${filePath}`, error: "file_not_found" };
    }

    try {
      // 动态导入 pdf-parse（optionalDep）
      const modName = "pdf-parse";
      const pdfParse = (await import(/* webpackIgnore: true */ modName) as any).default || (await import(/* webpackIgnore: true */ modName) as any);
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer, {
        // 页码上限 200 页防护
        max: 200,
      });

      let text = pdfData.text || "";

      // 如果指定了页码范围，按页分割提取
      if (pages && pdfData.text) {
        const pageTexts = text.split(/\f/); // PDF 翻页符分割
        const selectedPages = parsePageRange(pages, pageTexts.length);
        text = selectedPages.map(p => pageTexts[p - 1] || "").join("\n\n--- Page Break ---\n\n");
      }

      return {
        success: true,
        output: truncateResult(`PDF 内容（${pdfData.numpages} 页）：\n\n${text}`),
        data: {
          pages: pdfData.numpages,
          textLength: text.length,
          info: pdfData.info,
        },
      };
    } catch (err: any) {
      if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
        return { success: false, output: "pdf-parse 库未安装。请执行: pnpm add pdf-parse", error: "pdf-parse not installed" };
      }
      return { success: false, output: `PDF 解析失败: ${err.message}`, error: err.message };
    }
  },
};

/** 解析页码范围字符串："1-5" → [1,2,3,4,5], "1,3,5" → [1,3,5] */
function parsePageRange(pages: string, maxPage: number): number[] {
  const result: Set<number> = new Set();
  const parts = pages.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map(Number);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(maxPage, end); i++) {
          result.add(i);
        }
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num >= 1 && num <= maxPage) result.add(num);
    }
  }
  return [...result].sort((a, b) => a - b);
}

/** markdown_render — Markdown 渲染 */
const markdownRenderTool: ToolDefinition = {
  name: "markdown_render",
  description:
    "将 Markdown 文本或文件渲染为纯文本或简单 HTML。" +
    "自动解析 frontmatter（YAML 元数据头），返回正文内容。",
  parameters: z.object({
    input: z.string().describe("Markdown 文件路径或文本内容"),
    format: z.enum(["text", "html"]).default("text").describe("输出格式：text=纯文本, html=简单HTML"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { input, format } = params as { input: string; format: "text" | "html" };

    let mdText = input;
    // 判断是文件还是文本
    if (!input.includes("\n") && fs.existsSync(input)) {
      const pathErr = validatePath(input);
      if (pathErr) return { success: false, output: pathErr, error: pathErr };
      const sizeErr = checkFileSize(input, 10 * 1024 * 1024); // 10MB 上限
      if (sizeErr) return { success: false, output: sizeErr, error: sizeErr };
      mdText = fs.readFileSync(input, "utf-8");
    }

    try {
      // 使用已有的 gray-matter 解析 frontmatter
      const matter = await import("gray-matter");
      const parsed = matter.default(mdText);

      let output: string;
      if (format === "html") {
        // 简单 Markdown → HTML 转换（不依赖额外库）
        output = simpleMarkdownToHtml(parsed.content);
      } else {
        output = parsed.content;
      }

      const frontmatter = Object.keys(parsed.data).length > 0
        ? `\nFrontmatter:\n${JSON.stringify(parsed.data, null, 2)}\n\n`
        : "";

      return {
        success: true,
        output: truncateResult(`${frontmatter}${output}`),
        data: { frontmatter: parsed.data, contentLength: parsed.content.length, format },
      };
    } catch (err: any) {
      return { success: false, output: `Markdown 渲染失败: ${err.message}`, error: err.message };
    }
  },
};

/** 简单 Markdown → HTML 转换（覆盖核心语法，无外部依赖） */
function simpleMarkdownToHtml(md: string): string {
  return md
    // 标题
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // 粗体/斜体
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // 代码块
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    // 行内代码
    .replace(/`(.+?)`/g, "<code>$1</code>")
    // 链接
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    // 列表
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    // 段落（空行分隔）
    .replace(/\n\n/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>");
}

/** qrcode_generate — 生成二维码 */
const qrcodeGenerateTool: ToolDefinition = {
  name: "qrcode_generate",
  description: "生成二维码图片文件。需要安装 qrcode 库（pnpm add qrcode）。",
  parameters: z.object({
    content: z.string().describe("二维码内容（URL、文本等）"),
    savePath: z.string().optional().describe("保存路径（默认临时目录）"),
    size: z.number().default(256).describe("图片尺寸（像素）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { content, savePath, size } = params as { content: string; savePath?: string; size: number };

    // QR 码标准上限 4296 字节
    if (Buffer.byteLength(content, "utf-8") > 4296) {
      return { success: false, output: "内容过长（二维码标准上限 4296 字节）", error: "content too long" };
    }

    const outPath = savePath || path.join(os.tmpdir(), `sa_qr_${Date.now()}.png`);

    // 路径安全校验（用户指定 savePath 时）
    if (savePath) {
      const pathErr = validatePath(savePath);
      if (pathErr) return { success: false, output: pathErr, error: pathErr };
      const writeErr = validateWritePath(savePath);
      if (writeErr) return { success: false, output: writeErr, error: writeErr };
    }

    try {
      // 动态导入 qrcode（optionalDep）
      const modName = "qrcode";
      const QRCode = await import(/* webpackIgnore: true */ modName) as any;
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      await QRCode.toFile(outPath, content, {
        width: size,
        margin: 2,
        type: "png",
      });

      return {
        success: true,
        output: `✅ 二维码已生成\n📁 ${outPath}\n内容: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`,
        data: { filePath: outPath, contentLength: content.length, size },
      };
    } catch (err: any) {
      if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
        return { success: false, output: "qrcode 库未安装。请执行: pnpm add qrcode", error: "qrcode not installed" };
      }
      return { success: false, output: `二维码生成失败: ${err.message}`, error: err.message };
    }
  },
};

export const mediaTools: ToolDefinition[] = [pdfExtractTool, markdownRenderTool, qrcodeGenerateTool];
