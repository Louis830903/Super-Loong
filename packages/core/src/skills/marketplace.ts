/**
 * Skill Marketplace — search, install, and manage skills from remote repositories.
 *
 * Supports multiple sources:
 * - GitHub repositories (ClawHub-style)
 * - Registry APIs (agentskills.io-style)
 * - Custom registries
 */

import pino from "pino";
import { v4 as uuid } from "uuid";
import { parseSkillFile } from "./parser.js";
import type { SkillFormat } from "./parser.js";
import { saveInstalledSkill, loadInstalledSkills, deleteInstalledSkill } from "../persistence/sqlite.js";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { scanSkill, shouldAllowInstall, contentHash, type ScanResult } from "./guard.js";
import { SkillLockfileManager } from "./lockfile.js";
import { SourceRouter } from "./sources/router.js";
import type { SkillMeta } from "./sources/base.js";

const logger = pino({ name: "skill-marketplace" });

// B-16: SSRF 防护 — 域名白名单
const ALLOWED_HOSTS = [
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "www.skillhub.club",
  "api.github.com",
];

function validateDownloadUrl(sourceUrl: string): void {
  const url = new URL(sourceUrl);
  if (!ALLOWED_HOSTS.includes(url.hostname) && !url.hostname.endsWith(".github.io")) {
    throw new Error(`SSRF blocked: ${url.hostname} not in allowed hosts`);
  }
}

export interface MarketplaceSource {
  name: string;
  baseUrl: string;
  type: "github" | "registry" | "skillhub";
}

export interface SkillMarketEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
  rating?: number;
  tags?: string[];
  format: SkillFormat;
  sourceUrl: string;
  sourceName: string;
}

export interface InstalledSkill {
  id: string;
  name: string;
  source: string;
  sourceUrl?: string;
  version: string;
  format: SkillFormat;
  installedAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface SkillInstallResult {
  success: boolean;
  skillId: string;
  name: string;
  version: string;
  format: SkillFormat;
  error?: string;
}

const DEFAULT_SOURCES: MarketplaceSource[] = [
  {
    name: "skillhub",
    baseUrl: "https://www.skillhub.club/api",
    type: "skillhub",
  },
  {
    name: "clawhub",
    baseUrl: "https://api.github.com/repos/letta-ai/letta-skills",
    type: "github",
  },
];

export class SkillMarketplace {
  private sources: MarketplaceSource[];
  private skillsDir: string;
  private lockfileManager: SkillLockfileManager;
  private sourceRouter: SourceRouter | null = null;

  constructor(skillsDir = "./skills", sources?: MarketplaceSource[]) {
    this.sources = sources ?? DEFAULT_SOURCES;
    this.skillsDir = skillsDir;
    this.lockfileManager = new SkillLockfileManager();
  }

  /** 获取锁定文件管理器（外部访问） */
  getLockfileManager(): SkillLockfileManager {
    return this.lockfileManager;
  }

  /** 设置多源路由器（可选，设置后 search 会额外查询 SourceRouter 的结果） */
  setSourceRouter(router: SourceRouter): void {
    this.sourceRouter = router;
  }

  /** Search for skills across all marketplace sources */
  async search(query: string, filters?: { source?: string; tags?: string[] }): Promise<SkillMarketEntry[]> {
    const results: SkillMarketEntry[] = [];

    // Spec v3: 优先通过 SourceRouter 多源搜索（如果已设置）
    if (this.sourceRouter && !filters?.source) {
      try {
        const routerResults = await this.sourceRouter.unifiedSearch(query, 30);
        for (const meta of routerResults) {
          results.push(this.skillMetaToMarketEntry(meta));
        }
      } catch (err: any) {
        logger.warn({ error: err.message }, "SourceRouter search failed, falling back to legacy sources");
      }
    }

    // 继续使用传统源进行搜索（去重）
    const seen = new Set(results.map((r) => r.name.toLowerCase()));
    for (const source of this.sources) {
      if (filters?.source && source.name !== filters.source) continue;

      try {
        let entries: SkillMarketEntry[] = [];
        if (source.type === "github") {
          entries = await this.searchGitHub(source, query);
        } else if (source.type === "skillhub") {
          entries = await this.searchSkillHub(source, query);
        } else {
          entries = await this.searchRegistry(source, query);
        }
        // 去重: 跳过 SourceRouter 已返回的结果
        for (const entry of entries) {
          if (!seen.has(entry.name.toLowerCase())) {
            seen.add(entry.name.toLowerCase());
            results.push(entry);
          }
        }
      } catch (err: any) {
        logger.warn({ source: source.name, error: err.message }, "Failed to search marketplace source");
      }
    }

    return results;
  }

