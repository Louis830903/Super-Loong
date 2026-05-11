/**
 * 工具自动发现与评估 — 定期扫描 npm registry 和 MCP Hub，发现新工具并评估。
 *
 * 扫描渠道：
 *   - npm registry：按关键词搜索
 *   - MCP Hub（GitHub 官方 marketplace）
 *
 * 评估维度：
 *   - 下载量/Star 数（社区验证）
 *   - 最近更新时间（活跃度）
 *   - 与现有工具去重（避免功能重叠）
 *   - 安全评分（检查依赖树中的已知漏洞）
 *
 * 输出"推荐集成列表"：前端展示 + 用户确认后安装。
 */

import pino from "pino";
import { execSync } from "node:child_process";

const logger = pino({ name: "tool-discoverer" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 发现的工具来源 */
export type DiscoverySource = "npm" | "mcp_hub" | "skill_market" | "local";

/** 发现的工具条目 */
export interface DiscoveredTool {
  /** 唯一标识 */
  id: string;
  /** 工具名称 */
  name: string;
  /** 包名/标识符 */
  identifier: string;
  /** 来源 */
  source: DiscoverySource;
  /** 描述 */
  description: string;
  /** 版本 */
  version?: string;
  /** 作者/维护者 */
  author?: string;
  /** npm 下载量（周） */
  weeklyDownloads?: number;
  /** GitHub Stars */
  stars?: number;
  /** 最近更新时间 */
  lastUpdated?: Date;
  /** 首页链接 */
  homepage?: string;
  /** 仓库链接 */
  repository?: string;
  /** 关键词 */
  keywords: string[];
  /** 许可证 */
  license?: string;
}

/** 工具评估结果 */
export interface ToolEvaluation {
  /** 被评估的工具 */
  tool: DiscoveredTool;
  /** 综合分数 (0-100) */
  score: number;
  /** 社区验证分 (0-100) */
  communityScore: number;
  /** 活跃度分 (0-100) */
  activityScore: number;
  /** 安全分 (0-100) */
  securityScore: number;
  /** 新颖度分 (与已有工具不重叠) */
  noveltyScore: number;
  /** 推荐等级 */
  recommendation: "strongly_recommended" | "recommended" | "neutral" | "not_recommended";
  /** 与已有工具重复的检测结果 */
  dedupWarnings: string[];
  /** 安全风险提示 */
  securityWarnings: string[];
  /** 评估时间 */
  evaluatedAt: Date;
}

/** 发现器配置 */
export interface DiscovererConfig {
  /** npm 搜索关键词 */
  npmKeywords: string[];
  /** MCP Hub 仓库列表 */
  mcpHubRepos: string[];
  /** 最低推荐分（默认 60） */
  minRecommendationScore: number;
  /** 缓存有效期（毫秒，默认 1 小时） */
  cacheTTL: number;
  /** npm search 超时时间（毫秒） */
  npmSearchTimeout: number;
  /** 是否启用 npm 搜索 */
  enableNpmSearch: boolean;
  /** 是否启用 MCP Hub 搜索 */
  enableMcpHubSearch: boolean;
}

const DEFAULT_CONFIG: DiscovererConfig = {
  npmKeywords: [
    "agent-tool",
    "mcp-server",
    "model-context-protocol",
    "playwright",
    "puppeteer",
    "browser-automation",
    "desktop-automation",
    "computer-use",
    "ai-agent",
    "llm-tool",
  ],
  mcpHubRepos: [
    "modelcontextprotocol/servers",
    "anthropics/mcp-servers",
  ],
  minRecommendationScore: 60,
  cacheTTL: 60 * 60 * 1000, // 1 小时
  npmSearchTimeout: 30000,
  enableNpmSearch: true,
  enableMcpHubSearch: true,
};

// ═══════════════════════════════════════════════════════════════
// 工具自动发现器
// ═══════════════════════════════════════════════════════════════

export class ToolDiscoverer {
  private config: DiscovererConfig;
  /** 已发现的工具缓存 */
  private discoveredCache: DiscoveredTool[] = [];
  /** 缓存时间戳 */
  private cacheTimestamp: Date = new Date(0);
  /** 已有的工具名称集合（用于去重） */
  private existingToolNames: Set<string> = new Set();

  constructor(config?: Partial<DiscovererConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置已有工具名称（用于去重判断）。
   */
  setExistingTools(toolNames: string[]): void {
    this.existingToolNames = new Set(toolNames.map(n => n.toLowerCase()));
  }

  /**
   * 添加已有工具名称。
   */
  addExistingTool(toolName: string): void {
    this.existingToolNames.add(toolName.toLowerCase());
  }

  /**
   * 执行发现扫描（利用缓存）。
   */
  async discover(forceRefresh = false): Promise<DiscoveredTool[]> {
    if (!forceRefresh && this.isCacheValid()) {
      logger.debug("Using cached discoveries");
      return this.discoveredCache;
    }

    const allTools: DiscoveredTool[] = [];

    if (this.config.enableNpmSearch) {
      try {
        const npmTools = await this.discoverNpm();
        allTools.push(...npmTools);
      } catch (err) {
        logger.warn({ err }, "npm discovery failed");
      }
    }

    if (this.config.enableMcpHubSearch) {
      try {
        const mcpTools = await this.discoverMcpHub();
        allTools.push(...mcpTools);
      } catch (err) {
        logger.warn({ err }, "MCP Hub discovery failed");
      }
    }

    // 去重
    const seen = new Set<string>();
    const unique = allTools.filter(t => {
      const key = `${t.source}:${t.identifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.discoveredCache = unique;
    this.cacheTimestamp = new Date();

    logger.info({ total: unique.length }, "Tool discovery complete");
    return unique;
  }

  /**
   * 评估发现的所有工具。
   */
  evaluate(discoveries?: DiscoveredTool[]): ToolEvaluation[] {
    const tools = discoveries ?? this.discoveredCache;
    return tools.map(tool => this.evaluateTool(tool))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 获取推荐集成列表。
   */
  getRecommendations(minScore?: number): ToolEvaluation[] {
    const evaluations = this.evaluate();
    const threshold = minScore ?? this.config.minRecommendationScore;
    return evaluations.filter(
      e => e.score >= threshold &&
        e.recommendation !== "not_recommended" &&
        e.dedupWarnings.length === 0,
    );
  }

  /**
   * 获取推荐安装的 MCP server 列表。
   */
  getRecommendedMcpServers(): ToolEvaluation[] {
    return this.getRecommendations().filter(e => e.tool.source === "mcp_hub");
  }

  /**
   * 获取推荐安装的 npm 包列表。
   */
  getRecommendedNpmPackages(): ToolEvaluation[] {
    return this.getRecommendations().filter(e => e.tool.source === "npm");
  }

  // ─── npm 发现 ───────────────────────────────────────────

  /**
   * 从 npm registry 搜索工具。
   */
  private async discoverNpm(): Promise<DiscoveredTool[]> {
    const tools: DiscoveredTool[] = [];

    for (const keyword of this.config.npmKeywords) {
      try {
        const output = execSync(
          `npm search "${keyword}" --json --long 2>nul`,
          {
            encoding: "utf-8",
            timeout: this.config.npmSearchTimeout,
            windowsHide: true,
          },
        );

        if (!output.trim()) continue;

        const results = JSON.parse(output);
        if (!Array.isArray(results)) continue;

        for (const pkg of results.slice(0, 10)) {
          const tool = this.parseNpmResult(pkg, keyword);
          if (tool) tools.push(tool);
        }
      } catch (err) {
        logger.warn({ keyword, err: String(err) }, "npm search failed for keyword");
      }
    }

    logger.info({ count: tools.length }, "npm discovery complete");
    return tools;
  }

  /**
   * 解析 npm 搜索结果。
   */
  private parseNpmResult(pkg: Record<string, unknown>, sourceKeyword: string): DiscoveredTool | null {
    const name = String(pkg.name ?? "");
    if (!name) return null;

    // 跳过明显不相关的包
    if (name.startsWith("@types/")) return null;

    return {
      id: `npm_${name.replace(/[@/]/g, "_")}`,
      name,
      identifier: name,
      source: "npm",
      description: String(pkg.description ?? ""),
      version: String(pkg.version ?? ""),
      author: pkg.author ? (typeof pkg.author === "string" ? pkg.author : (pkg.author as Record<string, unknown>)?.name as string ?? "") : undefined,
      weeklyDownloads: typeof pkg.weeklyDownloads === "number" ? pkg.weeklyDownloads : undefined,
      lastUpdated: pkg.modified ? new Date(String(pkg.modified)) : undefined,
      homepage: typeof pkg.homepage === "string" ? pkg.homepage : undefined,
      repository: typeof pkg.repository === "string" ? pkg.repository : undefined,
      keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [sourceKeyword],
      license: typeof pkg.license === "string" ? pkg.license : undefined,
    };
  }

  // ─── MCP Hub 发现 ───────────────────────────────────────

  /**
   * 从 MCP Hub 发现工具。
   * 当前使用 GitHub REST API 查询已知的 MCP servers 仓库。
   */
  private async discoverMcpHub(): Promise<DiscoveredTool[]> {
    const tools: DiscoveredTool[] = [];

    for (const repo of this.config.mcpHubRepos) {
      try {
        // 使用 GitHub API 获取仓库内容
        // 注意：生产环境需要 GitHub token 来避免 rate limit
        const output = execSync(
          `curl -s -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/${repo}/contents" 2>nul`,
          {
            encoding: "utf-8",
            timeout: 15000,
            windowsHide: true,
          },
        );

        if (!output.trim()) continue;

        let contents: Array<Record<string, unknown>>;
        try {
          contents = JSON.parse(output);
          if (!Array.isArray(contents)) continue;
        } catch {
          continue;
        }

        // 遍历目录条目
        for (const item of contents.slice(0, 20)) {
          if (item.type !== "dir") continue;
          const name = String(item.name);
          if (name.startsWith(".")) continue;

          // 尝试获取该目录下的 README.md
          let description = "MCP Server";
          try {
            const readmeOutput = execSync(
              `curl -s -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/${repo}/contents/${name}/README.md" 2>nul`,
              {
                encoding: "utf-8",
                timeout: 10000,
                windowsHide: true,
              },
            );
            const readmeJson = JSON.parse(readmeOutput);
            if (readmeJson.content) {
              const decoded = Buffer.from(readmeJson.content, "base64").toString("utf-8").slice(0, 300);
              description = decoded.split("\n").find(l => l.trim() && !l.startsWith("#") && l.length > 20)?.trim() ?? "MCP Server";
            }
          } catch { /* skip */ }

          tools.push({
            id: `mcp_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
            name,
            identifier: name,
            source: "mcp_hub",
            description,
            repository: `https://github.com/${repo}/tree/main/${name}`,
            keywords: [name.toLowerCase(), "mcp", "mcp-server"],
            stars: undefined,
          });
        }
      } catch (err) {
        logger.warn({ repo, err: String(err) }, "MCP Hub discovery failed for repo");
      }
    }

    logger.info({ count: tools.length }, "MCP Hub discovery complete");
    return tools;
  }

  // ─── 工具评估 ───────────────────────────────────────────

  /**
   * 评估单个工具。
   */
  private evaluateTool(tool: DiscoveredTool): ToolEvaluation {
    const communityScore = this.scoreCommunity(tool);
    const activityScore = this.scoreActivity(tool);
    const securityScore = this.scoreSecurity(tool);
    const { noveltyScore, dedupWarnings } = this.scoreNovelty(tool);
    const securityWarnings = this.collectSecurityWarnings(tool);

    // 加权综合分数
    const score = Math.round(
      communityScore * 0.3 +
      activityScore * 0.2 +
      securityScore * 0.25 +
      noveltyScore * 0.25,
    );

    let recommendation: ToolEvaluation["recommendation"];
    if (score >= 80 && dedupWarnings.length === 0 && securityWarnings.length === 0) {
      recommendation = "strongly_recommended";
    } else if (score >= 60 && dedupWarnings.length <= 1) {
      recommendation = "recommended";
    } else if (score >= 40) {
      recommendation = "neutral";
    } else {
      recommendation = "not_recommended";
    }

    return {
      tool,
      score,
      communityScore,
      activityScore,
      securityScore,
      noveltyScore,
      recommendation,
      dedupWarnings,
      securityWarnings,
      evaluatedAt: new Date(),
    };
  }

  /**
   * 社区验证分：基于下载量和 Star 数。
   */
  private scoreCommunity(tool: DiscoveredTool): number {
    let score = 30; // 基础分

    // 周下载量（npm）
    if (tool.weeklyDownloads !== undefined) {
      if (tool.weeklyDownloads > 100000) score = 100;
      else if (tool.weeklyDownloads > 10000) score = 80;
      else if (tool.weeklyDownloads > 1000) score = 60;
      else if (tool.weeklyDownloads > 100) score = 45;
      else score = 30;
    }

    // GitHub Stars
    if (tool.stars !== undefined) {
      if (tool.stars > 5000) score = Math.max(score, 100);
      else if (tool.stars > 1000) score = Math.max(score, 85);
      else if (tool.stars > 100) score = Math.max(score, 65);
      else if (tool.stars > 10) score = Math.max(score, 45);
    }

    return score;
  }

  /**
   * 活跃度分：基于最近更新时间。
   */
  private scoreActivity(tool: DiscoveredTool): number {
    if (!tool.lastUpdated) return 50;

    const daysSinceUpdate = (Date.now() - tool.lastUpdated.getTime()) / (24 * 60 * 60 * 1000);

    if (daysSinceUpdate < 30) return 100;
    if (daysSinceUpdate < 90) return 80;
    if (daysSinceUpdate < 180) return 60;
    if (daysSinceUpdate < 365) return 40;
    return 20;
  }

  /**
   * 安全分：基于许可证和已知风险。
   */
  private scoreSecurity(tool: DiscoveredTool): number {
    let score = 50; // 基础分

    // 许可证检查
    const safeLicenses = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense"];
    const riskyLicenses = ["GPL-3.0", "AGPL-3.0", "proprietary"];

    if (tool.license) {
      if (safeLicenses.includes(tool.license)) score = 80;
      else if (riskyLicenses.includes(tool.license)) score = 40;
      else score = 60;
    }

    // 名称检查（已知恶意包模式）
    const suspiciousPatterns = [
      /typosquat/i, /trojan/i, /malware/i, /backdoor/i,
    ];
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(tool.description)) {
        score = Math.min(score, 20);
      }
    }

    return score;
  }

  /**
   * 新颖度分：与已有工具的去重检查。
   */
  private scoreNovelty(tool: DiscoveredTool): { noveltyScore: number; dedupWarnings: string[] } {
    const warnings: string[] = [];
    let score = 100;

    const toolNameLower = tool.name.toLowerCase();
    const toolDescLower = tool.description.toLowerCase();

    // 检查名称重叠
    for (const existing of this.existingToolNames) {
      const existingLower = existing.toLowerCase();

      // 名称完全相同的
      if (toolNameLower === existingLower) {
        warnings.push(`工具名 "${tool.name}" 已存在`);
        score -= 40;
      }
      // 名称包含关系
      else if (toolNameLower.includes(existingLower) || existingLower.includes(toolNameLower)) {
        warnings.push(`工具名 "${tool.name}" 与已有工具 "${existing}" 相似`);
        score -= 20;
      }
    }

    // 检查关键词重叠
    let keywordOverlap = 0;
    for (const kw of tool.keywords) {
      if (this.existingToolNames.has(kw.toLowerCase())) {
        keywordOverlap++;
      }
    }
    if (keywordOverlap >= 3) {
      warnings.push(`关键词高度重叠（${keywordOverlap} 个匹配）`);
      score -= 15;
    }

    return { noveltyScore: Math.max(0, score), dedupWarnings: warnings };
  }

  /**
   * 收集安全警告。
   */
  private collectSecurityWarnings(tool: DiscoveredTool): string[] {
    const warnings: string[] = [];

    if (!tool.license) {
      warnings.push("缺少许可证信息");
    }

    if (!tool.repository && tool.source !== "mcp_hub") {
      warnings.push("缺少代码仓库链接");
    }

    if (!tool.lastUpdated) {
      warnings.push("无法确定最近更新时间");
    } else {
      const daysSinceUpdate = (Date.now() - tool.lastUpdated.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceUpdate > 365) {
        warnings.push(`超过一年未更新（${Math.floor(daysSinceUpdate)} 天）`);
      }
    }

    return warnings;
  }

  // ─── 缓存管理 ───────────────────────────────────────────

  /**
   * 检查缓存是否有效。
   */
  private isCacheValid(): boolean {
    if (this.discoveredCache.length === 0) return false;
    return (Date.now() - this.cacheTimestamp.getTime()) < this.config.cacheTTL;
  }

  /**
   * 清除缓存。
   */
  clearCache(): void {
    this.discoveredCache = [];
    this.cacheTimestamp = new Date(0);
    logger.info("Discovery cache cleared");
  }

  /**
   * 获取缓存时间戳。
   */
  get lastDiscoveryTime(): Date {
    return this.cacheTimestamp;
  }
}
