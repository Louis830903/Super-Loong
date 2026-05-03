/**
 * 分块器工具函数（知识库 Spec §5.3 / T3.2）。
 *
 * 核心工具：
 *   - estimateTokens：轻量 token 估算（CJK 1:1、其他 4:1，无外部依赖）
 *   - splitByHeadings：按 Markdown/中文章节标题切段
 *   - slidingWindow：按 token 预算 + overlap 滑窗切块
 *
 * 设计原则：
 *   - 不引入 tiktoken 等重依赖（启动期优先）
 *   - 估算误差 < 20%，用于分块预算已足够；精确 token 计数由 T4 向量化层自行处理
 */

/**
 * 估算 token 数。
 * - CJK 字符（中日韩）：1 字 ≈ 1 token
 * - ASCII / 标点 / 空白：4 字符 ≈ 1 token
 *
 * 经验公式，兼顾速度与精度，参考 OpenAI tiktoken 中文模型经验值。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 中日韩统一表意 + 扩展 A/B + 假名 + 韩文音节
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x20000 && code <= 0x2ebef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/** 判断一行是否是标题（Markdown `#+ ` 或中文「第 X 章/节/回」） */
export function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Markdown heading
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  // 中文章节（第 X 章/节/回，X 允许中文数字 / 阿拉伯数字）
  if (/^第[\s\S]{1,15}(章|节|回|部分|篇)(\s|$|[:：])/.test(trimmed)) return true;
  return false;
}

/**
 * 按标题切段。
 * 每段保留标题行作为首行。无标题时返回单段（原文）。
 */
export function splitByHeadings(text: string): { heading: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; lines: string[] } = { heading: "", lines: [] };

  for (const line of lines) {
    if (isHeadingLine(line)) {
      if (current.heading || current.lines.length > 0) {
        sections.push({ heading: current.heading, body: current.lines.join("\n") });
      }
      current = { heading: line.trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.heading || current.lines.length > 0) {
    sections.push({ heading: current.heading, body: current.lines.join("\n") });
  }
  return sections;
}

/**
 * 取 text 末尾约 n 个 token 对应的字符串（用于 overlap）。
 * 近似实现：按反向字符累加 token 估算值，直到 >= n 为止。
 */
export function takeTailByTokens(text: string, targetTokens: number): string {
  if (targetTokens <= 0 || !text) return "";
  let tokens = 0;
  let i = text.length;
  while (i > 0 && tokens < targetTokens) {
    i--;
    const ch = text[i];
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  // 尽量从换行/句号处切断，避免切断词/句子
  const tail = text.slice(i);
  const cutIdx = tail.search(/[\n。.!?！？]\s*/);
  if (cutIdx >= 0 && cutIdx < tail.length - 1) {
    return tail.slice(cutIdx + 1).trimStart();
  }
  return tail;
}

/**
 * 滑窗切块。
 *
 * 策略：
 *   1. 若 text 的 tokens <= maxTokens，直接返回单块
 *   2. 按段落（\n+）与句子边界（.。!?！？）切出 segments
 *   3. 贪婪打包：累加 segments 到接近 maxTokens 时切出一块
 *   4. 下一块起始追加上一块末尾 overlap tokens 的内容
 *
 * @param text 原始文本
 * @param maxTokens 单块 token 上限
 * @param overlapTokens 相邻块重叠 token 数
 * @returns 块文本数组，每块长度 <= maxTokens（最后一块可能略超边界但受限于最小分段）
 */
export function slidingWindow(text: string, maxTokens: number, overlapTokens: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= maxTokens) return [trimmed];

  // 按段落边界（双换行）/ 单换行 / 句子边界切 segments，保留分隔符
  // 优先按 \n\n 拆大段；若大段仍过长，再按单换行；再过长按句号
  const segments: string[] = [];
  for (const para of trimmed.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    if (estimateTokens(para) <= maxTokens) {
      segments.push(para);
      continue;
    }
    // 大段：按单行切
    for (const line of para.split(/\n/)) {
      if (!line.trim()) continue;
      if (estimateTokens(line) <= maxTokens) {
        segments.push(line);
        continue;
      }
      // 超长单行：按中英句号切
      const sents = line.split(/(?<=[。.!?！？])\s*/).filter((s) => s.trim());
      for (const s of sents) {
        if (estimateTokens(s) <= maxTokens) {
          segments.push(s);
        } else {
          // 极端：超长句按字符硬切
          let remaining = s;
          while (remaining.length > 0) {
            // 粗估：每 token ≈ 2 字符（CJK/ASCII 混合平均）
            const charBudget = maxTokens * 2;
            segments.push(remaining.slice(0, charBudget));
            remaining = remaining.slice(charBudget);
          }
        }
      }
    }
  }

  // 贪婪打包 + overlap
  const out: string[] = [];
  let cur = "";
  let curTokens = 0;
  for (const seg of segments) {
    const st = estimateTokens(seg);
    if (curTokens + st > maxTokens && cur) {
      out.push(cur.trim());
      const overlap = takeTailByTokens(cur, overlapTokens);
      cur = overlap ? overlap + "\n" + seg : seg;
      curTokens = estimateTokens(cur);
    } else {
      cur = cur ? cur + "\n" + seg : seg;
      curTokens += st;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
