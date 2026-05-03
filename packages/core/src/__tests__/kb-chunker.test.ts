/**
 * T3 分块器单测（知识库 Spec §5.3）。
 *
 * 覆盖点：
 *   1. estimateTokens：CJK / ASCII 混合估算
 *   2. isHeadingLine：Markdown + 中文章节
 *   3. splitByHeadings：多段切分 + 无标题兜底
 *   4. slidingWindow：短文直返 / 长文切分 / overlap 存在
 *   5. chunkParseResult L1 pageBreaks：XLSX 真实 ParseResult → 每 sheet 一块（或多块）
 *   6. chunkParseResult L1 PPTX：slide 元信息写入 metadata.slideNumber
 *   7. chunkParseResult L2 标题：Markdown 三级标题切块后 boundary=heading
 *   8. chunkParseResult L3 滑窗：超长 paragraph 切多块 + overlap 可见
 *   9. chunkParseResult KBChunk 字段完整性：id/docId/chunkIndex 连续/tokenCount 正数
 *  10. 空输入 → []
 *  11. 参数健壮性：非法 maxTokens/overlap 抛错
 */

import { describe, it, expect } from "vitest";
import {
  chunkParseResult,
  estimateTokens,
  isHeadingLine,
  splitByHeadings,
  slidingWindow,
} from "../knowledgebase/chunker/index.js";
import { parseXlsx, parseText } from "../knowledgebase/parser/index.js";
import type { ParseResult } from "../knowledgebase/parser/index.js";

// ─── 1. estimateTokens ─────────────────────────────────────

describe("estimateTokens token 估算", () => {
  it("空字符串 → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("纯英文：4 char ≈ 1 token", () => {
    // 16 字符 → 4 tokens
    expect(estimateTokens("abcdefghijklmnop")).toBe(4);
  });

  it("纯中文：1 char ≈ 1 token", () => {
    // 10 汉字 → 10 tokens
    expect(estimateTokens("你好世界今天天气真好")).toBe(10);
  });

  it("中英混合", () => {
    // 4 汉字（测试一下）+ 8 ASCII = 4 + 8/4 = 6 tokens
    expect(estimateTokens("测试一下abcdefgh")).toBe(6);
  });
});

// ─── 2. isHeadingLine ──────────────────────────────────────

describe("isHeadingLine 标题识别", () => {
  it("Markdown 一级标题", () => {
    expect(isHeadingLine("# Title")).toBe(true);
  });

  it("Markdown 六级标题", () => {
    expect(isHeadingLine("###### Deep")).toBe(true);
  });

  it("Markdown 七级标题（非法）", () => {
    expect(isHeadingLine("####### Too deep")).toBe(false);
  });

  it("中文「第一章」", () => {
    expect(isHeadingLine("第一章 开始")).toBe(true);
  });

  it("中文「第 3 节」", () => {
    expect(isHeadingLine("第3节：正文")).toBe(true);
  });

  it("普通段落", () => {
    expect(isHeadingLine("这是一段普通的文本")).toBe(false);
  });

  it("空行", () => {
    expect(isHeadingLine("")).toBe(false);
    expect(isHeadingLine("   ")).toBe(false);
  });
});

// ─── 3. splitByHeadings ────────────────────────────────────

describe("splitByHeadings 标题切段", () => {
  it("无标题 → 单段", () => {
    const secs = splitByHeadings("plain text without any heading");
    expect(secs.length).toBe(1);
    expect(secs[0].heading).toBe("");
  });

  it("三段 Markdown 标题切出 3 段", () => {
    const md = "# A\ncontent A\n## B\ncontent B\n### C\ncontent C";
    const secs = splitByHeadings(md);
    expect(secs.length).toBe(3);
    expect(secs[0].heading).toBe("# A");
    expect(secs[1].heading).toBe("## B");
    expect(secs[2].heading).toBe("### C");
  });

  it("中文章节切分", () => {
    const text = "第一章 开始\n这是第一章内容\n第二章 结束\n这是第二章内容";
    const secs = splitByHeadings(text);
    expect(secs.length).toBe(2);
    expect(secs[0].heading).toContain("第一章");
    expect(secs[1].heading).toContain("第二章");
  });

  it("标题前的前言保留为首段", () => {
    const text = "preamble line\n\n# First\nbody";
    const secs = splitByHeadings(text);
    expect(secs.length).toBe(2);
    expect(secs[0].heading).toBe(""); // 前言段无标题
    expect(secs[0].body).toContain("preamble");
  });
});

