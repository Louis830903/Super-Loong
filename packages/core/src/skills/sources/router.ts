/**
 * SourceRouter — 统一技能源路由器
 *
 * 对标 Hermes create_source_router (tools/skills_hub.py L1900-L1960)
 * + OpenClaw workspace.ts 6 源优先级合并
 *
 * 将多个 SkillSource 聚合为统一的搜索/获取接口，
 * 按优先级排序结果，支持动态添加/移除源
 */

import pino from "pino";
import { type SkillSource, type SkillMeta, type SkillBundle } from "./base.js";

const logger = pino({ name: "source-router" });

export class SourceRouter {
  private sources: SkillSource[] = [];

  constructor(sources?: SkillSource[]) {
    if (sources) {
      this.sources = [...sources];
    }
  }

  /** 添加技能源（追加到末尾，优先级最低） */
  addSource(source: SkillSource): void {
    if (!this.sources.some((s) => s.sourceId === source.sourceId)) {
      this.sources.push(source);
      logger.info({ sourceId: source.sourceId }, "Source added to router");
    }
  }

  /** 移除技能源 */
  removeSource(sourceId: string): void {
    this.sources = this.sources.filter((s) => s.sourceId !== sourceId);
    logger.info({ sourceId }, "Source removed from router");
  }

  /** 获取所有已注册的源 */
  getSources(): SkillSource[] {
    return [...this.sources];
  }

  /** 获取源 by ID */
  getSource(sourceId: string): SkillSource | undefined {
    return this.sources.find((s) => s.sourceId === sourceId);
  }

  /**
   * 统一搜索 — 并发查询所有源，合并去重结果
   * 对标 Hermes create_source_router 的 unified_search
   */
  async unifiedSearch(query: string, limit = 30): Promise<SkillMeta[]> {
    if (this.sources.length === 0) return [];

    // 并发查询所有源
    const promises = this.sources.map(async (source) => {
      try {
        const results = await source.search(query, limit);
        return results;
      } catch (err: any) {
        logger.debug({ sourceId: source.sourceId, error: err.message }, "Source search failed");
        return [] as SkillMeta[];
      }
    });

    const allResults = await Promise.all(promises);

    // 合并结果，保持源优先级顺序（先注册的源结果排前面）
    const merged: SkillMeta[] = [];
    const seen = new Set<string>();

    for (const results of allResults) {
      for (const meta of results) {
        // 按名称去重（保留第一个，即优先级更高的源）
        const key = meta.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(meta);
        }
      }
    }

    return merged.slice(0, limit);
  }

  /**
   * 从第一个匹配的源获取技能包
   * 根据 identifier 前缀路由到对应源
   */
  async fetchFirst(identifier: string): Promise<SkillBundle | null> {
    // 从 identifier 前缀提取 sourceId
    const colonIdx = identifier.indexOf(":");
    if (colonIdx > 0) {
      const sourceId = identifier.slice(0, colonIdx);
      const source = this.getSource(sourceId);
      if (source) {
        try {
          return await source.fetch(identifier);
        } catch (err: any) {
          logger.debug({ sourceId, identifier, error: err.message }, "Targeted fetch failed");
        }
      }
    }

    // 回退: 尝试所有源
    for (const source of this.sources) {
      try {
        const bundle = await source.fetch(identifier);
        if (bundle) return bundle;
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 创建默认路由器（对标 Hermes 优先级排序）
   * 优先级: Local > SkillHub > GitHub > ClawHub
   */
  static async createDefault(localDirs: string[]): Promise<SourceRouter> {
    // 并行动态导入所有源，避免循环依赖，同时等待全部加载完毕后再返回
    const router = new SourceRouter();

    const [
      localMod,
      skillhubMod,
      githubMod,
      clawhubMod,
    ] = await Promise.all([
      import("./local.js").catch(() => null),
      import("./skillhub.js").catch(() => null),
      import("./github.js").catch(() => null),
      import("./clawhub.js").catch(() => null),
    ]);

    // 按优先级从高到低注册
    if (localMod) router.addSource(new localMod.LocalSource(localDirs));
    if (skillhubMod) router.addSource(new skillhubMod.SkillHubSource());
    if (githubMod) router.addSource(new githubMod.GitHubSource());
    if (clawhubMod) router.addSource(new clawhubMod.ClawHubSource());

    return router;
  }
}
