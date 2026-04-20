/**
 * Web Tools — HTTP requests and web scraping.
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/index.js";

export const httpRequestTool: ToolDefinition = {
  name: "http_request",
  description: "Send an HTTP request and return the response. Supports GET, POST, PUT, DELETE, PATCH methods. For file downloads, save the response to disk with write_file and it will be sent to the user as an attachment.",
  parameters: z.object({
    url: z.string().describe("The URL to request"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    headers: z.record(z.string()).optional().describe("Request headers"),
    body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
    timeout: z.number().default(15000).describe("Timeout in milliseconds"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { url, method, headers, body, timeout } = params as {
      url: string; method: string; headers?: Record<string, string>; body?: string; timeout: number;
    };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: headers ?? {},
        body: method !== "GET" ? body : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const responseText = await response.text();
      const truncated = responseText.length > 10000
        ? responseText.slice(0, 10000) + "\n...[truncated]"
        : responseText;

      return {
        success: response.ok,
        output: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
        data: { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
      };
    } catch (err: any) {
      return { success: false, output: `HTTP request failed: ${err.message}`, error: err.message };
    }
  },
};

export const scrapeUrlTool: ToolDefinition = {
  name: "scrape_url",
  description: "Fetch a web page and extract its text content (strips HTML tags). Useful for reading articles or documentation.",
  parameters: z.object({
    url: z.string().describe("URL to scrape"),
    maxLength: z.number().default(5000).describe("Maximum characters to return"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { url, maxLength } = params as { url: string; maxLength: number };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(url, {
        headers: { "User-Agent": "SuperAgent/1.0" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const html = await response.text();
      // Simple HTML to text conversion
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();

      const truncated = text.length > maxLength
        ? text.slice(0, maxLength) + "\n...[truncated]"
        : text;

      return { success: true, output: truncated, data: { url, originalLength: text.length } };
    } catch (err: any) {
      return { success: false, output: `Scrape failed: ${err.message}`, error: err.message };
    }
  },
};

/** 从百度搜索结果 HTML 中提取标题、链接、摘要 */
function parseBaiduResults(html: string, maxResults: number): Array<{ title: string; link: string; snippet: string }> {
  const results: Array<{ title: string; link: string; snippet: string }> = [];

  // 策略1：匹配 c-container 容器内的 h3>a 标题 + 摘要
  const containerRe = /<div[^>]*class="[^"]*c-container[^"]*"[^>]*>[\s\S]*?<\/div>\s*(?=<div[^>]*class="[^"]*(?:c-container|result-op)|<div\s+id="page"|$)/g;
  let m: RegExpExecArray | null;
  while ((m = containerRe.exec(html)) !== null && results.length < maxResults) {
    const block = m[0];
    // 提取标题和链接
    const titleM = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    const link = titleM[1];
    const title = titleM[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    // 提取摘要（兼容多种 class 名称，优先匹配长文本内容）
    const snipPatterns = [
      /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/,
      /<span[^>]*class="[^"]*c-color-text[^"]*"[^>]*>([\s\S]*?)<\/span>/,
    ];
    let snippet = "";
    for (const pat of snipPatterns) {
      const snipM = block.match(pat);
      if (snipM?.[1]) {
        const candidate = snipM[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        // 取最长的摘要候选（至少15字才算有效摘要）
        if (candidate.length > snippet.length && candidate.length >= 15) snippet = candidate;
      }
    }
    // 最后兜底：从整个 block 中提取去标签后的纯文本（跳过标题/样式/脚本）
    if (!snippet) {
      const blockText = block
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<h3[^>]*>[\s\S]*?<\/h3>/g, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\{[^}]*\}/g, "")  // 过滤残余 CSS/JSON 片段
        .replace(/\s+/g, " ")
        .trim();
      if (blockText.length >= 15) snippet = blockText.slice(0, 200);
    }
    results.push({ title, link, snippet });
  }

  // 策略2：后备 — 直接提取所有 h3>a（百度改版时兜底）
  if (results.length === 0) {
    const h3Re = /<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/g;
    let h3m: RegExpExecArray | null;
    while ((h3m = h3Re.exec(html)) !== null && results.length < maxResults) {
      const title = h3m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (title) results.push({ title, link: h3m[1], snippet: "" });
    }
  }
  return results;
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "使用百度搜索引擎搜索互联网内容，返回标题、链接和摘要。无需任何 API Key，开箱即用。",
  parameters: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().default(5).describe("Maximum number of results (1-10)"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { query, maxResults } = params as { query: string; maxResults: number };
    const num = Math.min(Math.max(maxResults, 1), 10);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      // 百度搜索：wd=关键词, rn=每页条数, ie=编码
      const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${num}&ie=utf-8`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const html = await response.text();
      const results = parseBaiduResults(html, num);

      if (results.length === 0) {
        return { success: true, output: "No results found.", data: { results: [] } };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`
      ).join("\n\n");

      return { success: true, output: formatted, data: { results: results.length, items: results } };
    } catch (err: any) {
      return { success: false, output: `Search failed: ${err.message}`, error: err.message };
    }
  },
};

export const webTools: ToolDefinition[] = [
  httpRequestTool,
  scrapeUrlTool,
  webSearchTool,
];
