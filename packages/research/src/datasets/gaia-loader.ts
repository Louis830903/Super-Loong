/**
 * datasets/gaia-loader.ts — GAIA (General AI Assistants) 数据集加载器
 *
 * GAIA 评估多步推理 + 真实世界工具使用能力，按难度分为 Level 1/2/3。
 * 数据集来源：gaia-benchmark/GAIA（HuggingFace）
 *
 * 特色功能：
 *   - 支持按 difficulty 过滤（Level 1 最简单，Level 3 最复杂）
 *   - 期望输出通常是简短的关键事实（keyFacts）而非精确文本
 *   - 报告按难度分组输出 passRate（扩展 EvalReport.byDifficulty）
 *
 * 参考 Spec v1.3 T4.3（L638-642）
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

const logger = pino({ name: "research:gaia-loader" });

const DEFAULT_VERSION = "2023";

// ─── 内嵌 Sample 子集（10 条，覆盖 3 个难度等级）─────────

const GAIA_SAMPLE: BenchmarkTask[] = [
  {
    id: "gaia_001",
    input: "What is the capital of France?",
    expected: { output: "Paris", keyFacts: ["Paris"] },
    difficulty: 1,
  },
  {
    id: "gaia_002",
    input: "How many planets are in our solar system?",
    expected: { output: "8", keyFacts: ["8"] },
    difficulty: 1,
  },
  {
    id: "gaia_003",
    input: "What year was the first iPhone released?",
    expected: { output: "2007", keyFacts: ["2007"] },
    difficulty: 1,
  },
  {
    id: "gaia_004",
    input: "What is the chemical formula for water?",
    expected: { output: "H2O", keyFacts: ["H2O"] },
    difficulty: 1,
  },
  {
    id: "gaia_005",
    input: "What is the population of Tokyo as of 2023? Give the approximate number.",
    expected: { keyFacts: ["13", "million"] },
    difficulty: 2,
  },
  {
    id: "gaia_006",
    input: "Find the GDP per capita of Switzerland in 2022 and convert it from USD to EUR using the average exchange rate.",
    expected: { keyFacts: ["USD", "EUR"] },
    difficulty: 2,
    toolsRequired: ["search", "currency_convert"],
  },
  {
    id: "gaia_007",
    input: "What was the closing price of AAPL stock on the last trading day of 2023?",
    expected: { keyFacts: ["192", "AAPL"] },
    difficulty: 2,
    toolsRequired: ["get_stock_price"],
  },
  {
    id: "gaia_008",
    input: "Compare the weather in New York and London today, summarize differences in temperature and precipitation.",
    expected: { keyFacts: ["temperature", "precipitation"] },
    difficulty: 3,
    toolsRequired: ["get_weather"],
  },
  {
    id: "gaia_009",
    input: "Research the top 3 open-source LLM projects by GitHub stars, then create a comparison table with name, stars, language, and license.",
    expected: { keyFacts: ["GitHub", "stars", "license"] },
    difficulty: 3,
    toolsRequired: ["search", "github_api"],
  },
  {
    id: "gaia_010",
    input: "Find the latest research paper on multimodal AI from arxiv, summarize its contributions, and assess if it could be applied to our codebase.",
    expected: { keyFacts: ["arxiv", "multimodal"] },
    difficulty: 3,
    toolsRequired: ["search", "read_paper"],
  },
];

// ─── GAIALoader ────────────────────────────────────────────

export class GAIALoader implements DatasetLoader {
  readonly name = "gaia";

  async load(options?: DatasetLoadOptions): Promise<BenchmarkDataset> {
    const version = options?.version ?? DEFAULT_VERSION;
    const maxTasks = options?.maxTasks ?? 50;
    const difficulty = options?.difficulty;
    const cacheKey = `gaia_${version}`;

    // 1) 尝试缓存
    const cached = readFromCache<BenchmarkTask[]>(cacheKey, options?.cacheDir);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      logger.info({ version, count: cached.length }, "GAIA loaded from cache");
      const filtered = this.filterByDifficulty(cached, difficulty);
      return this.buildDataset(version, sampleTasks(filtered, maxTasks), cached.length, cached);
    }

    // 2) 尝试 HuggingFace
    try {
      const tasks = await this.fetchFromHuggingFace(version);
      if (tasks.length > 0) {
        writeToCache(cacheKey, tasks, options?.cacheDir);
        logger.info({ version, count: tasks.length }, "GAIA fetched from HuggingFace");
        const filtered = this.filterByDifficulty(tasks, difficulty);
        return this.buildDataset(version, sampleTasks(filtered, maxTasks), tasks.length, tasks);
      }
    } catch (err) {
      logger.warn({ err }, "GAIA HuggingFace fetch failed, using embedded sample");
    }

    // 3) 兜底样本
    logger.info("GAIA using embedded sample (10 tasks)");
    const filtered = this.filterByDifficulty(GAIA_SAMPLE, difficulty);
    return this.buildDataset(version, sampleTasks(filtered, maxTasks), GAIA_SAMPLE.length, GAIA_SAMPLE);
  }

  /** 按 difficulty 过滤 */
  private filterByDifficulty(tasks: BenchmarkTask[], difficulty?: 1 | 2 | 3): BenchmarkTask[] {
    if (!difficulty) return tasks;
    return tasks.filter((t) => t.difficulty === difficulty);
  }

  /** 统计各难度级别的条数 */
  private countByDifficulty(allTasks: BenchmarkTask[]): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const t of allTasks) {
      if (t.difficulty) {
        counts[t.difficulty] = (counts[t.difficulty] ?? 0) + 1;
      }
    }
    return counts;
  }

  private buildDataset(
    version: string,
    tasks: BenchmarkTask[],
    totalCount: number,
    allTasks?: BenchmarkTask[],
  ): BenchmarkDataset {
    return {
      name: "gaia",
      version,
      tasks,
      metadata: {
        license: "CC-BY-SA-4.0",
        source: "https://huggingface.co/datasets/gaia-benchmark/GAIA",
        totalCount,
        countByDifficulty: allTasks ? this.countByDifficulty(allTasks) : undefined,
      },
    };
  }

  private async fetchFromHuggingFace(version: string): Promise<BenchmarkTask[]> {
    const baseUrl = "https://datasets-server.huggingface.co/rows";
    const params = new URLSearchParams({
      dataset: "gaia-benchmark/GAIA",
      config: `${version}_all`,
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
    const question = typeof row.Question === "string" ? row.Question : "";
    if (!question) return null;

    const level = typeof row.Level === "number" ? row.Level : 1;
    const answer = typeof row.Final_answer === "string" ? row.Final_answer : undefined;

    const expected: BenchmarkExpected = {};
    if (answer) {
      expected.output = answer;
      expected.keyFacts = [answer];
    }

    return {
      id: `gaia_hf_${String(idx).padStart(4, "0")}`,
      input: question,
      expected,
      difficulty: Math.min(Math.max(level, 1), 3) as 1 | 2 | 3,
    };
  }
}

/**
 * GAIA 专属的难度分组报告扩展。
 * 用于扩展 EvalReport 的 byDifficulty 字段。
 */
export interface DifficultyBreakdown {
  /** Level 1-3 分组统计 */
  [level: number]: {
    passRate: number;
    avgScore: number;
    count: number;
  };
}
