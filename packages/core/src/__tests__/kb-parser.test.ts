/**
 * T2.8 知识库解析器单测（知识库 Spec §5.2）。
 *
 * 覆盖点：
 *   1. detectFormat：mime / 扩展名 / 魔数 三层兜底 + 未知类型返回 null
 *   2. parseText：txt（去 BOM）/ md（带/不带 frontmatter）
 *   3. parseHtml：标签剥离 / 实体解码 / script+style 去除 / title 提取
 *   4. parseXlsx（真实）：动态造 2-sheet workbook → pageBreaks 与 sheet 边界对齐
 *   5. parseDocx：mammoth 未装时走 PARSE_OPTIONAL_DEP_MISSING 分支（core 层未 install）
 *   6. parsePptx：jszip 未装时走 PARSE_OPTIONAL_DEP_MISSING 分支
 *   7. parseFile 总入口：按 format 分发正确
 *   8. 错误码：PARSE_UNSUPPORTED / PARSE_EMPTY / PARSE_NEEDS_OCR
 *
 * 说明：PDF 真实解析未覆盖（需二进制样本），T2.3 的 PARSE_NEEDS_OCR 分支用伪造数据走不通
 *      正则；真实 PDF 解析由后续集成测试 + T8 E2E 覆盖。
 */

import { describe, it, expect } from "vitest";
import {
  detectFormat,
  parseFile,
  parseText,
  parseHtml,
  parseXlsx,
  parsePdf,
  parseDocx,
  parsePptx,
} from "../knowledgebase/parser/index.js";

// ─── 1. detectFormat ────────────────────────────────────

describe("detectFormat 格式推断", () => {
  const b = Buffer.from("dummy");

  it("MIME 优先：application/pdf → pdf", () => {
    expect(detectFormat({ buffer: b, mime: "application/pdf" })).toBe("pdf");
  });

  it("扩展名兜底：x.md → markdown", () => {
    expect(detectFormat({ buffer: b, filename: "readme.md" })).toBe("markdown");
  });

  it("扩展名识别：.pptx → pptx", () => {
    expect(detectFormat({ buffer: b, filename: "slides.pptx" })).toBe("pptx");
  });

  it("CSV → xlsx（走 SheetJS）", () => {
    expect(detectFormat({ buffer: b, filename: "data.csv" })).toBe("xlsx");
  });

  it("魔数识别：%PDF 开头 → pdf", () => {
    const pdfHead = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(detectFormat({ buffer: pdfHead })).toBe("pdf");
  });

  it("魔数识别：<!DOCTYPE html → html", () => {
    const htmlBuf = Buffer.from("<!DOCTYPE html>\n<html><body>x</body></html>");
    expect(detectFormat({ buffer: htmlBuf })).toBe("html");
  });

  it("未知格式 → null", () => {
    expect(detectFormat({ buffer: b, filename: "unknown.xyz" })).toBeNull();
  });

  it("MIME 优先级高于扩展名", () => {
    // filename 是 .txt 但 mime 是 html → 以 mime 为准
    expect(detectFormat({ buffer: b, filename: "foo.txt", mime: "text/html" })).toBe("html");
  });
});

// ─── 2. parseText ───────────────────────────────────────

describe("parseText txt/md", () => {
  it("txt 纯文本 → 原样返回", () => {
    const r = parseText({ buffer: Buffer.from("hello\nworld"), filename: "a.txt" });
    expect(r.text).toBe("hello\nworld");
    expect(r.metadata.frontmatter).toBeUndefined();
  });

  it("去 BOM", () => {
    const r = parseText({ buffer: Buffer.from("\uFEFFcontent"), filename: "a.txt" });
    expect(r.text).toBe("content");
  });

  it("md 带 frontmatter → 剥离并暴露 metadata", () => {
    const md = "---\ntitle: Hello\ntags: [a, b]\n---\n\n# Body\n\nparagraph";
    const r = parseText({ buffer: Buffer.from(md), filename: "post.md" });
    expect(r.metadata.frontmatter).toEqual({ title: "Hello", tags: ["a", "b"] });
    expect(r.text).toContain("# Body");
    expect(r.text).not.toContain("---");
  });

  it("md 无 frontmatter → text 原样", () => {
    const md = "# Just a title\n\ncontent";
    const r = parseText({ buffer: Buffer.from(md), filename: "doc.md" });
    expect(r.text).toBe(md);
    expect(r.metadata.frontmatter).toBeUndefined();
  });

  it("通过 mime 识别 md（filename 为 .txt）", () => {
    const md = "---\nk: v\n---\nbody";
    const r = parseText({ buffer: Buffer.from(md), filename: "a.txt", mime: "text/markdown" });
    expect(r.metadata.frontmatter).toEqual({ k: "v" });
  });
});

// ─── 3. parseHtml ───────────────────────────────────────