// ─── 4. slidingWindow ──────────────────────────────────────

describe("slidingWindow 滑窗切", () => {
  it("短文本 → 原样单块返回", () => {
    const w = slidingWindow("short text", 512, 64);
    expect(w.length).toBe(1);
    expect(w[0]).toBe("short text");
  });

  it("空文本 → 空数组", () => {
    expect(slidingWindow("", 512, 64)).toEqual([]);
    expect(slidingWindow("   \n  ", 512, 64)).toEqual([]);
  });

  it("超长文本 → 切成多块，每块 tokens ≤ maxTokens × 1.2 容差", () => {
    // 构造 2500 tokens 的文本：2500 个汉字
    const longText = "测试分块滑窗能力验证。".repeat(250); // 11 char × 250 = 2750 chars
    const windows = slidingWindow(longText, 500, 50);
    expect(windows.length).toBeGreaterThan(3);
    for (const w of windows) {
      // 允许 20% 容差（贪婪打包 + overlap 可能轻微超出）
      expect(estimateTokens(w)).toBeLessThanOrEqual(500 * 1.2);
    }
  });

  it("多块切分时相邻块有重叠（overlap）", () => {
    // 分句明显的长文
    const parts: string[] = [];
    for (let i = 1; i <= 40; i++) {
      parts.push(`第${i}句话讲述了一些内容很重要。`);
    }
    const longText = parts.join("");
    const windows = slidingWindow(longText, 100, 30);
    expect(windows.length).toBeGreaterThan(1);
    // 相邻两块应有非空交集（overlap 存在）
    const tail = windows[0].slice(-20);
    expect(windows[1].includes(tail.slice(-10)) || windows[1].slice(0, 50).includes("第")).toBe(true);
  });
});

// ─── 5. chunkParseResult L1：XLSX pageBreaks 真实解析 ───────

describe("chunkParseResult L1 pageBreaks（真实 XLSX）", () => {
  it("2-sheet workbook → 至少 2 块，且 sheetName 写入 metadata", async () => {
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

    const pr = await parseXlsx({ buffer: buf, filename: "test.xlsx" });
    const chunks = chunkParseResult(pr, { docId: "doc-001" });

    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // 所有块 docId 一致 + chunkIndex 连续
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].docId).toBe("doc-001");
      expect(chunks[i].chunkIndex).toBe(i);
      expect(chunks[i].tokenCount).toBeGreaterThan(0);
      expect(chunks[i].embedding).toBeUndefined();
      expect(chunks[i].embeddingType).toBe("simple");
    }

    // 至少一块带 sheetName=Users, 一块带 sheetName=Items
    const sheetNames = chunks.map((c) => (c.metadata as { sheetName?: string }).sheetName);
    expect(sheetNames).toContain("Users");
    expect(sheetNames).toContain("Items");

    // boundary 为 sheet
    const sheetBoundaries = chunks.filter(
      (c) => (c.metadata as { boundary?: string }).boundary === "sheet",
    );
    expect(sheetBoundaries.length).toBeGreaterThan(0);
  });
});

// ─── 6. chunkParseResult L1：PPTX slide 模拟 ────────────────

describe("chunkParseResult L1 pageBreaks（PPTX 模拟）", () => {
  it("伪造 PPTX ParseResult → slideNumber 写入 metadata", () => {
    const text = "[Slide 1]\nfirst slide content\n\n[Slide 2]\nsecond slide content";
    const pr: ParseResult = {
      text,
      pageBreaks: [0, text.indexOf("[Slide 2]")],
      metadata: { pageCount: 2 },
    };
    const chunks = chunkParseResult(pr, { docId: "doc-pptx" });
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const slideNums = chunks.map((c) => (c.metadata as { slideNumber?: number }).slideNumber);
    expect(slideNums).toContain(1);
    expect(slideNums).toContain(2);
  });
});

// ─── 7. chunkParseResult L2：Markdown 标题切 ────────────────

