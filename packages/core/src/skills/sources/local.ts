/**
 * LocalSource — 本地目录技能源
 *
 * 对标 Hermes LocalSkillSource + OpenClaw local-loader.ts
 * 从本地 skills/ 目录及自定义路径搜索技能
 */

import pino from "pino";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { SkillSource, type SkillMeta, type SkillBundle } from "./base.js";
import type { TrustLevel } from "../guard.js";

const logger = pino({ name: "source-local" });

export class LocalSource extends SkillSource {
  readonly sourceId = "local";
  private dirs: string[];

  constructor(dirs: string[]) {
    super();
    this.dirs = dirs.filter((d) => existsSync(d));
  }

  trustLevel(): TrustLevel {
    return "trusted";
  }

  /** 添加扫描目录 */
  addDir(dir: string): void {
    if (existsSync(dir) && !this.dirs.includes(dir)) {
      this.dirs.push(dir);
    }
  }

  async search(query: string, limit = 50): Promise<SkillMeta[]> {
    const results: SkillMeta[] = [];
    const lowerQuery = query.toLowerCase();

    for (const dir of this.dirs) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);

          let name: string;
          let skillFile: string | null = null;

          if (stat.isDirectory()) {
            // 目录模式: skill-name/SKILL.md
            const skillMd = join(fullPath, "SKILL.md");
            const indexMd = join(fullPath, "index.md");
            if (existsSync(skillMd)) {
              skillFile = skillMd;
              name = entry;
            } else if (existsSync(indexMd)) {
              skillFile = indexMd;
              name = entry;
            } else {
              continue;
            }
          } else if (stat.isFile() && (entry.endsWith(".md") || entry.endsWith(".skill.md"))) {
            // 文件模式: skill-name.md
            skillFile = fullPath;
            name = basename(entry, extname(entry));
            if (entry.endsWith(".skill.md")) {
              name = basename(entry, ".skill.md");
            }
          } else {
            continue;
          }

          // 模糊匹配
          if (lowerQuery !== "*" && !name.toLowerCase().includes(lowerQuery)) {
            continue;
          }

          // 读取描述
          let description = `Local skill: ${name}`;
          try {
            const content = readFileSync(skillFile, "utf-8");
            // 尝试从第一行非空非 frontmatter 内容提取描述
            const lines = content.split("\n");
            let inFrontmatter = false;
            for (const line of lines) {
              if (line.trim() === "---") {
                inFrontmatter = !inFrontmatter;
                continue;
              }
              if (inFrontmatter) continue;
              const trimmed = line.replace(/^#+\s*/, "").trim();
              if (trimmed.length > 0) {
                description = trimmed.slice(0, 200);
                break;
              }
            }
          } catch { /* ignore */ }

          results.push({
            name,
            description,
            source: this.sourceId,
            identifier: `local:${fullPath}`,
            trustLevel: this.trustLevel(),
          });

          if (results.length >= limit) break;
        }
      } catch (err: any) {
        logger.debug({ dir, error: err.message }, "Local source scan failed");
      }
    }

    return results.slice(0, limit);
  }

  async fetch(identifier: string): Promise<SkillBundle | null> {
    // identifier 格式: "local:/absolute/path/to/skill.md" 或 "local:/path/to/dir"
    const match = identifier.match(/^local:(.+)$/);
    if (!match) return null;

    const target = match[1];
    if (!existsSync(target)) return null;

    try {
      const stat = statSync(target);
      const files = new Map<string, string>();

      if (stat.isDirectory()) {
        // 读取目录下所有 .md 文件
        const entries = readdirSync(target);
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          const filePath = join(target, entry);
          if (statSync(filePath).isFile() && entry.endsWith(".md")) {
            files.set(entry, readFileSync(filePath, "utf-8"));
          }
        }
        const name = basename(target);
        return { name, files, source: this.sourceId, identifier, trustLevel: this.trustLevel() };
      } else if (stat.isFile()) {
        const content = readFileSync(target, "utf-8");
        const name = basename(target, extname(target));
        files.set(basename(target), content);
        return { name, files, source: this.sourceId, identifier, trustLevel: this.trustLevel() };
      }
    } catch (err: any) {
      logger.debug({ target, error: err.message }, "Local source fetch failed");
    }

    return null;
  }
}
