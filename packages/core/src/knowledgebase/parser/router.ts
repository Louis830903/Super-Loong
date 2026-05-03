/**
 * 知识库解析路由策略（知识库 Spec §T7）。
 *
 * 职责：
 *   - 按文件格式 / TS 解析结果，决定是否降级到 Docling sidecar
 *   - 对 TS parser 抛出的 PARSE_NEEDS_OCR / PARSE_EMPTY，尝试走 Docling
 *   - Docling 不可达或再次失败时，重抛原错（由 pipeline 写 status=failed）
 *
 * 降级矩阵（Spec §T7）：
 *
 *   | TS 解析结果             | enableDocling | 行为                                    |
 *   |-------------------------|---------------|-----------------------------------------|
 *   | 成功                    | -             | 直接返回 TS 结果                        |
 *   | PARSE_NEEDS_OCR         | false/null    | 重抛 PARSE_NEEDS_OCR                    |
 *   | PARSE_NEEDS_OCR         | true          | 调 Docling；成功→返回；失败→重抛原错    |
 *   | PARSE_EMPTY             | true          | 调 Docling；成功→返回；失败→重抛原错    |
 *   | PARSE_UNSUPPORTED       | -             | 重抛（Docling 也未必认得，避免增加延迟） |
 *   | PARSE_OPTIONAL_DEP_*    | -             | 重抛（是 TS 侧环境问题，非格式问题）     |
 *   | PARSE_FAILED            | -             | 重抛（真·解析失败，不再折腾）            |
 *
 * 设计原则：
 *   1. 零破坏：不传 docling 参数时，行为与 parseFile 完全一致
 *   2. 不隐藏错误：Docling 降级失败时，用户看到的是 TS 原始错误（便于定位）
 *   3. 对上游透明：返回值结构与 parseFile 一致（ParseResult）
 */

import type { DoclingClient } from "./parser-docling.js";
import { parseFile } from "./index.js";
import type { ParseResult, ParserInput } from "./types.js";

// ─── 类型 ────────────────────────────────────────────────────

/**
 * parseWithFallback 的选项。
 *
 * - maxPdfPages：透传给 TS parsePdf
 * - docling：可选的 Docling 客户端；若 null/undefined 则完全禁用降级
 * - onFallback：降级事件回调（便于日志与审计）
 */
export interface ParseRouterOptions {
  /** PDF 最大页数（透传给 TS parsePdf） */
  maxPdfPages?: number;
  /**
   * Docling 客户端。传 null / undefined = 不启用降级（行为等价 parseFile）。
   */
  docling?: DoclingClient | null;
  /** TS 成功/降级路径的回调（可选，用于日志） */
  onFallback?: (ev: {
    reason: "NEEDS_OCR" | "EMPTY";
    tsError: Error;
    filename?: string;
  }) => void;
}

// ─── 主函数 ──────────────────────────────────────────────────

/**
 * 带 Docling 降级的解析入口。
 *
 * 调用语义：
 *   1. 先走 TS parser（parseFile）
 *   2. TS 成功 → 返回
 *   3. TS 抛 PARSE_NEEDS_OCR / PARSE_EMPTY 且 docling 可用 → 调 Docling
 *      - Docling 成功 → 返回 Docling 的 ParseResult
 *      - Docling 失败 → 重抛 **TS 原始错误**（保留原因，便于用户排查）
 *   4. 其他错误 → 重抛
 *
 * @throws Error TS 或 Docling 抛出的原始错误（降级失败时以 TS 原因为准）
 */
export async function parseWithFallback(
  input: ParserInput,
  options: ParseRouterOptions = {},
): Promise<ParseResult> {
  const { maxPdfPages, docling, onFallback } = options;

  // ── Step 1: 优先尝试 TS 解析 ──
  let tsError: Error | null = null;
  try {
    return await parseFile(input, { maxPdfPages });
  } catch (err) {
    tsError = err instanceof Error ? err : new Error(String(err));
  }

  // ── Step 2: 判断是否可降级 ──
  const code = tsError.message;
  const canFallback = code === "PARSE_NEEDS_OCR" || code === "PARSE_EMPTY";
  if (!canFallback) {
    throw tsError;
  }

  // Docling 未注入 → 直接重抛
  if (!docling) {
    throw tsError;
  }

  // Docling 有 isAvailable 钩子 → 提前短路（避免 healthz 轮询延迟）
  try {
    if (typeof docling.isAvailable === "function") {
      const available = await docling.isAvailable();
      if (!available) {
        throw tsError;
      }
    }
  } catch (err) {
    // isAvailable 抛异常时，语义等价不可用 → 重抛 TS 原错
    if (err === tsError) throw err;
    throw tsError;
  }

  // ── Step 3: 调 Docling 降级 ──
  onFallback?.({
    reason: code === "PARSE_NEEDS_OCR" ? "NEEDS_OCR" : "EMPTY",
    tsError,
    filename: input.filename,
  });

  try {
    return await docling.parse(input);
  } catch {
    // Docling 自己也失败 → 用户需要看到 TS 的原始错误（更可能是真实问题根源）
    // 这里**不抛 Docling 错误**，改抛 TS 错误，保留上游 pipeline 的 status=failed 原因一致性
    throw tsError;
  }
}

// ─── 便捷：探测输入是否"天然需要 Docling" ───────────────────

/**
 * 粗略判断输入是否需要 OCR（不调用任何 parser，仅基于扩展名/MIME）。
 *
 * 当前知识库 Spec 6 格式（text/md/html/pdf/docx/xlsx/pptx）都先走 TS；
 * 此函数为未来"image 格式绕过 TS 直奔 Docling"留口子，当前实现返回 false。
 *
 * 预留接口，router 本身不使用 —— 便于后续 Spec 演进时平滑扩展。
 */
export function shouldBypassTs(_input: ParserInput): boolean {
  return false;
}
