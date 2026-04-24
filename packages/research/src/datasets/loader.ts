/**
 * datasets/loader.ts — 评估基准数据集的通用类型和加载器接口
 *
 * 为 BFCL / GAIA / ToolBench 三个学术基准提供统一的数据抽象层。
 * 设计原则：
 *   - 类型先行：所有基准共享 BenchmarkTask / BenchmarkExpected / BenchmarkDataset
 *   - 加载器可插拔：DatasetLoader 接口 + 各基准具体实现
 *   - 本地缓存优先：避免重复下载，支持离线运行
 *   - 安全采样：默认只加载子集（maxTasks），完整跑需显式指定
 *
 * 参考 Spec v1.3 T4.1（L601-629）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import pino from "pino";

const logger = pino({ name: "research:dataset-loader" });

// ═══════════════════════════════════════════════════════════════
// 通用数据类型
// ═══════════════════════════════════════════════════════════════

/**
 * 基准数据集。
 * 所有 Loader 的 load() 方法返回此结构。
 */
export interface BenchmarkDataset {
  /** 数据集名称（如 "bfcl", "gaia", "toolbench"） */
  name: string;
  /** 数据集版本（如 "v3", "2023"） */
  version: string;
  /** 任务列表 */
  tasks: BenchmarkTask[];
  /** 元信息 */
  metadata: {
    license: string;
    source: string;
    /** 总条数（加载前），用于显示采样比例 */
    totalCount?: number;
    /** 按难度分组的条数 */
    countByDifficulty?: Record<number, number>;
  };
}

/**
 * 单个基准测试任务。
 */
export interface BenchmarkTask {
  /** 唯一 ID（来自数据集自身或自动生成） */
  id: string;
  /** 用户输入（自然语言 prompt） */
  input: string;
  /** 期望输出 / 评判标准 */
  expected: BenchmarkExpected;
  /** 难度等级（GAIA Level 1-3；BFCL/ToolBench 可不填） */
  difficulty?: 1 | 2 | 3;
  /** 任务需要的工具列表（来自数据集标注） */
  toolsRequired?: string[];
  /** 扩展元数据（各基准自定义字段） */
  metadata?: Record<string, unknown>;
}

/**
 * 期望输出：可以是文本精确匹配、关键事实列表、或工具调用轨迹。
 */
export interface BenchmarkExpected {
  /** 期望的文本输出（精确匹配 / 包含匹配） */
  output?: string;
  /** 期望的工具调用序列（工具名 + 参数匹配模式） */
  toolCalls?: Array<{
    name: string;
    /** 参数匹配策略 */
    argsMatch: "exact" | "subset" | "contains";
    /** 期望的参数（JSON 对象） */
    expectedArgs?: Record<string, unknown>;
  }>;
  /** 期望的关键事实列表（用于 GAIA 等开放式任务，全部命中才算通过） */
  keyFacts?: string[];
}

/**
 * 数据集加载配置。
 */
export interface DatasetLoadOptions {
  /** 数据集版本（各 Loader 有默认值） */
  version?: string;
  /** 最大加载任务数（默认 50，防止成本失控） */
  maxTasks?: number;
  /** 按难度过滤（仅 GAIA 等有难度标注的数据集有效） */
  difficulty?: 1 | 2 | 3;
  /** 本地缓存目录（默认 packages/research/data/cache/） */
  cacheDir?: string;
}

/**
 * 数据集加载器接口。
 * 各基准（BFCL / GAIA / ToolBench）各自实现。
 */
export interface DatasetLoader {
  /** 加载器名称，与 BenchmarkDataset.name 一致 */
  readonly name: string;
  /** 加载数据集 */
  load(options?: DatasetLoadOptions): Promise<BenchmarkDataset>;
}

// ═══════════════════════════════════════════════════════════════
// 本地缓存工具
// ═══════════════════════════════════════════════════════════════

/** 默认缓存目录（相对于 packages/research） */
const DEFAULT_CACHE_DIR = join(process.cwd(), "data", "cache");

/**
 * 从本地缓存读取数据集。返回 null 表示缓存未命中。
 */
export function readFromCache<T>(key: string, cacheDir?: string): T | null {
  const dir = cacheDir ?? DEFAULT_CACHE_DIR;
  const filePath = join(dir, `${key}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ key, err }, "Cache read failed, will re-download");
    return null;
  }
}

/**
 * 将数据集写入本地缓存。
 */
export function writeToCache(key: string, data: unknown, cacheDir?: string): void {
  const dir = cacheDir ?? DEFAULT_CACHE_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${key}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    logger.info({ key, path: filePath }, "Dataset cached locally");
  } catch (err) {
    logger.warn({ key, err }, "Cache write failed (non-fatal)");
  }
}

/**
 * 安全采样：从任务列表中截取前 maxTasks 条。
 * 保留原有顺序（不随机），确保可复现。
 */
export function sampleTasks(tasks: BenchmarkTask[], maxTasks?: number): BenchmarkTask[] {
  if (!maxTasks || maxTasks <= 0 || tasks.length <= maxTasks) return tasks;
  return tasks.slice(0, maxTasks);
}
