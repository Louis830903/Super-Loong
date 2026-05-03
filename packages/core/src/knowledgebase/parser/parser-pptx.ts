/**
 * PPTX 解析器（知识库 Spec §5.2 / T2.6）。
 *
 * 技术选型：jszip（optional dep）+ 正则抽 <a:t> 文本
 *
 * PPTX 结构：
 *   - 本质是 ZIP 包
 *   - 幻灯片在 ppt/slides/slide{N}.xml，按数字顺序
 *   - 每个文本块放在 <a:t>...</a:t> 标签内
 *
 * 设计要点：
 *   - 按 slide 编号排序，每张 slide 加 [Slide N] 标题
 *   - pageBreaks 记每张 slide 的起始 offset
 *   - metadata.pageCount = slide 总数
 */

import type { ParseResult, ParserInput } from "./types.js";

export async function parsePptx(input: ParserInput): Promise<ParseResult> {
  // 动态 import jszip（optional dep）
  let JSZip: {
    loadAsync: (buf: Buffer) => Promise<{
      files: Record<string, { async: (type: "text") => Promise<string> }>;
    }>;
  };
  try {
    const modName = "jszip";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* webpackIgnore: true */ modName);
    JSZip = mod.default ?? mod;
  } catch (err) {
    const e = new Error("PARSE_OPTIONAL_DEP_MISSING");
    (e as Error & { cause?: unknown }).cause = err;
    (e as Error & { dep?: string }).dep = "jszip";
    throw e;
  }

  let zip: { files: Record<string, { async: (type: "text") => Promise<string> }> };
  try {
    zip = await JSZip.loadAsync(input.buffer);
  } catch (err) {
    const e = new Error("PARSE_FAILED");
    (e as Error & { cause?: unknown }).cause = err;
    throw e;
  }

  // 筛选 ppt/slides/slideN.xml 并按 N 升序
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)?.[1] ?? "0");
      const nb = Number(b.match(/slide(\d+)/)?.[1] ?? "0");
      return na - nb;
    });

  if (slideFiles.length === 0) {
    const e = new Error("PARSE_EMPTY");
    (e as Error & { reason?: string }).reason = "pptx-no-slides";
    throw e;
  }

  const pageBreaks: number[] = [];
  const parts: string[] = [];
  let offset = 0;

  for (const sf of slideFiles) {
    const xml = await zip.files[sf].async("text");
    // 提取 <a:t>...</a:t> 内容
    const texts: string[] = [];
    const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      // XML 实体解码（&lt; / &gt; / &amp; / &quot; / &apos;）
      const decoded = m[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
      if (decoded.trim()) texts.push(decoded);
    }

    const slideNum = sf.match(/slide(\d+)/)?.[1] ?? "?";
    // 空 slide 也占位（保持 pageCount 语义一致），但不加入文本减少 chunker 噪音
    if (texts.length > 0) {
      pageBreaks.push(offset);
      const block = `[Slide ${slideNum}]\n${texts.join(" ")}`;
      parts.push(block);
      offset += block.length + 2;
    }
  }

  const text = parts.join("\n\n");

  if (text.length === 0) {
    const e = new Error("PARSE_EMPTY");
    (e as Error & { reason?: string }).reason = "pptx-all-slides-empty";
    throw e;
  }

  return {
    text,
    pageBreaks,
    metadata: {
      pageCount: slideFiles.length, // 总 slide 数（含空 slide）
    },
  };
}
