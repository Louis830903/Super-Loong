/**
 * datasets/bfcl-loader.ts — BFCL (Berkeley Function-Calling Leaderboard) 数据集加载器
 *
 * BFCL 评估工具理解与参数生成准确度。
 * 数据集格式（简化版，兼容 HuggingFace gorilla-llm/berkeley-function-call-leaderboard）：
 *   - 每条记录包含 user prompt + 可用函数定义 + 期望的函数调用
 *   - 核心评估维度：函数选择正确性 + 参数生成准确度
 *
 * 加载策略：
 *   1. 优先从本地缓存读取
 *   2. 未命中则从 HuggingFace API 下载（需联网）
 *   3. 兜底：加载内嵌的 sample 子集（10 条，保证离线可测）
 *
 * 参考 Spec v1.3 T4.2（L632-636）
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

const logger = pino({ name: "research:bfcl-loader" });

/** BFCL 数据集默认版本 */
const DEFAULT_VERSION = "v3";

// ─── 内嵌 Sample 子集（10 条）──────────────────────────────
// 从 gorilla-llm/berkeley-function-call-leaderboard 精简而来
// 保证离线时仍可运行测试

const BFCL_SAMPLE: BenchmarkTask[] = [
  {
    id: "bfcl_001",
    input: "What is the weather in San Francisco?",
    expected: {
      toolCalls: [{ name: "get_weather", argsMatch: "subset", expectedArgs: { city: "San Francisco" } }],
    },
    toolsRequired: ["get_weather"],
  },
  {
    id: "bfcl_002",
    input: "Send an email to john@example.com with subject 'Hello' and body 'World'",
    expected: {
      toolCalls: [{
        name: "send_email",
        argsMatch: "subset",
        expectedArgs: { to: "john@example.com", subject: "Hello" },
      }],
    },
    toolsRequired: ["send_email"],
  },
  {
    id: "bfcl_003",
    input: "Calculate the area of a circle with radius 5",
    expected: {
      toolCalls: [{ name: "calculate_circle_area", argsMatch: "subset", expectedArgs: { radius: 5 } }],
      output: "78.54",
    },
    toolsRequired: ["calculate_circle_area"],
  },
  {
    id: "bfcl_004",
    input: "Search for flights from NYC to LAX on 2024-03-15",
    expected: {
      toolCalls: [{
        name: "search_flights",
        argsMatch: "subset",
        expectedArgs: { origin: "NYC", destination: "LAX", date: "2024-03-15" },
      }],
    },
    toolsRequired: ["search_flights"],
  },
  {
    id: "bfcl_005",
    input: "Create a new calendar event for tomorrow at 3pm titled 'Team Meeting'",
    expected: {
      toolCalls: [{ name: "create_event", argsMatch: "subset", expectedArgs: { title: "Team Meeting" } }],
    },
    toolsRequired: ["create_event"],
  },
  {
    id: "bfcl_006",
    input: "Translate 'hello world' from English to Spanish",
    expected: {
      toolCalls: [{
        name: "translate",
        argsMatch: "subset",
        expectedArgs: { text: "hello world", from: "en", to: "es" },
      }],
      output: "hola mundo",
    },
    toolsRequired: ["translate"],
  },
  {
    id: "bfcl_007",
    input: "Get the stock price of AAPL",
    expected: {
      toolCalls: [{ name: "get_stock_price", argsMatch: "subset", expectedArgs: { symbol: "AAPL" } }],
    },
    toolsRequired: ["get_stock_price"],
  },
  {
    id: "bfcl_008",
    input: "Convert 100 USD to EUR",
    expected: {
      toolCalls: [{
        name: "convert_currency",
        argsMatch: "subset",
        expectedArgs: { amount: 100, from: "USD", to: "EUR" },
      }],
    },
    toolsRequired: ["convert_currency"],
  },
  {
    id: "bfcl_009",
    input: "Add items milk, bread, eggs to my shopping list",
    expected: {
      toolCalls: [{
        name: "add_to_list",
        argsMatch: "contains",
        expectedArgs: { items: ["milk", "bread", "eggs"] },
      }],
    },
    toolsRequired: ["add_to_list"],
  },
  {
    id: "bfcl_010",
    input: "Set a timer for 25 minutes",
    expected: {
      toolCalls: [{ name: "set_timer", argsMatch: "subset", expectedArgs: { minutes: 25 } }],
    },
    toolsRequired: ["set_timer"],
  },
];