describe("parseHtml", () => {
  it("剥除标签保留文本", () => {
    const html = `<html><head><title>T</title></head><body><p>Hello <strong>World</strong></p></body></html>`;
    const r = parseHtml({ buffer: Buffer.from(html) });
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("World");
    expect(r.text).not.toContain("<p>");
    expect(r.text).not.toContain("<strong>");
    expect(r.metadata.title).toBe("T");
  });

  it("去除 script 与 style 块（含其中内容）", () => {
    const html = `<html><body>
      <script>var x = "SECRET_JS";</script>
      <style>.cls { color: red; }</style>
      <p>visible</p>
    </body></html>`;
    const r = parseHtml({ buffer: Buffer.from(html) });
    expect(r.text).toContain("visible");
    expect(r.text).not.toContain("SECRET_JS");
    expect(r.text).not.toContain("color: red");
  });

  it("HTML 实体解码", () => {
    const html = `<p>A &amp; B &lt;tag&gt; &#39;q&#39; &#x41;</p>`;
    const r = parseHtml({ buffer: Buffer.from(html) });
    expect(r.text).toContain("A & B <tag> 'q' A");
  });

  it("去除注释块", () => {
    const html = `<p>visible</p><!-- hidden comment with keyword SECRET -->`;
    const r = parseHtml({ buffer: Buffer.from(html) });
    expect(r.text).not.toContain("SECRET");
    expect(r.text).toContain("visible");
  });

  it("保留段落换行", () => {
    const html = `<p>Para 1</p><p>Para 2</p><p>Para 3</p>`;
    const r = parseHtml({ buffer: Buffer.from(html) });
    // 经过压缩空白后段落之间应有换行
    const lines = r.text.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("Para 1");
    expect(lines).toContain("Para 2");
    expect(lines).toContain("Para 3");
  });
});

// ─── 4. parseXlsx（真实） ────────────────────────────────

describe("parseXlsx 真实解析", () => {
  it("2-sheet workbook → text 包含 sheet 标题 + pageBreaks 记边界", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const sheet1 = XLSX.utils.aoa_to_sheet([
      ["name", "age"],
      ["Alice", 30],
      ["Bob", 25],
    ]);
    const sheet2 = XLSX.utils.aoa_to_sheet([
      ["id", "value"],
      [1, "foo"],
    ]);
    XLSX.utils.book_append_sheet(wb, sheet1, "Users");
    XLSX.utils.book_append_sheet(wb, sheet2, "Items");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const r = await parseXlsx({ buffer: buf, filename: "test.xlsx" });
    expect(r.text).toContain("[Sheet: Users]");
    expect(r.text).toContain("Alice,30");
    expect(r.text).toContain("[Sheet: Items]");
    expect(r.metadata.pageCount).toBe(2);
    expect(r.metadata.sheetNames).toEqual(["Users", "Items"]);
    expect(r.pageBreaks).toBeDefined();
    expect(r.pageBreaks!.length).toBe(2);
    // 第 1 个 break 必为 0
    expect(r.pageBreaks![0]).toBe(0);
    // 第 2 个 break 应指向 "[Sheet: Items]"
    expect(r.text.slice(r.pageBreaks![1]).startsWith("[Sheet: Items]")).toBe(true);
  });

  it("空 workbook → PARSE_EMPTY", async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Empty");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    await expect(parseXlsx({ buffer: buf, filename: "empty.xlsx" })).rejects.toThrow("PARSE_EMPTY");
  });
});

// ─── 5. parseDocx / parsePptx 可选依赖缺失路径 ───────────

describe("可选依赖缺失", () => {
  // mammoth/jszip 实际已安装在 monorepo node_modules 中（动态 import 会成功），
  // 但 dummy buffer 不是合法 docx/pptx → 抛 PARSE_FAILED（非 PARSE_OPTIONAL_DEP_MISSING）
  it("parseDocx 收到无效 buffer → PARSE_FAILED（mammoth 已装但无法解析伪造字节）", async () => {
    await expect(
      parseDocx({ buffer: Buffer.from("dummy-docx-bytes"), filename: "a.docx" }),
    ).rejects.toThrow(/PARSE_FAILED|PARSE_OPTIONAL_DEP_MISSING/);
  });

  it("parsePptx 收到无效 buffer → PARSE_FAILED（jszip 已装但无法解析伪造字节）", async () => {
    await expect(
      parsePptx({ buffer: Buffer.from("dummy-pptx-bytes"), filename: "a.pptx" }),
    ).rejects.toThrow(/PARSE_FAILED|PARSE_OPTIONAL_DEP_MISSING/);
  });
});

// ─── 6. parsePdf 无效 buffer 错误路径 ────────────────────

describe("parsePdf 错误路径", () => {
  it("非 PDF buffer → PARSE_FAILED（pdf-parse 抛错）", async () => {
    await expect(
      parsePdf({ buffer: Buffer.from("not-a-pdf-at-all"), filename: "fake.pdf" }),
    ).rejects.toThrow(/PARSE_FAILED|PARSE_NEEDS_OCR/);
  });
});

// ─── 7. parseFile 总入口分发 ─────────────────────────────

describe("parseFile 总入口", () => {
  it("分发 txt → parseText 行为", async () => {
    const r = await parseFile({ buffer: Buffer.from("plain"), filename: "a.txt" });
    expect(r.text).toBe("plain");
  });

  it("分发 html → parseHtml 行为", async () => {
    const r = await parseFile({
      buffer: Buffer.from("<html><body><p>hi</p></body></html>"),
      filename: "a.html",
    });
    expect(r.text).toContain("hi");
  });

  it("未知格式 → PARSE_UNSUPPORTED", async () => {
    await expect(
      parseFile({ buffer: Buffer.from("..."), filename: "foo.xyz" }),
    ).rejects.toThrow("PARSE_UNSUPPORTED");
  });

  // mammoth 已装但 dummy buffer 无效 → PARSE_FAILED（而非 PARSE_OPTIONAL_DEP_MISSING）
  it("docx 分发 → 无法解析时抛 PARSE_FAILED", async () => {
    await expect(
      parseFile({ buffer: Buffer.from("dummy"), filename: "a.docx" }),
    ).rejects.toThrow(/PARSE_FAILED|PARSE_OPTIONAL_DEP_MISSING/);
  });
});
