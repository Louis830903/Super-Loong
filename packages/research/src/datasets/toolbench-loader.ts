/**
 * datasets/toolbench-loader.ts — ToolBench 数据集加载器
 *
 * ToolBench 评估工具链式组合调用的正确性——
 * 即 Agent 在多步任务中是否能正确选择、排列、串联多个工具。
 *
 * 数据集来源：ToolBench/ToolBench（HuggingFace）
 *
 * 核心差异（与 BFCL 的区别）：
 *   - BFCL 关注单步函数调用准确度
 *   - ToolBench 关注多步工具链的顺序正确性
 *   - 期望的 toolCalls 是有序列表，评判时需考虑调用顺序
 *
 * 参考 Spec v1.3 T4.4（L644-646）
 */

import pino from "pino";
import type {
  DatasetLoader,
  DatasetLoadOptions,
  BenchmarkDataset,
  BenchmarkTask,
  BenchmarkExpected,
} from "./loader.js";
import { readFromCache, writeToCache, sampleTasks } from "./loader.js";

const logger = pino({ name: "research:toolbench-loader" });

const DEFAULT_VERSION = "v1";

// ─── 内嵌 Sample 子集（8 条，聚焦工具链组合）────────────

const TOOLBENCH_SAMPLE: BenchmarkTask[] = [
  {
    id: "tb_001",
    input: "Search for the latest news about AI and summarize the top 3 results",
    expected: {
      toolCalls: [
        { name: "web_search", argsMatch: "contains", expectedArgs: { query: "AI" } },
        { name: "summarize", argsMatch: "subset" },
      ],
    },
    toolsRequired: ["web_search", "summarize"],
  },
  {
    id: "tb_002",
    input: "Download the CSV file from https://example.com/data.csv and compute the average of the 'price' column",
    expected: {
      toolCalls: [
        { name: "http_get", argsMatch: "contains", expectedArgs: { url: "https://example.com/data.csv" } },
        { name: "csv_parse", argsMatch: "subset" },
        { name: "compute_stats", argsMatch: "subset", expectedArgs: { column: "price", operation: "average" } },
      ],
    },
    toolsRequired: ["http_get", "csv_parse", "compute_stats"],
  },
  {
    id: "tb_003",
    input: "Look up the exchange rate from USD to JPY, then convert 500 USD",
    expected: {
      toolCalls: [
        { name: "get_exchange_rate", argsMatch: "subset", expectedArgs: { from: "USD", to: "JPY" } },
        { name: "convert_currency", argsMatch: "subset", expectedArgs: { amount: 500 } },
      ],
    },
    toolsRequired: ["get_exchange_rate", "convert_currency"],
  },
  {
    id: "tb_004",
    input: "Read the file /tmp/report.txt, extract all email addresses, and send a summary to admin@example.com",
    expected: {
      toolCalls: [
        { name: "read_file", argsMatch: "subset", expectedArgs: { path: "/tmp/report.txt" } },
        { name: "extract_emails", argsMatch: "subset" },
        { name: "send_email", argsMatch: "subset", expectedArgs: { to: "admin@example.com" } },
      ],
    },
    toolsRequired: ["read_file", "extract_emails", "send_email"],
  },
  {
    id: "tb_005",
    input: "Get weather for Tokyo, translate the forecast to English, then post it on Slack",
    expected: {
      toolCalls: [
        { name: "get_weather", argsMatch: "subset", expectedArgs: { city: "Tokyo" } },
        { name: "translate", argsMatch: "subset", expectedArgs: { to: "en" } },
        { name: "post_slack", argsMatch: "subset" },
      ],
    },
    toolsRequired: ["get_weather", "translate", "post_slack"],
  },
  {
    id: "tb_006",
    input: "Search GitHub for 'super-agent', clone the top result, and list its directory structure",
    expected: {
      toolCalls: [
        { name: "github_search", argsMatch: "contains" },
        { name: "git_clone", argsMatch: "subset" },
        { name: "list_directory", argsMatch: "subset" },
      ],
    },
    toolsRequired: ["github_search", "git_clone", "list_directory"],
  },
  {
    id: "tb_007",
    input: "Query the database for users who signed up last month, export to CSV, and email the file to hr@company.com",
    expected: {
      toolCalls: [
        { name: "db_query", argsMatch: "subset" },
        { name: "export_csv", argsMatch: "subset" },
        { name: "send_email", argsMatch: "subset", expectedArgs: { to: "hr@company.com" } },
      ],
    },
    toolsRequired: ["db_query", "export_csv", "send_email"],
  },
  {
    id: "tb_008",
    input: "Take a screenshot of https://example.com, resize it to 800x600, and upload to S3",
    expected: {
      toolCalls: [
        { name: "screenshot", argsMatch: "contains" },
        { name: "resize_image", argsMatch: "subset", expectedArgs: { width: 800, height: 600 } },
        { name: "s3_upload", argsMatch: "subset" },
      ],
    },
    toolsRequired: ["screenshot", "resize_image", "s3_upload"],
  },
];

