/**
 * 协作模块共享工具函数（B3 上帝文件拆分 — 从 orchestrator.ts 提取）。
 *
 * 包含：
 *   - withTimeout: 异步操作超时保护（参考 sandbox.ts Promise.race 模式）
 *   - extractJsonArray: LLM 输出 JSON 数组多级提取（CrewExecutor 专用，内部调用）
 *   - deduplicateAttachments: 附件去重（CrewExecutor + CollaborationOrchestrator 共用）
 *   - stripBase64FromAttachments: 附件 base64 瘦身（SSE 传输优化）
 */

import type { Attachment } from "../types/index.js";

// ─── 超时防护工具函数（参考 sandbox.ts Promise.race 模式） ────

/** 为异步操作添加超时保护，防止 LLM 无响应时协作永久挂起 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── F-4: JSON 数组多级提取（替代单一正则，更鲁棒地处理 LLM 输出） ───

/** 从 LLM 输出中提取 JSON 字符串数组。策略：直接解析 > 贪婪匹配最后一个数组 */
export function extractJsonArray(text: string): string[] | null {
  // 策略1：直接 JSON.parse 整个响应
  try {
    const arr = JSON.parse(text.trim());
    if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) return arr;
  } catch { /* 继续下一策略 */ }

  // 策略2：提取所有 JSON 数组，优先取最后一个（通常是最终答案）
  const matches = [...text.matchAll(/\[[\s\S]*?\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse(matches[i][0]);
      if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) return arr;
    } catch { /* 跳过无效匹配 */ }
  }

  return null;
}

// ─── 附件辅助纯函数 ─────────────────────────────────────────

/**
 * S-2 修复：按 path/url/filename 去重附件列表（同一文件只保留第一次出现）。
 * 无标识附件（path/url/filename 全为空，如纯 base64）无法判定重复，一律保留。
 */
export function deduplicateAttachments(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  return attachments.filter(att => {
    const key = att.path ?? att.url ?? att.filename ?? "";
    if (!key) return true;  // 无标识的附件一律保留（如纯 base64）
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 从附件中剥离 base64 数据，只保留元数据。
 * 用于持久化和 SSE 事件传输，避免载荷膨胀。
 * 返回新数组（不修改原始对象），符合低耦合纯函数原则。
 */
export function stripBase64FromAttachments(attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map(({ base64, ...rest }) => rest);
}
