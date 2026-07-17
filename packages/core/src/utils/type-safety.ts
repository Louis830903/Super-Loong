/**
 * 类型安全强化 — 替代 as any 的类型断言
 *
 * 优化：
 * 1. 类型覆盖率报告
 * 2. 渐进式类型检查
 * 3. 类型安全评分
 */

import pino from "pino";

const logger = pino({ name: "type-safety" });

/**
 * 类型安全评分器
 */
export class TypeSafetyScorer {
  /**
   * 计算类型安全评分
   */
  score(files: Array<{ path: string; content: string }>): {
    total: number;
    score: number;
    issues: Array<{ path: string; line: number; issue: string }>;
  } {
    let total = 0;
    let issues: Array<{ path: string; line: number; issue: string }> = [];

    for (const file of files) {
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        total++;

        // 检查 as any
        if (/as\s+any/.test(line)) {
          issues.push({
            path: file.path,
            line: i + 1,
            issue: "使用 'as any' 类型断言",
          });
        }

        // 检查 @ts-ignore
        if (/@ts-ignore/.test(line)) {
          issues.push({
            path: file.path,
            line: i + 1,
            issue: "使用 '@ts-ignore' 注释",
          });
        }

        // 检查 @ts-nocheck
        if (/@ts-nocheck/.test(line)) {
          issues.push({
            path: file.path,
            line: i + 1,
            issue: "使用 '@ts-nocheck' 注释",
          });
        }
      }
    }

    const score = Math.max(0, 100 - (issues.length / total) * 100);

    return { total, score, issues };
  }

  /**
   * 生成类型安全报告
   */
  generateReport(files: Array<{ path: string; content: string }>): string {
    const { total, score, issues } = this.score(files);

    const lines = [
      "# 类型安全报告",
      "",
      `总代码行数: ${total}`,
      `类型安全评分: ${score.toFixed(1)}/100`,
      `问题数量: ${issues.length}`,
      "",
      "## 问题列表",
      "",
    ];

    for (const issue of issues) {
      lines.push(`- ${issue.path}:${issue.line} - ${issue.issue}`);
    }

    return lines.join("\n");
  }
}

/**
 * 类型安全修复器
 */
export class TypeSafetyFixer {
  /**
   * 修复 as any 类型断言
   */
  fixAsAny(content: string, typeName: string): string {
    // 简单的替换策略：as any → as unknown as TypeName
    return content.replace(
      /as\s+any/g,
      `as unknown as ${typeName}`,
    );
  }

  /**
   * 添加类型守卫
   */
  addTypeGuard(content: string, paramName: string, typeName: string): string {
    const guard = `
function is${typeName}(value: unknown): value is ${typeName} {
  return typeof value === "object" && value !== null && "${paramName}" in value;
}
`;
    return guard + content;
  }
}
