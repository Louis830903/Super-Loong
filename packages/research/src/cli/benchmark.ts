#!/usr/bin/env node
/**
 * T4.5 — 评估基准 CLI 命令
 *
 * 用法：
 *   npx tsx src/cli/benchmark.ts --dataset bfcl --max-tasks 50
 *   npx tsx src/cli/benchmark.ts --dataset gaia --difficulty 1 --max-tasks 50
 *   npx tsx src/cli/benchmark.ts --dataset toolbench --max-tasks 30
 *
 * 参数：
 *   --dataset      数据集名称：bfcl | gaia | toolbench（必填）
 *   --version      数据集版本，默认 "v1"
 *   --difficulty    难度等级 1/2/3，仅 GAIA 有效
 *   --max-tasks    最大任务数，默认 50
 *   --cache-dir    缓存目录，默认 ~/.super-agent/benchmark-cache
 *   --output       输出报告路径，默认 stdout
 *   --judges       评判器列表（逗号分隔），默认 exact_match
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { BFCLLoader } from "../datasets/bfcl-loader.js";
import { GAIALoader } from "../datasets/gaia-loader.js";
import { ToolBenchLoader } from "../datasets/toolbench-loader.js";
import type { DatasetLoader, DatasetLoadOptions, BenchmarkDataset } from "../datasets/loader.js";
import { Evaluator, ExactMatchJudge, ContainsJudge } from "../evaluator.js";
import { ToolCallJudge } from "../judges/tool-call-judge.js";
import type { Judge, EvalReport } from "../evaluator.js";
import type { TaskResult } from "../batch-runner.js";

// ═══════════════════════════════════════════════════════════════
// 命令行参数解析（轻量，无外部依赖）
// ═══════════════════════════════════════════════════════════════

interface CLIArgs {
  dataset: string;
  version: string;
  difficulty?: number;
  maxTasks: number;
  cacheDir?: string;
  output?: string;
  judges: string[];
}

/** 从 process.argv 解析命令行参数 */
function parseArgs(argv: string[]): CLIArgs {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      // 布尔标志 or 值参数
      args[key] = next && !next.startsWith("--") ? (i++, next) : "true";
    }
  }

  if (!args.dataset) {
    printUsage();
    process.exit(1);
  }

  return {
    dataset: args.dataset,
    version: args.version ?? "v1",
    difficulty: args.difficulty ? Number(args.difficulty) : undefined,
    maxTasks: args["max-tasks"] ? Number(args["max-tasks"]) : 50,
    cacheDir: args["cache-dir"],
    output: args.output,
    judges: args.judges ? args.judges.split(",").map((j) => j.trim()) : ["exact_match"],
  };
}