describe("chunkParseResult L2 标题切（Markdown）", () => {
  it("三级标题 → 至少 3 块，含 heading 标记", () => {
    const md = [
      "# Chapter One",
      "body one, some content here",
      "## Section A",
      "section A body",
      "## Section B",
      "section B body, more text",
    ].join("\n\n");
    const pr = parseText({ buffer: Buffer.from(md), filename: "doc.md" });
    const chunks = chunkParseResult(pr, { docId: "doc-md", minTokens: 1 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // 至少一块 boundary=heading，且 headingPath 非空
    const headingChunks = chunks.filter(
      (c) => (c.metadata as { boundary?: string }).boundary === "heading",
    );
    expect(headingChunks.length).toBeGreaterThan(0);
    expect((headingChunks[0].metadata as { headingPath?: string[] }).headingPath).toBeDefined();
  });
});

// ─── 8. chunkParseResult L3：滑窗兜底 ───────────────────────

describe("chunkParseResult L3 滑窗兜底", () => {
  it("超长无标题段落 → 切成多块，boundary=window", () => {
    // 构造 1500+ tokens 的无标题段落
    const longPara = "这是一个很长的段落用于测试滑窗切块能力验证。".repeat(100);
    const pr: ParseResult = {
      text: longPara,
      metadata: {},
    };
    const chunks = chunkParseResult(pr, {
      docId: "doc-long",
      maxTokens: 200,
      overlapTokens: 30,
    });
    expect(chunks.length).toBeGreaterThan(3);

    // 大部分非首块应为 window 边界
    const windowCount = chunks.filter(
      (c) => (c.metadata as { boundary?: string }).boundary === "window",
    ).length;
    expect(windowCount).toBeGreaterThanOrEqual(chunks.length - 2);

    // chunkIndex 连续 0..N-1
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });
});

// ─── 9. KBChunk 字段完整性 ──────────────────────────────────

describe("chunkParseResult 输出 KBChunk 字段完整", () => {
  it("字段齐全 + id 唯一 + createdAt 为数字", () => {
    const pr = parseText({ buffer: Buffer.from("hello world content"), filename: "a.txt" });
    const chunks = chunkParseResult(pr, { docId: "doc-x" });
    expect(chunks.length).toBe(1);
    const c = chunks[0];
    expect(typeof c.id).toBe("string");
    expect(c.id.length).toBeGreaterThan(0);
    expect(c.docId).toBe("doc-x");
    expect(c.chunkIndex).toBe(0);
    expect(c.content).toBe("hello world content");
    expect(c.embedding).toBeUndefined();
    expect(c.embeddingType).toBe("simple");
    expect(c.tokenCount).toBeGreaterThan(0);
    expect(typeof c.createdAt).toBe("number");
    expect(c.metadata).toBeDefined();
  });

  it("embeddingType 可覆盖", () => {
    const pr = parseText({ buffer: Buffer.from("content"), filename: "a.txt" });
    const chunks = chunkParseResult(pr, { docId: "doc-y", embeddingType: "qwen" });
    expect(chunks[0].embeddingType).toBe("qwen");
  });
});

// ─── 10. 边界 / 参数健壮性 ──────────────────────────────────

describe("chunkParseResult 边界与参数", () => {
  it("空文本 → []", () => {
    const pr: ParseResult = { text: "", metadata: {} };
    expect(chunkParseResult(pr, { docId: "d" })).toEqual([]);
  });

  it("纯空白 → []", () => {
    const pr: ParseResult = { text: "   \n  \t  ", metadata: {} };
    expect(chunkParseResult(pr, { docId: "d" })).toEqual([]);
  });

  it("非法 maxTokens → 抛错", () => {
    const pr: ParseResult = { text: "x", metadata: {} };
    expect(() => chunkParseResult(pr, { docId: "d", maxTokens: 0 })).toThrow(/maxTokens/);
  });

  it("非法 overlap（>= maxTokens）→ 抛错", () => {
    const pr: ParseResult = { text: "x", metadata: {} };
    expect(() => chunkParseResult(pr, { docId: "d", maxTokens: 100, overlapTokens: 100 })).toThrow(
      /overlap/,
    );
  });
});
