/**
 * SkillHubSource — SkillHub 市场技能源
 *
 * 对标 Hermes SkillsShSource (tools/skills_hub.py L472-L550)
 * 从 skillhub.club API 搜索和获取技能
 */

import pino from "pino";
import { SkillSource, type SkillMeta, type SkillBundle } from "./base.js";
import type { TrustLevel } from "../guard.js";

const logger = pino({ name: "source-skillhub" });

const DEFAULT_BASE_URL = "https://www.skillhub.club/api";

export class SkillHubSource extends SkillSource {
  readonly sourceId = "skillhub";
  private baseUrl: string;

  constructor(baseUrl?: string) {
    super();
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  trustLevel(): TrustLevel {
    return "community";
  }

  async search(query: string, limit = 20): Promise<SkillMeta[]> {
    try {
      const resp = await fetch(
        `${this.baseUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
        {
          headers: { "User-Agent": "SuperAgent/1.0" },
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!resp.ok) {
        logger.warn({ status: resp.status }, "SkillHub search returned non-OK");
        return [];
      }

      const data = (await resp.json()) as {
        skills?: Array<{
          id?: string;
          name?: string;
          slug?: string;
          description?: string;
          description_zh?: string;
          category?: string;
          author?: string;
          repo_url?: string;
        }>;
      };

      return (data.skills ?? []).slice(0, limit).map((s) => ({
        name: s.name ?? s.slug ?? "unknown",
        description: s.description_zh || s.description || `Skill by ${s.author ?? "unknown"}`,
        source: this.sourceId,
        identifier: `skillhub:${s.slug || s.id}`,
        trustLevel: this.trustLevel(),
        tags: s.category ? [s.category] : [],
      }));
    } catch (err: any) {
      logger.debug({ error: err.message }, "SkillHub search failed");
      return [];
    }
  }

  async fetch(identifier: string): Promise<SkillBundle | null> {
    // identifier 格式: "skillhub:{slug}"
    const match = identifier.match(/^skillhub:(.+)$/);
    if (!match) return null;

    const slug = match[1];
    try {
      // 先从 API 获取详情以得到 repo_url
      const resp = await fetch(`${this.baseUrl}/skills/${encodeURIComponent(slug)}`, {
        headers: { "User-Agent": "SuperAgent/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) return null;
      const data = (await resp.json()) as { repo_url?: string; name?: string };
      if (!data.repo_url) return null;

      // 转换 repo_url 到 raw GitHub URL
      const downloadUrl = this.repoUrlToRawUrl(data.repo_url);
      if (!downloadUrl) return null;

      const contentResp = await fetch(downloadUrl, {
        headers: { "User-Agent": "SuperAgent/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!contentResp.ok) return null;
      const content = await contentResp.text();
      const files = new Map<string, string>();
      files.set("SKILL.md", content);

      return {
        name: data.name ?? slug,
        files,
        source: this.sourceId,
        identifier,
        trustLevel: this.trustLevel(),
      };
    } catch (err: any) {
      logger.debug({ slug, error: err.message }, "SkillHub fetch failed");
      return null;
    }
  }

  /** 将 SkillHub repo_url 转换为 raw GitHub 下载 URL */
  private repoUrlToRawUrl(repoUrl: string): string | null {
    try {
      const [base, fragment] = repoUrl.split("#");
      if (!base.includes("github.com")) return null;

      // 使用 ~ 作为目录分隔符
      const pathParts = fragment?.includes("~") ? fragment.split("~") : fragment ? [fragment] : [];
      const dirPath = pathParts.join("/");
      const rawBase = base.replace("github.com", "raw.githubusercontent.com");
      return `${rawBase}/main/${dirPath}/SKILL.md`;
    } catch {
      return null;
    }
  }
}
