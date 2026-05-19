/**
 * Embedding Providers — 嵌入向量提供器集合
 *
 * 三家提供器：
 * - SimpleEmbedding：哈希式 TF-IDF 向量，零依赖，适合开发/测试或冷启动
 * - HRRProvider：全息缩减表示（Hermes 同源），SHA-256 相位向量，
 *   零外部依赖，支持 bind/unbind/probe 代数操作（默认 production embedder）
 * - QwenEmbedding：通义千问 text-embedding-v4，2048 维真嵌入，
 *   含熔断器（5 次失败→120s 冷却）+ 指数退避重试 + 15s 超时
 *
 * @why 拆分自原 memory/manager.ts（v3 Task 9 上帝文件拆分，1610 → ~1345 行）
 */

import * as hrr from "./hrr.js";

// ─── Embedding Provider Interface ────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
  /** ISSUE-3: 向量类型标识，用于检索时选择相似度算法（消除 instanceof 硬耦合） */
  readonly embeddingType: "hrr" | "qwen" | "simple";
  /** 可选：结构化编码（仅 HRR 等支持代数操作的 provider 实现） */
  embedFact?(content: string, entities: string[]): Promise<number[]>;
}

// ─── Simple Built-in Embedding (TF-IDF-like for zero deps) ──

export class SimpleEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly embeddingType = "simple" as const;

  constructor(dims = 128) {
    this.dimensions = dims;
  }

  async embed(text: string): Promise<number[]> {
    // Deterministic hash-based embedding (no external API needed)
    // Good enough for exact and fuzzy matching; replace with HRRProvider for production
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    const vec = new Float64Array(this.dimensions);

    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
      }
      // Spread token influence across multiple dimensions
      for (let d = 0; d < 4; d++) {
        const idx = Math.abs((hash + d * 31) % this.dimensions);
        vec[idx] += 1.0 / (1 + d);
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec).map((v) => v / norm);
  }
}

// ─── HRR Embedding Provider (F-2: 移植 Hermes HRR 为默认 embedder) ──

/**
 * 基于全息缩减表示(HRR)的嵌入提供器。
 * 使用 SHA-256 确定性相位向量，零外部依赖。
 * 支持结构化代数操作 (bind/unbind/probe)。
 */
export class HRRProvider implements EmbeddingProvider {
  readonly dimensions: number;
  readonly embeddingType = "hrr" as const;
  private dim: number;

  constructor(dim: number = hrr.DEFAULT_DIM) {
    this.dim = dim;
    this.dimensions = dim;
  }

  async embed(text: string): Promise<number[]> {
    const phases = hrr.encodeText(text, this.dim);
    return hrr.toNumberArray(phases);
  }

  /** 结构化编码：内容+实体角色绑定，支持代数提取 */
  async embedFact(content: string, entities: string[]): Promise<number[]> {
    const phases = hrr.encodeFact(content, entities, this.dim);
    return hrr.toNumberArray(phases);
  }
}

// ─── Qwen Embedding (通义千问 text-embedding-v4, 2048维) ───

export interface QwenEmbeddingConfig {
  /** DashScope API key. Defaults to env DASHSCOPE_API_KEY */
  apiKey?: string;
  /** Model name. Default: text-embedding-v4 */
  model?: string;
  /** Output dimensions (max 2048). Default: 2048 */
  dimensions?: number;
  /** Base URL. Default: https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl?: string;
}

export class QwenEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly embeddingType = "qwen" as const;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  // D-2: 熔断器状态（学 Hermes mem0 5次失败→120s冷却）
  private _consecutiveFailures = 0;
  private _breakerOpenUntil = 0;
  private static readonly BREAKER_THRESHOLD = 5;
  private static readonly BREAKER_COOLDOWN_MS = 120_000;

  constructor(config: QwenEmbeddingConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
    this.model = config.model ?? "text-embedding-v4";
    this.dimensions = config.dimensions ?? 2048;
    this.baseUrl = config.baseUrl ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  }

  /** 运行时更新 API Key（设置页面保存千问 API Key 后热生效，无需重启） */
  updateApiKey(newKey: string): void {
    this.apiKey = newKey;
    // 重置熔断器，让新 Key 有机会立即尝试
    this._consecutiveFailures = 0;
    this._breakerOpenUntil = 0;
  }