// ─── ToolBenchLoader ───────────────────────────────────────

export class ToolBenchLoader implements DatasetLoader {
  readonly name = "toolbench";

  async load(options?: DatasetLoadOptions): Promise<BenchmarkDataset> {
    const version = options?.version ?? DEFAULT_VERSION;
    const maxTasks = options?.maxTasks ?? 50;
    const cacheKey = `toolbench_${version}`;

    // 1) 缓存
    const cached = readFromCache<BenchmarkTask[]>(cacheKey, options?.cacheDir);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      logger.info({ version, count: cached.length }, "ToolBench loaded from cache");
      return this.buildDataset(version, sampleTasks(cached, maxTasks), cached.length);
    }

    // 2) HuggingFace（ToolBench 数据集较大，只取前 100 条）
    try {
      const tasks = await this.fetchFromHuggingFace(version);
      if (tasks.length > 0) {
        writeToCache(cacheKey, tasks, options?.cacheDir);
        logger.info({ version, count: tasks.length }, "ToolBench fetched from HuggingFace");
        return this.buildDataset(version, sampleTasks(tasks, maxTasks), tasks.length);
      }
    } catch (err) {
      logger.warn({ err }, "ToolBench HuggingFace fetch failed, using embedded sample");
    }

    // 3) 兜底
    logger.info("ToolBench using embedded sample (8 tasks)");
    return this.buildDataset(version, sampleTasks(TOOLBENCH_SAMPLE, maxTasks), TOOLBENCH_SAMPLE.length);
  }

  private buildDataset(version: string, tasks: BenchmarkTask[], totalCount: number): BenchmarkDataset {
    return {
      name: "toolbench",
      version,
      tasks,
      metadata: {
        license: "Apache-2.0",
        source: "https://huggingface.co/datasets/ToolBench/ToolBench",
        totalCount,
      },
    };
  }

  private async fetchFromHuggingFace(version: string): Promise<BenchmarkTask[]> {
    const baseUrl = "https://datasets-server.huggingface.co/rows";
    const params = new URLSearchParams({
      dataset: "ToolBench/ToolBench",
      config: "default",
      split: "test",
      offset: "0",
      length: "100",
    });

    const response = await fetch(`${baseUrl}?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HuggingFace API returned ${response.status}`);
    }

    const data = (await response.json()) as { rows?: Array<{ row: Record<string, unknown> }> };
    if (!data.rows) return [];

    return data.rows
      .map((r, idx) => this.parseHfRow(r.row, idx))
      .filter((t): t is BenchmarkTask => t !== null);
  }

  private parseHfRow(row: Record<string, unknown>, idx: number): BenchmarkTask | null {
    const query = typeof row.query === "string" ? row.query : "";
    if (!query) return null;

    const expected: BenchmarkExpected = {};

    // 尝试解析 tool_trace / api_calls
    if (typeof row.api_calls === "string") {
      try {
        const calls = JSON.parse(row.api_calls);
        if (Array.isArray(calls)) {
          expected.toolCalls = calls.map((c: Record<string, unknown>) => ({
            name: String(c.api_name ?? c.name ?? "unknown"),
            argsMatch: "subset" as const,
            expectedArgs: typeof c.parameters === "object" ? c.parameters as Record<string, unknown> : undefined,
          }));
        }
      } catch { /* 忽略 */ }
    }

    if (typeof row.answer === "string") {
      expected.output = row.answer;
    }

    return {
      id: `tb_hf_${String(idx).padStart(4, "0")}`,
      input: query,
      expected,
      metadata: { source: "huggingface" },
    };
  }
}
