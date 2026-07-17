/**
 * 工具缺口检测器 — 从失败案例中识别需要的新工具
 *
 * 分析交互案例，识别工具使用失败模式，推断需要的新工具
 */

import type { InteractionCase } from "./engine.js";
import type { ToolRequirement } from "./tool-generator.js";

export interface ToolGap {
  description: string;
  category: "filesystem" | "code" | "web" | "system" | "data" | "media" | "productivity";
  toolName: string;
  expectedParams: Record<string, "string" | "number" | "boolean" | "array">;
  confidence: number;
  basedOnCases: string[];
}

export class ToolGapDetector {
  /**
   * 检测工具缺口
   */
  detect(cases: InteractionCase[]): ToolGap | null {
    // 筛选工具相关失败案例
    const toolFailures = cases.filter(c =>
      c.failureCategory === "wrong_tool" || c.failureCategory === "skill_gap"
    );

    if (toolFailures.length < 3) {
      return null; // 样本不足
    }

    // 分析失败模式
    const patterns = this.analyzePatterns(toolFailures);
    if (!patterns) {
      return null;
    }

    // 生成工具需求
    return {
      description: patterns.description,
      category: patterns.category,
      toolName: patterns.toolName,
      expectedParams: patterns.expectedParams,
      confidence: patterns.confidence,
      basedOnCases: toolFailures.map(c => c.id),
    };
  }

  private analyzePatterns(cases: InteractionCase[]): {
    description: string;
    category: ToolGap["category"];
    toolName: string;
    expectedParams: ToolGap["expectedParams"];
    confidence: number;
  } | null {
    // 提取用户消息中的关键词
    const keywords = cases.flatMap(c =>
      c.userMessage.toLowerCase().split(/\s+/)
    );

    // 统计高频关键词
    const freq = new Map<string, number>();
    for (const kw of keywords) {
      if (kw.length > 2) {
        freq.set(kw, (freq.get(kw) ?? 0) + 1);
      }
    }

    // 识别工具类型
    const topKeywords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([kw]) => kw);

    // 根据关键词推断工具类型
    const category = this.inferCategory(topKeywords);
    if (!category) {
      return null;
    }

    // 生成工具名称
    const toolName = this.generateToolName(topKeywords, category);

    // 推断参数
    const expectedParams = this.inferParams(cases);

    return {
      description: `自动生成的 ${category} 工具，用于处理：${topKeywords.join(", ")}`,
      category,
      toolName,
      expectedParams,
      confidence: Math.min(0.9, cases.length / 10),
    };
  }

  private inferCategory(keywords: string[]): ToolGap["category"] | null {
    const categoryMap: Record<string, ToolGap["category"]> = {
      file: "filesystem",
      read: "filesystem",
      write: "filesystem",
      code: "code",
      run: "code",
      execute: "code",
      web: "web",
      http: "web",
      fetch: "web",
      data: "data",
      excel: "data",
      csv: "data",
      image: "media",
      video: "media",
      pdf: "media",
      time: "system",
      date: "system",
    };

    for (const kw of keywords) {
      if (categoryMap[kw]) {
        return categoryMap[kw];
      }
    }

    return null;
  }

  private generateToolName(keywords: string[], category: string): string {
    const prefix = category === "filesystem" ? "file" :
      category === "code" ? "code" :
      category === "web" ? "web" :
      category === "data" ? "data" :
      category === "media" ? "media" : "tool";

    const suffix = keywords[0] ?? "helper";
    return `${prefix}_${suffix}`.replace(/[^a-z0-9_]/g, "_");
  }

  private inferParams(cases: InteractionCase[]): ToolGap["expectedParams"] {
    // 简单推断：从用户消息中提取可能的参数
    const params: ToolGap["expectedParams"] = {};

    // 检查是否包含文件路径
    if (cases.some(c => c.userMessage.includes("/") || c.userMessage.includes("\\"))) {
      params.path = "string";
    }

    // 检查是否包含 URL
    if (cases.some(c => c.userMessage.includes("http"))) {
      params.url = "string";
    }

    // 检查是否包含数字
    if (cases.some(c => /\d+/.test(c.userMessage))) {
      params.count = "number";
    }

    return params;
  }
}
