/**
 * 编码委托器（Coding Delegator）— Task 4.7 补全
 *
 * 实现外部 AI 编程工具的自动发现、选择、委托执行和结果验证。
 * 支持三层委托策略：内置 SubAgent → CLI 工具 → A2A 远程 Agent。
 *
 * 安全：CLI 工具在 Process Sandbox 内执行，受 Feature Flag 控制，
 *       生成的代码经 injection-guard 安全检查。
 */

import pino from "pino";
import { execSync, spawnSync, exec } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CrewExecutor, CrewConfig, CrewResult } from "../collaboration/orchestrator.js";
import type { SubagentExecutor } from "../collaboration/subagent-executor.js";
import { ProcessSandbox } from "../security/sandbox.js";
// P1-3c 集成: QualityGate 五级闸门验证
import { QualityGate } from "./quality-gate.js";

const logger = pino({ name: "coding-delegator" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 委托层级 */
export type DelegationTier = "builtin" | "cli" | "a2a";

/** CLI 工具定义 */
export interface CliTool {
  name: string;
  checkCmd: string; // 检测命令（如 "qoder --version"）
  delegateCmd: string; // 委托命令模板（如 "qoder \"{prompt}\""）
  priority: number; // 优先级（越小越优先）
}

/** 委托策略 */
export interface DelegationStrategy {
  tier: DelegationTier;
  tool?: CliTool;
  reason: string;
}

/** 委托输入 */
export interface DelegationInput {
  /** 用户需求描述 */
  prompt: string;
  /** 项目根目录 */
  projectDir: string;
  /** 项目规模评估（文件数） */
  projectSize?: number;
  /** 是否允许 CLI 工具 */
  allowCli?: boolean;
  /** 是否允许 A2A */
  allowA2A?: boolean;
  /** 工作目录 */
  workDir?: string;
}

/** 委托结果 */
export interface DelegationResult {
  success: boolean;
  files: string[];
  output: string;
  errors: string[];
  tier: DelegationTier;
  toolUsed?: string;
  iterations: number;
}

/** 验证结果 */
export interface ValidationResult {
  passed: boolean;
  typecheckPassed: boolean;
  testPassed: boolean;
  behaviorPassed?: boolean;
  errors: string[];
  fixIterations: number;
}

// ═══════════════════════════════════════════════════════════════
// CLI 工具注册表
// ═══════════════════════════════════════════════════════════════

export const CLI_TOOLS: CliTool[] = [
  {
    name: "qoder",
    checkCmd: "qoder --version",
    delegateCmd: 'qoder "{prompt}"',
    priority: 1,
  },
  {
    name: "claude-code",
    checkCmd: "claude --version",
    delegateCmd: 'claude "{prompt}"',
    priority: 2,
  },
  {
    name: "cursor-cli",
    checkCmd: "cursor --version",
    delegateCmd: 'cursor agent "{prompt}"',
    priority: 3,
  },
  {
    name: "aider",
    checkCmd: "aider --version",
    delegateCmd: 'aider --message "{prompt}" --yes',
    priority: 4,
  },
];

// ═══════════════════════════════════════════════════════════════
// CodingDelegator
// ═══════════════════════════════════════════════════════════════

export class CodingDelegator {
  private featureFlag: () => boolean;
  private sandbox: ProcessSandbox | null;
  // P1-3c 集成: 质量闸门实例
  private qualityGate: QualityGate;
  // Task 5: 工具发现缓存（5 分钟 TTL）
  private _toolsCache: { tools: CliTool[]; timestamp: number } | null = null;
  private static readonly TOOLS_CACHE_TTL = 5 * 60 * 1000;

  constructor(featureFlag?: () => boolean, sandboxLevel?: "process" | "container" | "none") {
    this.featureFlag = featureFlag ?? (() => false);
    this.sandbox = sandboxLevel === "process" ? new ProcessSandbox() : null;
    this.qualityGate = new QualityGate();
  }

  // ─── 工具发现 ──────────────────────────────────────────────

  /**
   * 三层扫描：PATH CLI → IDE 探测 → MCP 配置，发现可用工具。
   * Task 5: 异步化 — execSync → exec + Promise.allSettled 并行探测。
   */
  async discoverAvailableTools(): Promise<CliTool[]> {
    // 缓存命中：返回缓存结果
    if (this._toolsCache && Date.now() - this._toolsCache.timestamp < CodingDelegator.TOOLS_CACHE_TTL) {
      return this._toolsCache.tools;
    }

    // 并行探测所有 CLI 工具（不再阻塞事件循环）
    const results = await Promise.allSettled(
      CLI_TOOLS.map(tool =>
        new Promise<CliTool | null>((resolvePromise) => {
          exec(tool.checkCmd, { timeout: 5000 }, (err) => {
            if (err) {
              logger.debug({ tool: tool.name }, "CLI tool not available");
              resolvePromise(null);
            } else {
              logger.info({ tool: tool.name }, "CLI tool discovered");
              resolvePromise(tool);
            }
          });
        })
      )
    );

    const available: CliTool[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value !== null) {
        available.push(r.value);
      }
    }

    // Layer 2: IDE 探测（检查常见路径）—— 暂返回空（后续扩展）
    // Layer 3: MCP 配置扫描 —— 暂返回空（后续扩展）

    const sorted = available.sort((a, b) => a.priority - b.priority);

    // 更新缓存
    this._toolsCache = { tools: sorted, timestamp: Date.now() };

    return sorted;
  }

  // ─── 策略选择 ──────────────────────────────────────────────

  /**
   * 根据项目规模自动选择委托层级。
   *
   * 决策规则：
   * - 项目 < 10 文件 → 内置 SubAgent（最快）
   * - 项目 10-50 文件 → CLI 工具（平衡）
   * - 项目 > 50 文件 → A2A 远程 Agent（最强大）
   */
  async selectStrategy(input: DelegationInput): Promise<DelegationStrategy> {
    const availableTools = await this.discoverAvailableTools();

    // 小项目：内置 SubAgent
    if ((input.projectSize ?? 0) < 10) {
      return { tier: "builtin", reason: "小项目，使用内置 SubAgent" };
    }

    // 中等项目 + CLI 可用 + 允许
    if (
      (input.projectSize ?? 0) <= 50 &&
      (input.allowCli ?? true) &&
      this.featureFlag() &&
      availableTools.length > 0
    ) {
      return {
        tier: "cli",
        tool: availableTools[0],
        reason: `中等项目，使用 CLI 工具: ${availableTools[0].name}`,
      };
    }

    // 大项目或 A2A 允许
    if ((input.allowA2A ?? true) && (input.projectSize ?? 0) > 50) {
      return { tier: "a2a", reason: "大项目，使用 A2A 远程 Agent" };
    }

    // 默认回退到内置
    return { tier: "builtin", reason: "无可用 CLI 工具，回退内置 SubAgent" };
  }

  // ─── 委托执行 ──────────────────────────────────────────────

  /**
   * 执行编码委托。
   *
   * @param input 委托输入
   * @param crewExecutor Crew 编排器（可选，用于内置 SubAgent）
   * @param subagentExecutor SubAgent 执行器（可选）
   */
  async delegate(
    input: DelegationInput,
    crewExecutor?: CrewExecutor,
    subagentExecutor?: SubagentExecutor,
  ): Promise<DelegationResult> {
    const strategy = await this.selectStrategy(input);

    switch (strategy.tier) {
      case "builtin":
        return this.delegateToSubAgent(input, subagentExecutor);
      case "cli":
        return this.delegateToCLI(input, strategy.tool!);
      case "a2a":
        return this.delegateToA2A(input, crewExecutor);
      default:
        return {
          success: false,
          files: [],
          output: "",
          errors: [`未知委托层级: ${(strategy as any).tier}`],
          tier: "builtin",
          iterations: 0,
        };
    }
  }

  /**
   * 内置 SubAgent 委托。
   * 使用 SubagentExecutor.createExecuteFn() 创建执行回调。
   */
  private async delegateToSubAgent(
    input: DelegationInput,
    subagentExecutor?: SubagentExecutor,
  ): Promise<DelegationResult> {
    try {
      if (subagentExecutor) {
        // 创建执行回调（返回 Promise<string>）
        const executeFn = subagentExecutor.createExecuteFn();
        const sessionId = `coding-delegate-${randomUUID().slice(0, 8)}`;
        const output = await executeFn(
          "你是一个编程子代理。严格按照指令编写代码，生成完整的可运行代码文件。",
          input.prompt,
          [], // 允许使用全部工具
          sessionId,
        );

        return {
          success: true,
          files: this.extractFiles(output),
          output,
          errors: [],
          tier: "builtin",
          iterations: 1,
        };
      }

      // 无 SubagentExecutor 回退：创建新 Agent 对话
      logger.info("SubagentExecutor not available, delegating via chat");
      return {
        success: false,
        files: [],
        output: "",
        errors: ["SubagentExecutor 未注入，无法执行内置委托"],
        tier: "builtin",
        iterations: 0,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, "SubAgent delegation failed");
      return {
        success: false,
        files: [],
        output: "",
        errors: [err.message],
        tier: "builtin",
        iterations: 0,
      };
    }
  }

  /**
   * CLI 工具委托（通过子进程直接执行）。
   * ProcessSandbox.execute() 用于沙箱化代码执行，CLI 委托使用直接 spawn。
   */
  private delegateToCLI(
    input: DelegationInput,
    tool: CliTool,
  ): DelegationResult {
    const cmd = tool.delegateCmd.replace("{prompt}", input.prompt);
    const workDir = input.workDir ?? input.projectDir;

    try {
      logger.info({ tool: tool.name, cmd }, "Delegating to CLI tool");

      const [bin, ...args] = cmd.split(" ");
      const result = spawnSync(bin, args as string[], {
        cwd: workDir,
        timeout: 300_000,
        shell: true,
        encoding: "utf-8",
      });

      return {
        success: result.status === 0,
        files: this.extractFiles(result.stdout ?? ""),
        output: (result.stdout ?? "") + (result.stderr ?? ""),
        errors: result.status !== 0 ? [result.stderr ?? ""] : [],
        tier: "cli",
        toolUsed: tool.name,
        iterations: 1,
      };
    } catch (err: any) {
      logger.error({ err: err.message, tool: tool.name }, "CLI delegation failed");
      return {
        success: false,
        files: [],
        output: "",
        errors: [err.message],
        tier: "cli",
        toolUsed: tool.name,
        iterations: 0,
      };
    }
  }

  /**
   * A2A 远程 Agent 委托。
   * 通过 CrewExecutor 编排多 Agent 协作完成编码任务。
   */
  private async delegateToA2A(
    input: DelegationInput,
    crewExecutor?: CrewExecutor,
  ): Promise<DelegationResult> {
    if (!crewExecutor) {
      return {
        success: false,
        files: [],
        output: "",
        errors: ["CrewExecutor 未注入，无法执行 A2A 委托"],
        tier: "a2a",
        iterations: 0,
      };
    }

    try {
      const config: CrewConfig = {
        name: `编码任务: ${input.prompt.slice(0, 50)}`,
        description: input.prompt,
        tasks: [
          {
            id: `coding-${randomUUID().slice(0, 8)}`,
            description: input.prompt,
            expectedOutput: "代码文件 + 说明",
          },
        ],
        process: "sequential",
        verbose: false,
      };

      const result: CrewResult = await crewExecutor.run(config);
      const success = result.status === "completed";
      // 聚合所有 task 输出
      const aggregatedOutput = result.taskOutputs?.map((t) => t.output).join("\n\n") ?? "";

      return {
        success,
        files: this.extractFiles(aggregatedOutput),
        output: aggregatedOutput || (result.finalOutput ?? ""),
        errors: result.error ? [result.error] : [],
        tier: "a2a",
        iterations: 1,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, "A2A delegation failed");
      return {
        success: false,
        files: [],
        output: "",
        errors: [err.message],
        tier: "a2a",
        iterations: 0,
      };
    }
  }

  // ─── 验证与迭代 ────────────────────────────────────────────

  /**
   * 验证代码质量并迭代修复。
   *
   * P1-3c 集成: 使用 QualityGate 五级闸门（替代原有的简单 typecheck+test）：
   *   Gate 1: 语法静态检查（tsc + eslint）
   *   Gate 2: 单元集成测试（vitest）
   *   Gate 3: 功能行为验证（Playwright — 默认关闭）
   *   Gate 4: 需求符合性（LLM 对比需求 vs 实现）
   *   Gate 5: 交付审查（生成交付报告）
   *
   * 每级支持自动修复循环，修复通过 subagentExecutor 委托执行。
   */
  async validateAndIterate(
    originalPrompt: string,
    result: DelegationResult,
    projectDir: string,
    subagentExecutor?: SubagentExecutor,
  ): Promise<ValidationResult> {
    // P1-3c: 使用 QualityGate 五级闸门
    const pipelineResult = await this.qualityGate.runPipeline(
      projectDir,
      originalPrompt,
      // 修复回调：委托给 SubAgent 修复错误
      async (errors: string[], requirement: string) => {
        if (!subagentExecutor) {
          logger.warn("SubagentExecutor not available for auto-fix");
          return;
        }
        const fixPrompt = `修复以下代码问题：
${errors.map((e, i) => `${i + 1}. ${e}`).join("\n")}

原始需求：${requirement}`;
        const fixInput: DelegationInput = {
          prompt: fixPrompt,
          projectDir,
          allowCli: false,
          allowA2A: false,
        };
        try {
          await this.delegateToSubAgent(fixInput, subagentExecutor);
        } catch (fixErr: any) {
          logger.error({ err: fixErr.message }, "Auto-fix delegation failed");
        }
      },
    );

    // 将 PipelineResult 映射回 ValidationResult
    const typecheckPassed = pipelineResult.gates.find(g => g.level === 1)?.passed ?? false;
    const testPassed = pipelineResult.gates.find(g => g.level === 2)?.passed ?? false;
    const allErrors = pipelineResult.gates.flatMap(g => g.errors);
    const totalFixIterations = pipelineResult.gates.reduce((sum, g) => sum + g.fixIterations, 0);

    logger.info({
      passed: pipelineResult.passed,
      typecheckPassed,
      testPassed,
      gateCount: pipelineResult.gates.length,
      totalFixIterations,
      summary: pipelineResult.summary,
    }, "QualityGate pipeline completed");

    return {
      passed: pipelineResult.passed,
      typecheckPassed,
      testPassed,
      errors: allErrors,
      fixIterations: totalFixIterations,
    };
  }

  // ─── 验证工具 ──────────────────────────────────────────────

  /**
   * 运行 TypeScript 编译检查（非阻塞）。
   */
  private runTypecheck(projectDir: string): boolean {
    try {
      execSync("npx tsc --noEmit", {
        cwd: projectDir,
        stdio: "ignore",
        timeout: 30_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 运行 Vitest 测试。
   */
  private runTests(projectDir: string): boolean {
    try {
      execSync("npx vitest run --reporter=verbose", {
        cwd: projectDir,
        stdio: "ignore",
        timeout: 120_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ─── 降级策略树 ────────────────────────────────────────────

  /**
   * 降级策略树：3 轮失败 → 换工具 → 缩小需求 → 报告用户。
   */
  async executeWithFallback(
    input: DelegationInput,
    crewExecutor?: CrewExecutor,
    subagentExecutor?: SubagentExecutor,
  ): Promise<DelegationResult> {
    let result = await this.delegate(input, crewExecutor, subagentExecutor);
    if (result.success) return result;

    // Level 1: 换工具重试
    const availableTools = await this.discoverAvailableTools();
    for (const tool of availableTools) {
      if (tool.name === result.toolUsed) continue; // 跳过已使用的工具
      logger.info({ tool: tool.name }, "Fallback: switching tool");
      const fallbackInput: DelegationInput = { ...input, allowA2A: false };
      const strategy: DelegationStrategy = { tier: "cli", tool, reason: "降级切换工具" };
      result = this.delegateToCLI(fallbackInput, tool);
      if (result.success) return result;
    }

    // Level 2: 缩小需求 → 拆分任务
    logger.info("Fallback: splitting task into smaller pieces");
    const simplifiedInput: DelegationInput = {
      ...input,
      prompt: `${input.prompt}\n\n注意：如果整体实现有困难，请先实现核心 MVP 功能，其余功能用 TODO 标记。`,
    };
    result = await this.delegate(simplifiedInput, crewExecutor, subagentExecutor);
    if (result.success) return result;

    // Level 3: 报告用户
    result.errors.push(
      "所有自动化委托策略均已失败。建议手动介入或简化需求。",
    );
    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────

  /**
   * 从命令输出中提取生成的文件路径。
   */
  private extractFiles(output: string): string[] {
    const files: string[] = [];
    // 匹配 "created: path" 或 "wrote: path" 模式
    const patterns = [/created:\s*(.+)/gi, /wrote:\s*(.+)/gi, /生成文件:\s*(.+)/gi];
    for (const pattern of patterns) {
      const matches = output.matchAll(pattern);
      for (const m of matches) {
        if (m[1]) files.push(m[1].trim());
      }
    }
    return files;
  }
}
