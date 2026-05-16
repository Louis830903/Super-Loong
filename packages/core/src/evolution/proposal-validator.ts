/**
 * Proposal Validator — 提案验证独立模块
 *
 * 从 engine.ts 提取：
 * - quickContentScan: 快速内容威胁扫描（纯函数）
 * - validateProposal: 应用前验证（完整性检查 + 安全扫描 + 风险评分）
 * - scoreProposal: 提案质量评分
 */

import type { SkillProposal } from "./engine.js";
import type { RiskEngine } from "./risk-engine.js";
import { parseSkillFile } from "../skills/parser.js";
import pino from "pino";

const validatorLogger = pino({ name: "evolution-validator" });

/**
 * 快速内容威胁扫描（纯文本模式，不需要目录）
 * 检查关键威胁模式: rm -rf、反向 shell、curl|bash 等
 */
export function quickContentScan(content: string): string {
  const criticalPatterns = [
    /\brm\s+-rf\s+\/|\brm\s+-rf\s+~/i,
    /\b(nc|ncat|netcat)\b.*-[elp]|\bbash\s+-i\s+>&\s*\/dev\/tcp/i,
    /curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh/i,
    /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i,
    /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
    /\bxmrig\b|\bcpuminer\b|stratum\+tcp:\/\//i,
  ];

  const highPatterns = [
    /\bsudo\b\s+(?!-l\b)/,
    /\.bashrc|\.bash_profile|\.zshrc/i,
    /\beval\b\s*\(/i,
    /base64\s+-d\s*\|/i,
  ];

  for (const line of content.split("\n")) {
    for (const p of criticalPatterns) {
      if (p.test(line)) return "dangerous";
    }
  }

  for (const line of content.split("\n")) {
    for (const p of highPatterns) {
      if (p.test(line)) return "caution";
    }
  }

  return "safe";
}

/**
 * 应用前验证 — 检查提案内容的完整性和安全性
 * 对标 Hermes 安装策略矩阵 + OpenClaw eligibility 评估
 */
export function validateProposal(
  proposal: SkillProposal,
  riskEngine: RiskEngine,
  emit?: (event: string, data: unknown) => void,
): { valid: boolean; errors: string[]; scanVerdict?: string } {
  const errors: string[] = [];

  // 1. 完整性检查: name + description 必须存在
  if (!proposal.skillName || proposal.skillName.trim().length === 0) {
    errors.push("Missing skill name");
  }
  if (!proposal.description || proposal.description.trim().length === 0) {
    errors.push("Missing skill description");
  }
  if (!proposal.content || proposal.content.trim().length === 0) {
    errors.push("Empty skill content");
  }

  // 2. 内容安全扫描: 调用 guard.scanSkill 检查威胁模式
  let scanVerdict: string | undefined;
  try {
    // 为了扫描内容，构造临时的 YAML frontmatter + content
    const tempContent = [
      "---",
      `name: ${proposal.skillName}`,
      `description: ${proposal.description}`,
      `version: "1.0.0"`,
      "---",
      "",
      proposal.content,
    ].join("\n");

    // 尝试解析 frontmatter 确保有效
    const parsed = parseSkillFile(tempContent);
    if (!parsed.frontmatter.name) {
      errors.push("Frontmatter parsing failed: no name");
    }

    // 内容威胁扫描（纯文本模式——不需要实际目录）
    scanVerdict = quickContentScan(proposal.content);
    if (scanVerdict === "dangerous") {
      errors.push(`Security scan: dangerous content detected`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    validatorLogger.debug({ err: message }, "Proposal content parse warning");
  }

  // 3. Task 1.1: 风险评分引擎
  const fixType = proposal.action === "patch" ? "patch" : "heal";
  const riskResult = riskEngine.score(proposal.skillName, proposal.description, fixType);
  proposal.riskScore = riskResult.score;
  proposal.riskDecision = riskResult.decision;

  // escalate 级别自动拒绝
  if (riskResult.decision === "escalate") {
    errors.push(`Risk escalated: score=${riskResult.score}, profile=${riskResult.profile}`);
    proposal.status = "rejected";
    emit?.("proposal:escalated", { ...proposal, riskResult });
    validatorLogger.warn({ proposalId: proposal.id, riskResult }, "Proposal escalated and auto-rejected");
  }

  return { valid: errors.length === 0, errors, scanVerdict };
}

/**
 * 计算提案质量评分 (Spec v3 Task 8)
 * 基于内容完整性、描述质量、安全性等因素
 */
export function scoreProposal(proposal: SkillProposal): number {
  let score = 50; // 基准分

  // +20: 有完整的 name + description
  if (proposal.skillName && proposal.skillName.length > 2) score += 10;
  if (proposal.description && proposal.description.length > 10) score += 10;

  // +15: 内容长度合理 (50-5000 字符)
  const len = proposal.content?.length ?? 0;
  if (len >= 50 && len <= 5000) score += 15;
  else if (len > 5000) score += 5; // 太长扣分
  else score -= 10; // 太短扣分

  // +15: 有推理理由
  if (proposal.reasoning && proposal.reasoning.length > 20) score += 15;

  // -30: 安全扫描危险
  const verdict = quickContentScan(proposal.content ?? "");
  if (verdict === "dangerous") score -= 30;
  else if (verdict === "caution") score -= 10;

  // +10: 基于实际失败案例
  if (proposal.basedOnCases && proposal.basedOnCases.length > 0) score += 10;

  // 限制在 0-100
  return Math.max(0, Math.min(100, score));
}
