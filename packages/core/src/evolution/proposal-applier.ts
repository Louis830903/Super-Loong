/**
 * Proposal Applier — 提案应用独立模块
 *
 * 从 engine.ts 提取：
 * - applyProposal: 技能文件提案应用（写入 .md 文件）
 * - applyCodeProposal: 代码级提案应用（沙箱 + 自修改引擎 + 人工审核）
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { SkillProposal } from "./engine.js";
import type { EvolutionBudget } from "./evolution-budget.js";
import type { EvolutionLock } from "./evolution-lock.js";
import type { SandboxExecutor } from "./sandbox-executor.js";
import type { SelfModificationEngine } from "./self-modification-engine.js";

const applierLogger = pino({ name: "evolution-applier" });

/**
 * applyProposal / applyCodeProposal 所需的引擎上下文
 */
export interface ApplierContext {
  proposals: Map<string, SkillProposal>;
  skillsDir: string;
  budget: EvolutionBudget;
  evoLock: EvolutionLock;
  sandbox: SandboxExecutor;
  selfModification: SelfModificationEngine;
  validateProposal: (proposal: SkillProposal) => { valid: boolean; errors: string[]; scanVerdict?: string };
  emit: (event: string, data: unknown) => void;
  takeSnapshot: () => void;
  incrementAppliedCount: () => number;
  AUTO_SNAPSHOT_INTERVAL: number;
}

/**
 * 应用技能文件提案 — 写入 .md 文件到 skillsDir
 */
export async function applyProposal(
  proposalId: string,
  ctx: ApplierContext,
): Promise<SkillProposal | null> {
  const p = ctx.proposals.get(proposalId);
  if (!p) return null;
  if (p.status === "applied") return p;

  // 源码级提案委托到 applyCodeProposal（沙箱 + 自修改引擎 + 人工审核）
  if (p.targetCode) {
    return applyCodeProposal(proposalId, ctx);
  }

  // Spec v3 Task 8: 应用前验证
  const validation = ctx.validateProposal(p);
  p.validationResult = validation;
  if (!validation.valid) {
    p.status = "rejected";
    ctx.emit("proposal:rejected", { ...p, reason: "validation_failed", errors: validation.errors });
    applierLogger.warn({ proposalId, errors: validation.errors }, "Proposal rejected by validation");
    return p;
  }

  // Spec v3 Task 8: 质量评分门槛检查
  if (p.qualityScore !== undefined && p.qualityScore < 40) {
    p.status = "rejected";
    ctx.emit("proposal:rejected", { ...p, reason: "low_quality", score: p.qualityScore });
    applierLogger.warn({ proposalId, score: p.qualityScore }, "Proposal rejected: quality score too low");
    return p;
  }

  try {
    // Task 1.4: 文件修改配额检查
    const fileCheck = ctx.budget.recordFileModification();
    if (fileCheck.blocked) {
      applierLogger.warn({ proposalId, reason: fileCheck.reason }, "File modification blocked by budget");
      return null;
    }

    // Ensure skills directory exists
    if (!existsSync(ctx.skillsDir)) {
      mkdirSync(ctx.skillsDir, { recursive: true });
    }

    const safeName = p.skillName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = join(ctx.skillsDir, `${safeName}.md`);

    if (p.action === "patch" && p.patchOperations?.length && existsSync(filePath)) {
      // Phase B-3: Patch 模式——增量修改（学 Hermes _patch_skill）
      let content = readFileSync(filePath, "utf-8");
      for (const op of p.patchOperations) {
        if (!content.includes(op.oldString)) {
          applierLogger.warn(
            { skillName: p.skillName, oldString: op.oldString.slice(0, 50) },
            "Patch target not found in skill file",
          );
          continue;
        }
        content = content.split(op.oldString).join(op.newString); // P3-T1: 全局替换
      }
      writeFileSync(filePath, content, "utf-8");
    } else {
      // Create / Update 模式：全量写入
      const frontmatterLines = [
        "---",
        `name: ${p.skillName}`,
        `description: ${p.description}`,
        `version: "1.0.0"`,
        `generated_by: evolution_engine`,
        `action: ${p.action}`,
        `created_at: ${p.createdAt.toISOString()}`,
        `applied_at: ${new Date().toISOString()}`,
      ];
      if (p.skillType) {
        frontmatterLines.push(`category: ${p.skillType}`);
      }
      const fileContent = [
        ...frontmatterLines,
        "---",
        "",
        p.content,
        "",
      ].join("\n");
      writeFileSync(filePath, fileContent, "utf-8");
    }

    p.status = "applied";
    ctx.emit("proposal:applied", { ...p, filePath });
    ctx.emit("skill:changed", { skillName: p.skillName, action: p.action });

    // C-3: 自动快照（每应用 N 个提案后自动创建快照）
    const count = ctx.incrementAppliedCount();
    if (count >= ctx.AUTO_SNAPSHOT_INTERVAL) {
      ctx.takeSnapshot();
    }

    applierLogger.info({ proposalId, skillName: p.skillName, action: p.action, filePath }, "Skill proposal applied");
    return p;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    applierLogger.error({ proposalId, error: message }, "Failed to apply skill proposal");
    return null;
  }
}

