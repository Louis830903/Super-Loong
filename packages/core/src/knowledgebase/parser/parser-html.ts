/**
 * HTML 解析器（知识库 Spec §5.2 / T2.7）。
 *
 * 设计决策：
 *   - 不引入 jsdom / cheerio 等重量级依赖（避免 core 包体膨胀）
 *   - 用正则剥除 <script> / <style> / <!-- --> + 替换标签为空
 *   - 解码常见 HTML 实体（&amp; / &lt; / &gt; / &quot; / &#39; / &nbsp; / &#数字;）
 *   - 保留段落间的换行（<p>/<br>/<div>/<h1-6> 替换为 \n）
 *
 * 适用场景：
 *   - 网页克隆文件（已下载的单页 HTML）
 *   - 少量 HTML 片段
 *
 * 不适用：
 *   - 复杂动态渲染页面（应走 T7 的 web scraper sidecar）
 */

import type { ParseResult, ParserInput } from "./types.js";

/** HTML 实体解码 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&#39;": "'",
    "&nbsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
    "&hellip;": "…",
    "&copy;": "©",
    "&reg;": "®",
  };
  let out = text;
  for (const [entity, ch] of Object.entries(named)) {
    out = out.split(entity).join(ch);
  }
  // 数字实体：&#123; / &#x1F; — 用 replace 回调避免正则全局状态坑
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
  return out;
}

/** 从 HTML 提取 <title> */
function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1].trim()) : undefined;
}

/**
 * 解析 HTML，返回纯文本（带段落换行）。
 */
export function parseHtml(input: ParserInput): ParseResult {
  const raw = input.buffer.toString("utf8");
  const title = extractTitle(raw);

  // 1. 去掉 <script> / <style> 块（含其中的内容）
  let text = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  // 2. 去掉 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // 3. 块级标签替换为换行（保留段落感）
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|section|article|header|footer|blockquote)[^>]*>/gi, "\n");
  // 4. 其他标签直接去掉
  text = text.replace(/<[^>]+>/g, "");
  // 5. 解码实体
  text = decodeEntities(text);
  // 6. 压缩空白 —— 连续 3+ 换行压为 2，行内多空格压为 1 空格
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return {
    text,
    metadata: title ? { title } : {},
  };
}
