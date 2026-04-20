/**
 * ClawHubSource — ClawHub (GitHub-based) 技能源
 *
 * 对标 OpenClaw skills-clawhub.ts + Hermes ClawHubSource
 * 从 ClawHub 仓库（GitHub 上的技能集合）搜索和获取技能
 */

import pino from "pino";
import { SkillSource, type SkillMeta, type SkillBundle } from "./base.js";
import type { TrustLevel } from "../guard.js";

const logger = pino({ name: "source-clawhub" });

/** ClawHub 注册表配置 */
export interface ClawHubRegistry {
  owner: string;
  repo: string;
  branch?: string;
  skillsPath?: string;
}

const DEFAULT_REGISTRIES: ClawHubRegistry[] = [
  { owner: "anthropics", repo: "courses", skillsPath: "skills" },
  { owner: "letta-ai", repo: "letta-skills", skillsPath: "skills" },
];

export class ClawHubSource extends SkillSource {
  readonly sourceId = "clawhub";
  private registries: ClawHubRegistry[];

  constructor(registries?: ClawHubRegistry[]) {
    super();
    this.registries = registries ?? DEFAULT_REGISTRIES;
  }

  trustLevel(): TrustLevel {
    return "community";
  }

  /** 添加自定义注册表 */
  addRegistry(registry: ClawHubRegistry): void {
    if (!this.registries.some((r) => r.owner === registry.owner && r.repo === registry.repo)) {
      this.registries.push(registry);
    }
  }

  async search(query: string, limit = 20): Promise<SkillMeta[]> {
    const results: SkillMeta[] = [];
    const lowerQuery = query.toLowerCase();

    // 使用标签循环，达到 limit 后提前终止所有层级，避免多余 HTTP 请求
    outer: for (const reg of this.registries) {
      try {
        const branch = reg.branch ?? "main";
        const path = reg.skillsPath ?? "skills";
        const url = `https://api.github.com/repos/${reg.owner}/${reg.repo}/contents/${path}?ref=${branch}`;

        const resp = await fetch(url, {
          headers: {
            "User-Agent": "SuperAgent/1.0",
            Accept: "application/vnd.github.v3+json",
            ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {}),
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) continue;
        const items = (await resp.json()) as Array<{ name: string; type: string; path: string }>;

        for (const item of items) {
          // 支持目录（OpenClaw 模式: skill-name/SKILL.md）和文件（直接 .md）
          const nameKey = item.name.replace(/\.md$/, "");
          if (nameKey.toLowerCase().includes(lowerQuery) || lowerQuery === "*") {
            results.push({
              name: nameKey,
              description: `Skill from ${reg.owner}/${reg.repo}`,
              source: this.sourceId,
              identifier: `clawhub:${reg.owner}/${reg.repo}/${item.path}`,
              trustLevel: this.trustLevel(),
              tags: [],
            });
            if (results.length >= limit) break outer;
          }
        }
      } catch (err: any) {
        logger.debug({ registry: `${reg.owner}/${reg.repo}`, error: err.message }, "ClawHub search failed");
      }
    }

    return results.slice(0, limit);
  }

  async fetch(identifier: string): Promise<SkillBundle | null> {
    // identifier 格式: "clawhub:owner/repo/path/to/skill"
    const match = identifier.match(/^clawhub:([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) return null;

    const [, owner, repo, skillPath] = match;

    // 根据 owner/repo 找到对应 registry 以获取正确的 branch 配置
    const registry = this.registries.find(
      (r) => r.owner === owner && r.repo === repo,
    );
    const branch = registry?.branch ?? "main";
    const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;

    // 尝试多种路径模式（对标 OpenClaw 目录结构）
    const candidates = [
      `${rawBase}/${skillPath}/SKILL.md`,     // 目录模式
      `${rawBase}/${skillPath}`,               // 直接文件
      `${rawBase}/${skillPath}.md`,            // 追加 .md
      `${rawBase}/${skillPath}/README.md`,     // README 模式
    ];

    for (const url of candidates) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "SuperAgent/1.0" },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) continue;

        const content = await resp.text();
        // 确认是有效的 Markdown 内容（非 HTML 404 页面）
        if (content.startsWith("<!DOCTYPE") || content.startsWith("<html")) continue;

        const name = skillPath.split("/").pop()?.replace(/\.md$/, "") ?? "unknown";
        const files = new Map<string, string>();
        files.set("SKILL.md", content);

        return {
          name,
          files,
          source: this.sourceId,
          identifier,
          trustLevel: this.trustLevel(),
          metadata: { owner, repo, path: skillPath },
        };
      } catch {
        continue;
      }
    }

    return null;
  }
}
