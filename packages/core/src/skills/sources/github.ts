/**
 * GitHubSource — GitHub 仓库技能源
 *
 * 对标 Hermes GitHubSource (tools/skills_hub.py L284-L700)
 * 支持从 GitHub 仓库搜索和获取技能
 */

import pino from "pino";
import { SkillSource, type SkillMeta, type SkillBundle } from "./base.js";
import type { TrustLevel } from "../guard.js";

const logger = pino({ name: "source-github" });

/** GitHub Tap 配置 (对标 Hermes TapsManager) */
export interface GitHubTap {
  repo: string;   // 格式: "owner/repo"
  path?: string;  // 技能目录路径，默认 "skills"
  branch?: string; // 默认 "main"
}

const DEFAULT_TAPS: GitHubTap[] = [
  { repo: "anthropics/courses", path: "skills" },
];

export class GitHubSource extends SkillSource {
  readonly sourceId = "github";
  private taps: GitHubTap[];

  constructor(taps?: GitHubTap[]) {
    super();
    this.taps = taps ?? DEFAULT_TAPS;
  }

  trustLevel(): TrustLevel {
    return "community";
  }

  /** 添加自定义 tap */
  addTap(tap: GitHubTap): void {
    if (!this.taps.some((t) => t.repo === tap.repo)) {
      this.taps.push(tap);
    }
  }

  async search(query: string, limit = 20): Promise<SkillMeta[]> {
    const results: SkillMeta[] = [];
    const lowerQuery = query.toLowerCase();

    // 使用标签循环，达到 limit 后提前终止所有层级，避免多余 HTTP 请求
    outer: for (const tap of this.taps) {
      try {
        const branch = tap.branch ?? "main";
        const skillsPath = tap.path ?? "skills";
        const url = `https://api.github.com/repos/${tap.repo}/contents/${skillsPath}?ref=${branch}`;
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "SuperAgent/1.0",
            Accept: "application/vnd.github.v3+json",
            ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) continue;
        const items = await resp.json() as Array<{ name: string; type: string; path: string }>;

        for (const item of items) {
          if (item.name.toLowerCase().includes(lowerQuery) || lowerQuery === "*") {
            results.push({
              name: item.name.replace(/\.md$/, ""),
              description: `Skill from ${tap.repo}`,
              source: this.sourceId,
              identifier: `github:${tap.repo}/${item.path}`,
              trustLevel: this.trustLevel(),
              tags: [],
            });
            if (results.length >= limit) break outer;
          }
        }
      } catch (err: any) {
        logger.debug({ repo: tap.repo, error: err.message }, "GitHub search failed for tap");
      }
    }

    return results.slice(0, limit);
  }

  async fetch(identifier: string): Promise<SkillBundle | null> {
    // identifier 格式: "github:owner/repo/path/to/skill"
    const match = identifier.match(/^github:([^/]+\/[^/]+)\/(.+)$/);
    if (!match) return null;

    const [, repo, skillPath] = match;

    // 根据 repo 找到对应 tap 以获取正确的 branch 配置
    const tap = this.taps.find((t) => t.repo === repo);
    const branch = tap?.branch ?? "main";
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${skillPath}`;

    // 尝试目录/SKILL.md 和直接文件两种模式
    const candidates = [
      `${rawUrl}/SKILL.md`,
      rawUrl.endsWith(".md") ? rawUrl : `${rawUrl}.md`,
    ];

    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "SuperAgent/1.0" },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) continue;

        const content = await resp.text();
        const name = skillPath.split("/").pop()?.replace(/\.md$/, "") ?? "unknown";
        const files = new Map<string, string>();
        files.set("SKILL.md", content);

        return {
          name,
          files,
          source: this.sourceId,
          identifier,
          trustLevel: this.trustLevel(),
        };
      } catch {
        continue;
      }
    }

    return null;
  }
}