function printUsage(): void {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          super-agent-bench — 评估基准 CLI               ║
╠══════════════════════════════════════════════════════════╣
║ 用法:                                                   ║
║   npx tsx src/cli/benchmark.ts --dataset <name> [opts]  ║
║                                                         ║
║ 必填:                                                   ║
║   --dataset   bfcl | gaia | toolbench                   ║
║                                                         ║
║ 可选:                                                   ║
║   --version     数据集版本 (默认 v1)                    ║
║   --difficulty  难度 1/2/3 (仅 GAIA)                    ║
║   --max-tasks   最大任务数 (默认 50)                    ║
║   --cache-dir   缓存目录                                ║
║   --output      报告输出路径                            ║
║   --judges      评判器列表 (逗号分隔)                   ║
║                 可选: exact_match, contains, tool_call   ║
╚══════════════════════════════════════════════════════════╝
`);
}

// ═══════════════════════════════════════════════════════════════
// Loader 工厂
// ═══════════════════════════════════════════════════════════════

/** 根据名称创建数据集加载器 */
function createLoader(name: string): DatasetLoader {
  switch (name.toLowerCase()) {
    case "bfcl":
      return new BFCLLoader();
    case "gaia":
      return new GAIALoader();
    case "toolbench":
      return new ToolBenchLoader();
    default:
      console.error(`[ERROR] 未知数据集: ${name}。支持: bfcl, gaia, toolbench`);
      process.exit(1);
  }
}

/** 根据名称列表创建评判器数组 */
function createJudges(names: string[]): Judge[] {
  const map: Record<string, () => Judge> = {
    exact_match: () => new ExactMatchJudge(),
    contains: () => new ContainsJudge(),
    tool_call: () => new ToolCallJudge(),
  };

  return names.map((n) => {
    const factory = map[n];
    if (!factory) {
      console.warn(`[WARN] 未知评判器 "${n}"，已跳过。可选: ${Object.keys(map).join(", ")}`);
      return null;
    }
    return factory();
  }).filter(Boolean) as Judge[];
}

// ═══════════════════════════════════════════════════════════════
// 模拟运行器（占位）
// ═══════════════════════════════════════════════════════════════

/**
 * 模拟执行任务并返回结果
 * @issue(todo): 后续对接真实 Agent 运行器（BatchRunner + AgentRuntime）
 */
function simulateTaskResults(dataset: BenchmarkDataset): TaskResult[] {
  return dataset.tasks.map((task) => ({
    taskId: task.id,
    output: task.expected.output?.toString() ?? "",
    success: true,
    durationMs: Math.floor(Math.random() * 5000) + 500,
    timestamp: new Date(),
    tokenUsage: {
      prompt: Math.floor(Math.random() * 2000) + 200,
      completion: Math.floor(Math.random() * 500) + 50,
    },
    toolCalls: task.toolsRequired?.map((name) => `${name}({})`),
  }));
}

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log(`\n🔬 super-agent-bench`);
  console.log(`   数据集: ${args.dataset}`);
  console.log(`   版本: ${args.version}`);
  if (args.difficulty) console.log(`   难度: Level ${args.difficulty}`);
  console.log(`   最大任务数: ${args.maxTasks}`);
  console.log(`   评判器: ${args.judges.join(", ")}\n`);

  // 1. 加载数据集
  console.log("📦 加载数据集...");
  const loader = createLoader(args.dataset);
  const loadOptions: DatasetLoadOptions = {
    version: args.version,
    maxTasks: args.maxTasks,
    cacheDir: args.cacheDir,
  };
  if (args.difficulty) {
    loadOptions.difficulty = args.difficulty as 1 | 2 | 3;
  }
  const dataset = await loader.load(loadOptions);
  console.log(`   已加载 ${dataset.tasks.length} 条任务 (${dataset.name} ${dataset.version})`);

  // 2. 运行任务（当前为模拟模式）
  console.log("\n🏃 运行任务（模拟模式）...");
  const results = simulateTaskResults(dataset);
  console.log(`   完成 ${results.length} 个任务`);

  // 3. 评估
  console.log("\n📊 评估中...");
  const judges = createJudges(args.judges);
  if (judges.length === 0) {
    console.error("[ERROR] 无有效评判器");
    process.exit(1);
  }

  const expectedOutputs = new Map<string, string>();
  for (const task of dataset.tasks) {
    if (task.expected.output) {
      expectedOutputs.set(
        task.id,
        typeof task.expected.output === "string"
          ? task.expected.output
          : JSON.stringify(task.expected.output),
      );
    }
  }

  const evaluator = new Evaluator({ judges, expectedOutputs });
  const tasks = dataset.tasks.map((t) => ({ id: t.id, input: t.input }));
  const report: EvalReport = await evaluator.evaluate(tasks, results);

  // 4. 输出报告
  const reportJson = JSON.stringify(report, null, 2);

  if (args.output) {
    const outPath = resolve(args.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, reportJson, "utf-8");
    console.log(`\n📄 报告已写入: ${outPath}`);
  }

  // 控制台摘要
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║         评估报告摘要                 ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║ 总任务数:     ${String(report.totalTasks).padStart(8)}`);
  console.log(`║ 通过率:       ${(report.passRate * 100).toFixed(1).padStart(7)}%`);
  console.log(`║ 平均分:       ${report.avgScore.toFixed(3).padStart(8)}`);
  console.log(`║ 成功率:       ${(report.metrics.successRate * 100).toFixed(1).padStart(7)}%`);
  console.log(`║ 平均耗时:     ${report.metrics.avgDurationMs.toFixed(0).padStart(6)}ms`);
  console.log(`║ 平均 Token:   ${report.metrics.avgTokens.toFixed(0).padStart(8)}`);
  console.log(`║ 工具效率:     ${report.metrics.toolEfficiency.toFixed(2).padStart(8)}`);
  console.log("╠══════════════════════════════════════╣");

  // 按 Judge 分
  for (const [name, stat] of Object.entries(report.perJudge)) {
    console.log(`║ [${name}] 均分=${stat.avgScore.toFixed(3)} 通过率=${(stat.passRate * 100).toFixed(1)}%`);
  }

  // 按难度分（如果有）
  if (report.byDifficulty) {
    console.log("╠══════════════════════════════════════╣");
    for (const [level, stat] of Object.entries(report.byDifficulty)) {
      console.log(`║ Level ${level}: 通过率=${(stat.passRate * 100).toFixed(1)}% 均分=${stat.avgScore.toFixed(3)} (${stat.count}题)`);
    }
  }

  console.log("╚══════════════════════════════════════╝\n");
}

// 入口
main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