/**
 * 应用代码级提案（对标 Gödel action_adjust_logic）
 *
 * 安全流程：scanContent → adjustLogic → verifyCompile → 失败自动 rollback
 */
export async function applyCodeProposal(
  proposalId: string,
  ctx: ApplierContext,
): Promise<SkillProposal | null> {
  const p = ctx.proposals.get(proposalId);
  if (!p?.targetCode) return null;
  if (p.status === "applied") return p;

  // 人工审核闸门——所有操作类型必须人工审核
  if (!p.requiresHumanReview && p.status !== "approved") {
    p.requiresHumanReview = true;
    const opLabel =
      { modify: "modification", add: "addition", delete: "deletion" }[p.targetCode.operation] ?? "change";
    p.reviewReason = `Code ${opLabel} proposals require human review before application`;

    // P2-T16: delete 额外审计增强
    if (p.targetCode.operation === "delete") {
      const deletedContent = ctx.selfModification.readLogic(
        p.targetCode.modulePath,
        p.targetCode.targetName,
      );
      p.targetCode.auditSnapshot = deletedContent;
      applierLogger.info(
        { proposalId, targetName: p.targetCode.targetName },
        "Delete proposal: captured original source for audit",
      );
    }

    ctx.emit("proposal:needs_review", { proposalId, reason: p.reviewReason });
    applierLogger.info(
      { proposalId, operation: p.targetCode.operation },
      "Code proposal flagged for human review",
    );
    return p;
  }

  // 进化锁保护
  const result = await ctx.evoLock.withLock(async () => {
    // 沙箱安全扫描（防御第一层）
    if (p.targetCode!.operation !== "delete") {
      const scanResult = ctx.sandbox.scanContent(p.targetCode!.newCode);
      if (!scanResult.passed) {
        applierLogger.warn({ proposalId, errors: scanResult.errors }, "Sandbox scan failed");
        p.status = "rejected";
        return null;
      }
    }

    // 执行源码修改（写入 + 自动快照）
    const changeResult = ctx.selfModification.adjustLogic({
      modulePath: p.targetCode!.modulePath,
      targetName: p.targetCode!.targetName,
      newCode: p.targetCode!.newCode,
      operation: p.targetCode!.operation,
      proposalId: p.id,
    });

    if (!changeResult.success) {
      applierLogger.warn({ proposalId, error: changeResult.error }, "Code modification failed");
      return null;
    }

    // 编译验证
    const compileCheck = await ctx.sandbox.verifyCompile(changeResult.filePath!);
    if (!compileCheck.passed) {
      applierLogger.warn(
        { proposalId, errors: compileCheck.errors },
        "Code proposal failed compile verification, auto-rolling back",
      );
      ctx.selfModification.rollback(
        p.targetCode!.modulePath,
        p.targetCode!.targetName,
        changeResult.snapshotId,
      );
      p.status = "rejected";
      return null;
    }

    p.status = "applied";
    ctx.emit("proposal:code_applied", { ...p, snapshotId: changeResult.snapshotId });
    applierLogger.info(
      { proposalId, operation: p.targetCode!.operation, modulePath: p.targetCode!.modulePath },
      "Code proposal applied and compile-verified",
    );
    return p;
  }, `proposal_${proposalId}`);

  return result;
}