  /** 将 SourceRouter 的 SkillMeta 转换为 SkillMarketEntry */
  private skillMetaToMarketEntry(meta: SkillMeta): SkillMarketEntry {
    return {
      id: `src_${meta.source}_${meta.name.replace(/[^a-zA-Z0-9]/g, "_")}`,
      name: meta.name,
      description: meta.description,
      version: meta.version ?? "1.0.0",
      tags: meta.tags,
      format: "hermes",
      // SourceRouter 的结果使用 identifier 作为下载标识
      sourceUrl: meta.identifier,
      sourceName: meta.source,
    };
  }

  /** Install a skill from a remote source */
  async install(sourceUrl: string, sourceName = "marketplace"): Promise<SkillInstallResult> {
    try {
      // B-16: SSRF 防护 — 校验 URL 域名白名单
      validateDownloadUrl(sourceUrl);

      // Generate candidate URLs to handle different repo structures
      // OpenClaw repos use directory/SKILL.md pattern, not name.md
      const candidateUrls = this.generateCandidateUrls(sourceUrl);

      let content: string | null = null;
      let usedUrl = sourceUrl;

      for (const url of candidateUrls) {
        try {
          const resp = await fetch(url, {
            headers: { "User-Agent": "SuperAgent/1.0" },
          });
          if (resp.ok) {
            content = await resp.text();
            usedUrl = url;
            logger.info({ url }, "Skill content fetched successfully");
            break;
          }
          logger.debug({ url, status: resp.status }, "Candidate URL failed, trying next");
        } catch (e: any) {
          logger.debug({ url, error: e.message }, "Candidate URL network error, trying next");
        }
      }

      if (!content) {
        throw new Error(
          `All candidate URLs returned non-200 (tried ${candidateUrls.length} patterns). ` +
          `URLs tried: ${candidateUrls.join(" , ")}`
        );
      }

      const parsed = parseSkillFile(content, usedUrl);

      // Ensure skills directory exists
      if (!existsSync(this.skillsDir)) {
        mkdirSync(this.skillsDir, { recursive: true });
      }

      // Write skill file to local directory
      const fileName = `${parsed.frontmatter.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
      const filePath = join(this.skillsDir, fileName);
      writeFileSync(filePath, content, "utf-8");

      // Save to installed skills database
      const id = `skill_${uuid().slice(0, 8)}`;
      const now = new Date().toISOString();
      saveInstalledSkill({
        id,
        name: parsed.frontmatter.name,
        source: sourceName,
        sourceUrl: usedUrl,  // Use the URL that actually succeeded (may differ from original after fallback)
        version: parsed.frontmatter.version ?? "1.0.0",
        format: parsed.format,
        installedAt: now,
        updatedAt: now,
        metadata: {
          description: parsed.frontmatter.description,
          filePath,
        },
      });

      // Spec v3 Task 1: 安全审计 — 安装后扫描技能目录
      let scanResult: ScanResult | undefined;
      try {
        scanResult = scanSkill(this.skillsDir, sourceName, "community");
        const policy = shouldAllowInstall(scanResult);
        if (policy === "block") {
          // 安全策略拒绝 — 回滚安装
          try { unlinkSync(filePath); } catch { /* ignore */ }
          logger.warn({ id, verdict: scanResult.verdict, findings: scanResult.findings.length }, "Skill blocked by security policy");
          return {
            success: false,
            skillId: "",
            name: parsed.frontmatter.name,
            version: parsed.frontmatter.version ?? "1.0.0",
            format: parsed.format,
            error: `Security scan verdict: ${scanResult.verdict} (${scanResult.summary}). Installation blocked.`,
          };
        }
      } catch (scanErr: any) {
        logger.warn({ error: scanErr.message }, "Security scan failed, proceeding with caution");
      }

      logger.info({ id, name: parsed.frontmatter.name, format: parsed.format, verdict: scanResult?.verdict }, "Skill installed");

      // Spec v3: 记录安装到 lockfile
      try {
        this.lockfileManager.recordInstall(parsed.frontmatter.name, {
          source: sourceName,
          identifier: usedUrl,
          trustLevel: "community",
          verdict: scanResult?.verdict ?? "unknown",
          contentHash: contentHash(content),
          installPath: filePath,
          version: parsed.frontmatter.version,
          sourceUrl: usedUrl,
        });
      } catch (lockErr: any) {
        logger.warn({ error: lockErr.message }, "Failed to record install in lockfile");
      }

      return {
        success: true,
        skillId: id,
        name: parsed.frontmatter.name,
        version: parsed.frontmatter.version ?? "1.0.0",
        format: parsed.format,
      };
    } catch (err: any) {
      logger.error({ sourceUrl, error: err.message }, "Skill installation failed");
      return {
        success: false,
        skillId: "",
        name: "",
        version: "",
        format: "unknown",
        error: err.message,
      };
    }
  }

  /** Uninstall a skill */
  async uninstall(skillId: string): Promise<void> {
    const installed = this.listInstalled();
    const skill = installed.find((s) => s.id === skillId);
    if (skill) {
      // Remove file if exists
      const filePath = (skill.metadata as any)?.filePath;
      if (filePath && existsSync(filePath)) {
        try { unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    deleteInstalledSkill(skillId);

    // Spec v3: 记录卸载到 lockfile
    if (skill) {
      try {
        this.lockfileManager.recordUninstall(skill.name);
      } catch (lockErr: any) {
        logger.warn({ error: lockErr.message }, "Failed to record uninstall in lockfile");
      }
    }

    logger.info({ skillId }, "Skill uninstalled");
  }

  /** List installed skills */
  listInstalled(): InstalledSkill[] {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = loadInstalledSkills();
    } catch {
      // DB not initialized — return empty list
      return [];
    }
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      source: row.source as string,
      sourceUrl: row.sourceUrl as string | undefined,
      version: row.version as string,
      format: row.format as SkillFormat,
      installedAt: row.installedAt as string,
      updatedAt: row.updatedAt as string,
      metadata: row.metadata as Record<string, unknown>,
    }));
  }

  /** Alias for listInstalled */
  getInstalled(): InstalledSkill[] {
    return this.listInstalled();
  }

  /** Get marketplace sources */
  getSources(): MarketplaceSource[] {
    return this.sources;
  }

  /**
   * Generate candidate download URLs for a given sourceUrl.
   * OpenClaw repos store skills as directories containing SKILL.md,
   * so we try multiple URL patterns when the original URL might be wrong.
   *
   * Also handles SkillHub entries that encode "/" as "-" in fragments
   * (e.g. "skills-commit" should be "skills/commit").
   */
  private generateCandidateUrls(sourceUrl: string): string[] {
    const urls: string[] = [sourceUrl];

    if (!sourceUrl.includes("raw.githubusercontent.com")) return urls;

    // Strategy 1: If URL ends with some .md, try directory/SKILL.md pattern
    if (sourceUrl.endsWith(".md") && !sourceUrl.endsWith("/SKILL.md")) {
      const withoutMd = sourceUrl.slice(0, -3);
      urls.push(`${withoutMd}/SKILL.md`);
      urls.push(`${withoutMd}/README.md`);
    }

    // Strategy 2 & 3: Handle "-" encoded directory separators in path
    // SkillHub fragments encode "/" as "-", but skill names also contain "-"
    // e.g. ".gemini-skills-self-improving-agent" → ".gemini/skills/self-improving-agent"
    const branchMarker = "/main/";
    const branchIdx = sourceUrl.indexOf(branchMarker);
    if (branchIdx >= 0) {
      const prefix = sourceUrl.slice(0, branchIdx + branchMarker.length);
      const pathAfterBranch = sourceUrl.slice(branchIdx + branchMarker.length);

      const skillMdSuffix = "/SKILL.md";
      if (pathAfterBranch.endsWith(skillMdSuffix)) {
        const dirPart = pathAfterBranch.slice(0, -skillMdSuffix.length);

        if (dirPart.includes("-") && !dirPart.includes("/")) {
          // Strategy 2: Replace ALL "-" with "/" (handles simple cases like "skills-commit")
          const allSplit = dirPart.replace(/-/g, "/");
          urls.push(`${prefix}${allSplit}${skillMdSuffix}`);

          // Strategy 3: Progressive left-to-right splitting
          // Replace hyphens one at a time from left, generating intermediate candidates
          // e.g. ".gemini-skills-self-improving-agent" →
          //   split 1: ".gemini/skills-self-improving-agent"
          //   split 2: ".gemini/skills/self-improving-agent"  ← likely correct
          //   split 3: ".gemini/skills/self/improving-agent"
          const hyphenPositions: number[] = [];
          for (let i = 0; i < dirPart.length; i++) {
            if (dirPart[i] === "-") hyphenPositions.push(i);
          }

          // Generate candidates for 1..N-1 splits (N is already Strategy 2)
          const maxSplits = Math.min(hyphenPositions.length - 1, 5);
          for (let splits = 1; splits <= maxSplits; splits++) {
            const chars = dirPart.split("");
            for (let s = 0; s < splits; s++) {
              chars[hyphenPositions[s]] = "/";
            }
            const candidate = chars.join("");
            if (candidate !== allSplit) {
              urls.push(`${prefix}${candidate}${skillMdSuffix}`);
            }
          }
        }
      }
    }

    // Strategy 4: Try alternative branch names (dev, master, develop)
    // Some repos use non-main default branches
    const mainBranch = "/main/";
    if (sourceUrl.includes(mainBranch)) {
      for (const alt of ["/dev/", "/master/", "/develop/"]) {
        urls.push(sourceUrl.replace(mainBranch, alt));
      }
    }

    return urls;
  }

  // ─── SkillHub-based search ────────────────────────────

  /**
   * Convert SkillHub repo_url (e.g. "https://github.com/user/repo#.claude~skills~name")
   * to a raw GitHub download URL for the skill SKILL.md file.
   *
   * OpenClaw repos use directory structure: skills/{author}/{name}/SKILL.md
   * Other repos may use: .claude/skills/{name}/SKILL.md
   */
  private skillHubRepoToDownloadUrl(repoUrl: string): string {
    try {
      const [base, fragment] = repoUrl.split("#");
      if (!fragment || !base.includes("github.com")) return repoUrl;

      // Use ~ as directory separator if present, otherwise keep fragment as-is
      const pathParts = fragment.includes("~")
        ? fragment.split("~")
        : [fragment];
      const dirPath = pathParts.join("/");

      // base: "https://github.com/user/repo" → "https://raw.githubusercontent.com/user/repo/main/..."
      const rawBase = base.replace("github.com", "raw.githubusercontent.com");

      // Primary: directory/SKILL.md pattern (OpenClaw standard)
      return `${rawBase}/main/${dirPath}/SKILL.md`;
    } catch {
      return repoUrl;
    }
  }

  private async searchSkillHub(source: MarketplaceSource, query: string): Promise<SkillMarketEntry[]> {
    try {
      const response = await fetch(
        `${source.baseUrl}/search?q=${encodeURIComponent(query)}&limit=20`,
        {
          headers: { "User-Agent": "SuperAgent/1.0" },
          signal: AbortSignal.timeout(30000),
        }
      );

      if (!response.ok) {
        logger.warn({ source: source.name, status: response.status }, "SkillHub search returned non-OK");
        return [];
      }
      const data = await response.json() as {
        skills?: Array<{
          id?: string;
          name?: string;
          slug?: string;
          description?: string;
          description_zh?: string;
          category?: string;
          author?: string;
          github_stars?: number;
          simple_score?: number | null;
          simple_rating?: string | null;
          repo_url?: string;
        }>;
      };

      return (data.skills ?? []).map((s) => ({
        id: `sh_${s.slug || s.id}`,
        name: s.name ?? "unknown",
        description: s.description_zh || s.description || `${s.category ?? ""} skill by ${s.author ?? "unknown"}`,
        version: "1.0.0",
        author: s.author,
        downloads: s.github_stars,
        rating: s.simple_score ?? undefined,
        tags: s.category ? [s.category] : [],
        format: "hermes" as SkillFormat,
        sourceUrl: s.repo_url ? this.skillHubRepoToDownloadUrl(s.repo_url) : "",
        sourceName: source.name,
      }));
    } catch (err: any) {
      logger.warn({ source: source.name, error: err.message }, "SkillHub search failed");
      return [];
    }
  }

  // ─── GitHub-based search ──────────────────────────────────

  private async searchGitHub(source: MarketplaceSource, query: string): Promise<SkillMarketEntry[]> {
    try {
      // Search GitHub repository contents
      const response = await fetch(`${source.baseUrl}/contents/skills`, {
        headers: {
          "User-Agent": "SuperAgent/1.0",
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return [];
      const items = await response.json() as Array<{ name: string; download_url: string; type: string }>;

      return items
        .filter((item) =>
          (item.type === "file" && item.name.endsWith(".md")) ||
          item.type === "dir"
        )
        .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
        .map((item) => ({
          id: `gh_${source.name}_${item.name}`,
          name: item.name.replace(/\.md$/, ""),
          description: `Skill from ${source.name}`,
          version: "1.0.0",
          tags: [],
          format: "openclaw" as SkillFormat,
          sourceUrl: item.download_url || `${source.baseUrl}/contents/skills/${item.name}`,
          sourceName: source.name,
        }));
    } catch {
      return [];
    }
  }

  // ─── Registry-based search ────────────────────────────────

  private async searchRegistry(source: MarketplaceSource, query: string): Promise<SkillMarketEntry[]> {
    try {
      const response = await fetch(`${source.baseUrl}/skills/search?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "SuperAgent/1.0" },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return [];
      const data = await response.json() as { skills?: Array<Record<string, unknown>> };

      return (data.skills ?? []).map((s) => ({
        id: `reg_${source.name}_${s.name}`,
        name: s.name as string,
        description: (s.description as string) || "",
        version: (s.version as string) || "1.0.0",
        author: s.author as string | undefined,
        downloads: s.downloads as number | undefined,
        rating: s.rating as number | undefined,
        tags: s.tags as string[] | undefined,
        format: (s.format as SkillFormat) || "hermes",
        sourceUrl: s.downloadUrl as string || `${source.baseUrl}/skills/${s.name}/download`,
        sourceName: source.name,
      }));
    } catch {
      return [];
    }
  }
}