// ─── BFCLLoader ────────────────────────────────────────────

export class BFCLLoader implements DatasetLoader {
  readonly name = "bfcl";

  async load(options?: DatasetLoadOptions): Promise<BenchmarkDataset> {
    const version = options?.version ?? DEFAULT_VERSION;
    const maxTasks = options?.maxTasks ?? 50;
    const cacheKey = `bfcl_${version}`;

    // 1) 尝试从缓存读取
    const cached = readFromCache<BenchmarkTask[]>(cacheKey, options?.cacheDir);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      logger.info({ version, count: cached.length }, "BFCL loaded from cache");
      return this.buildDataset(version, sampleTasks(cached, maxTasks), cached.length);
    }

    // 2) 尝试从 HuggingFace 下载（需联网）
    try {
      const tasks = await this.fetchFromHuggingFace(version);
      if (tasks.length > 0) {
        writeToCache(cacheKey, tasks, options?.cacheDir);
        logger.info({ version, count: tasks.length }, "BFCL fetched from HuggingFace");
        return this.buildDataset(version, sampleTasks(tasks, maxTasks), tasks.length);
      }
    } catch (err) {
      logger.warn({ err }, "BFCL HuggingFace fetch failed, falling back to embedded sample");
    }

    // 3) 兜底：内嵌样本
    logger.info("BFCL using embedded sample (10 tasks)");
    return this.buildDataset(version, sampleTasks(BFCL_SAMPLE, maxTasks), BFCL_SAMPLE.length);
  }

  private buildDataset(version: string, tasks: BenchmarkTask[], totalCount: number): BenchmarkDataset {
    return {
      name: "bfcl",
      version,
      tasks,
      metadata: {
        license: "Apache-2.0",
        source: "https://huggingface.co/datasets/gorilla-llm/berkeley-function-call-leaderboard",
        totalCount,
      },
    };
  }

  /**
   * 从 HuggingFace Datasets API 下载 BFCL 数据。
   * API: GET https://datasets-server.huggingface.co/rows?dataset=gorilla-llm/berkeley-function-call-leaderboard&config=default&split=test&offset=0&length=100
   */
  private async fetchFromHuggingFace(version: string): Promise<BenchmarkTask[]> {
    const baseUrl = "https://datasets-server.huggingface.co/rows";
    const params = new URLSearchParams({
      dataset: "gorilla-llm/berkeley-function-call-leaderboard",
      config: "default",
      split: "test",
      offset: "0",
      length: "100",
    });

    const response = await fetch(`${baseUrl}?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HuggingFace API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { rows?: Array<{ row: Record<string, unknown> }> };
    if (!data.rows || !Array.isArray(data.rows)) return [];

    return data.rows
      .map((r, idx) => this.parseHfRow(r.row, idx))
      .filter((t): t is BenchmarkTask => t !== null);
  }

  /** 将 HuggingFace 行数据转为 BenchmarkTask */
  private parseHfRow(row: Record<string, unknown>, idx: number): BenchmarkTask | null {
    const question = typeof row.question === "string" ? row.question : "";
    if (!question) return null;

    const expected: BenchmarkExpected = {};

    // 尝试提取期望的函数调用
    if (typeof row.ground_truth === "string") {
      try {
        const gt = JSON.parse(row.ground_truth);
        if (Array.isArray(gt)) {
          expected.toolCalls = gt.map((call: Record<string, unknown>) => ({
            name: typeof call.name === "string" ? call.name : String(call.name ?? "unknown"),
            argsMatch: "subset" as const,
            expectedArgs: typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : undefined,
          }));
        }
      } catch { /* 非 JSON 格式，用文本匹配 */ }
    }

    // 兜底：文本输出
    if (!expected.toolCalls && typeof row.ground_truth === "string") {
      expected.output = row.ground_truth;
    }

    return {
      id: `bfcl_hf_${String(idx).padStart(4, "0")}`,
      input: question,
      expected,
      metadata: { source: "huggingface", category: row.category },
    };
  }
}
