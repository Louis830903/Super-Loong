/**
 * File parsing routes — extract text content from binary documents.
 *
 * POST /api/files/parse     — Parse a base64-encoded file, return extracted text
 * GET  /api/files/supported — List supported file types and limits
 */

import type { FastifyInstance } from "fastify";

// 支持的可解析二进制文件类型
const PARSEABLE_TYPES: Record<string, string> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".pptx": "pptx",  // A-3: PPT 解析支持
};

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_TEXT_LENGTH = 50000; // 截断阈值，防止撑爆 LLM context

export async function fileRoutes(app: FastifyInstance) {
  /**
   * POST /api/files/parse
   * Body: { filename: string, data: string (base64) }
   * Returns: { text, filename, type, truncated, originalLength, meta }
   */
  app.post<{
    Body: { filename: string; data: string };
  }>("/api/files/parse", {
    bodyLimit: 30 * 1024 * 1024, // 30MB — base64 编码增加约 33% 体积
  }, async (request, reply) => {
    const { filename, data } = request.body ?? {};

    if (!filename || !data) {
      return reply.status(400).send({ error: "filename and data are required" });
    }

    const ext = "." + (filename.split(".").pop()?.toLowerCase() ?? "");
    const fileType = PARSEABLE_TYPES[ext];

    if (!fileType) {
      return reply.status(400).send({
        error: `不支持的文件类型: ${ext}`,
        supported: Object.keys(PARSEABLE_TYPES),
      });
    }

    // 解码 base64 并检查大小
    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      return reply.status(400).send({ error: "Invalid base64 data" });
    }

    if (buffer.length > MAX_FILE_SIZE) {
      return reply.status(413).send({
        error: `文件过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)，最大支持 ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      });
    }

    try {
      let text = "";
      let meta: Record<string, unknown> = {};

      switch (fileType) {
        case "pdf": {
          const pdfParse = (await import("pdf-parse")).default;
          const result = await pdfParse(buffer);
          text = result.text;
          meta = { pages: result.numpages };
          break;
        }
        case "docx": {
          const mammoth = await import("mammoth");
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
          if (result.messages?.length) {
            meta.warnings = result.messages.map((m: { message: string }) => m.message).slice(0, 5);
          }
          break;
        }
        case "xlsx": {
          const XLSX = await import("xlsx");
          const workbook = XLSX.read(buffer, { type: "buffer" });
          const sheets: string[] = [];
          for (const name of workbook.SheetNames) {
            const sheet = workbook.Sheets[name];
            if (!sheet) continue;
            const csv = XLSX.utils.sheet_to_csv(sheet);
            sheets.push(`[Sheet: ${name}]\n${csv}`);
          }
          text = sheets.join("\n\n");
          meta = {
            sheetCount: workbook.SheetNames.length,
            sheetNames: workbook.SheetNames,
          };
          break;
        }
        case "pptx": {
          // A-3: PPTX 是 ZIP 包，幻灯片在 ppt/slides/slide*.xml
          const JSZip = (await import("jszip")).default;
          const zip = await JSZip.loadAsync(buffer);
          const slides: string[] = [];
          const slideFiles = Object.keys(zip.files)
            .filter(f => f.match(/^ppt\/slides\/slide\d+\.xml$/))
            .sort();
          for (const sf of slideFiles) {
            const xml = await zip.files[sf].async("text");
            // 提取 <a:t> 标签中的文本
            const texts = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
              .map(m => m[1])
              .filter(Boolean);
            if (texts.length) {
              const slideNum = sf.match(/slide(\d+)/)?.[1] ?? "?";
              slides.push(`[Slide ${slideNum}]\n${texts.join(" ")}`);
            }
          }
          text = slides.join("\n\n");
          meta = { slideCount: slideFiles.length };
          break;
        }
        default:
          return reply.status(400).send({ error: `Parser not implemented for: ${fileType}` });
      }

      const truncated = text.length > MAX_TEXT_LENGTH;

      app.log.info(
        { filename, type: fileType, originalLength: text.length, truncated },
        "File parsed successfully"
      );

      return {
        text: truncated
          ? text.slice(0, MAX_TEXT_LENGTH) + "\n...(内容过长已截断)"
          : text,
        filename,
        type: fileType,
        truncated,
        originalLength: text.length,
        meta,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      app.log.error({ filename, type: fileType, error: errMsg }, "File parsing failed");
      return reply.status(500).send({ error: `解析失败: ${errMsg}` });
    }
  });

  /** GET /api/files/supported — 返回支持的文件类型列表 */
  app.get("/api/files/supported", async () => {
    return {
      types: Object.entries(PARSEABLE_TYPES).map(([ext, type]) => ({ ext, type })),
      maxSizeMB: MAX_FILE_SIZE / 1024 / 1024,
      maxTextLength: MAX_TEXT_LENGTH,
    };
  });
}