  /** D-2: 检查熔断器是否开启，冷却期过后自动重置 */
  private isBreakerOpen(): boolean {
    if (this._consecutiveFailures < QwenEmbedding.BREAKER_THRESHOLD) return false;
    if (Date.now() >= this._breakerOpenUntil) {
      // 冷却期已过，重置熔断器
      this._consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  async embed(text: string): Promise<number[]> {
    // CORE-P1-05: 单一职责 — QwenEmbedding 只负责调 Qwen API，失败一律 throw。
    // 降级策略由上游 MemoryManager 决定（写入时跳过 embedding，仅按文本召回），
    // 避免把 Simple 哈希向量伪装成 "qwen" 类型写入数据库污染检索。
    if (!this.apiKey) {
      throw new Error(
        "[QwenEmbedding] No DASHSCOPE_API_KEY configured — caller should choose HRR/Simple provider instead."
      );
    }

    // D-2: 熔断器开启时直接抛错，由 MemoryManager 决定降级策略（文本召回兜底）
    if (this.isBreakerOpen()) {
      const remainSec = Math.ceil((this._breakerOpenUntil - Date.now()) / 1000);
      throw new Error(
        `[QwenEmbedding] Circuit breaker OPEN (${this._consecutiveFailures} consecutive failures, ~${remainSec}s remain)`
      );
    }

    try {
      const result = await this.fetchWithRetry(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          dimensions: this.dimensions,
          encoding_format: "float",
        }),
      }).then(async (response) => {
        const data = await response.json() as {
          data: Array<{ embedding: number[] }>;
        };
        if (!data.data || data.data.length === 0) {
          throw new Error("QwenEmbedding returned empty data");
        }
        return data.data[0].embedding;
      });

      // 成功，重置失败计数
      this._consecutiveFailures = 0;
      return result;
    } catch (err) {
      // D-2: 记录失败，达到阈值时开启熔断器；然后向上抛错让 Manager 决定兜底
      this._consecutiveFailures++;
      if (this._consecutiveFailures >= QwenEmbedding.BREAKER_THRESHOLD) {
        this._breakerOpenUntil = Date.now() + QwenEmbedding.BREAKER_COOLDOWN_MS;
        console.warn(
          `[QwenEmbedding] Circuit breaker TRIGGERED after ${this._consecutiveFailures} failures. ` +
          `Cooldown ${QwenEmbedding.BREAKER_COOLDOWN_MS / 1000}s, next retry at ${new Date(this._breakerOpenUntil).toISOString()}`
        );
      }
      // CORE-P1-05: 不再兜底为 SimpleEmbedding，直接抛错避免标签错配
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Batch embed multiple texts (max 10 per call per API limit) */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // CORE-P1-05: 同 embed()，失败一律 throw 交由上游决定降级
    if (!this.apiKey) {
      throw new Error(
        "[QwenEmbedding] No DASHSCOPE_API_KEY configured — caller should choose HRR/Simple provider instead."
      );
    }
    if (this.isBreakerOpen()) {
      const remainSec = Math.ceil((this._breakerOpenUntil - Date.now()) / 1000);
      throw new Error(
        `[QwenEmbedding] Circuit breaker OPEN (${this._consecutiveFailures} consecutive failures, ~${remainSec}s remain)`
      );
    }

    const results: number[][] = [];
    // API limit: max 10 texts per batch
    for (let i = 0; i < texts.length; i += 10) {
      const batch = texts.slice(i, i + 10);
      const response = await this.fetchWithRetry(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
          encoding_format: "float",
        }),
      });

      const res = await response.json() as {
        data: Array<{ index: number; embedding: number[] }>;
      };
      // P2-04: Sort by index to ensure correct order
      const sorted = res.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        results.push(item.embedding);
      }
    }
    return results;
  }

  /**
   * P1-05 + P1-06: Fetch with timeout (15s) and exponential backoff retry (429/5xx).
   */
  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(timeout);

        if (response.status === 429 || response.status >= 500) {
          const waitMs = Math.pow(2, attempt) * 1000;
          console.warn(`[QwenEmbedding] ${response.status} on attempt ${attempt + 1}, retrying in ${waitMs}ms...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`QwenEmbedding API error ${response.status}: ${errBody}`);
        }
        return response;
      } catch (err) {
        clearTimeout(timeout);
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error(`QwenEmbedding API timeout after 15s (attempt ${attempt + 1})`);
        }
        throw err;
      }
    }
    throw new Error(`QwenEmbedding API failed after ${maxRetries} retries`);
  }
}
