/**
 * Skill Loader — discovers, parses, and hot-reloads YAML+Markdown skill files.
 *
 * Uses the multi-format parser (parseSkillFile) to support OpenClaw, Hermes,
 * and Super Agent skill formats. This replaces the previous strict Zod validation
 * which rejected skills lacking exact frontmatter fields.
 *
 * References:
 * - OpenClaw src/agents/skills/local-loader.ts
 * - Hermes agent/skill_utils.py (parse_frontmatter)
 * - Hermes agent/skill_commands.py (scan_skill_commands)
 */

import { EventEmitter } from "eventemitter3";
import { watch } from "chokidar";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import pino from "pino";
import { parseSkillFile } from "./parser.js";
import { evaluateReadiness } from "./readiness.js";
import { SkillSnapshotCache } from "./snapshot-cache.js";
import type { SkillSnapshotEntry } from "./snapshot-cache.js";
import type { Skill, SkillFrontmatter } from "../types/index.js";

const logger = pino({ name: "skill-loader" });

type SkillLoaderEvents = {
  "skill:loaded": [Skill];
  "skill:updated": [Skill];
  "skill:removed": [string];
  "skill:error": [string, Error];
};

export class SkillLoader extends EventEmitter<SkillLoaderEvents> {
  private skills: Map<string, Skill> = new Map();
  private watchDirs: string[] = [];
  private watcher: ReturnType<typeof watch> | null = null;
  // Phase 3: 双层技能缓存（学 Hermes 磁盘快照）
  private snapshotCache = new SkillSnapshotCache();

  constructor(private dirs: string[]) {
    super();
    // P2-2: Auto-discover .claude/skills directory if it exists
    const claudeSkillsDir = join(homedir(), ".claude", "skills");
    if (existsSync(claudeSkillsDir) && !dirs.includes(claudeSkillsDir)) {
      dirs.push(claudeSkillsDir);
      logger.info({ dir: claudeSkillsDir }, "Auto-discovered .claude/skills directory");
    }
    this.watchDirs = dirs;
  }

  /** Scan all configured directories and load skills. */
  loadAll(): Skill[] {
    // Phase 3: 优先走快照缓存（学 Hermes 双层缓存策略）
    const cached = this.snapshotCache.load(this.watchDirs);
    if (cached) {
      // 从快照恢复 Skill 对象（轻量恢复，不需要重新解析文件内容）
      for (const entry of cached) {
        if (!this.skills.has(entry.id)) {
          // 从快照创建轻量 Skill 对象（content 留空，按需通过 getSkill 再加载）
          const skill: Skill = {
            id: entry.id,
            frontmatter: {
              name: entry.name,
              description: entry.description,
            } as SkillFrontmatter,
            content: "",
            filePath: entry.filePath,
            enabled: true,
            loadedAt: new Date(),
          };
          this.skills.set(entry.id, skill);
          this.emit("skill:loaded", skill);
        }
      }
      logger.info({ count: this.skills.size }, "Skills loaded from snapshot cache");
      return this.listSkills();
    }

    // 缓存未命中：全量扫描
    for (const dir of this.watchDirs) {
      if (!existsSync(dir)) {
        logger.warn({ dir }, "Skill directory not found, skipping");
        continue;
      }
      this.scanDirectory(dir);
    }
    logger.info({ count: this.skills.size }, "Skills loaded (full scan)");

    // 扫描完成后持久化快照
    const entries: SkillSnapshotEntry[] = this.listSkills().map((s) => ({
      id: s.id,
      name: s.frontmatter.name,
      description: s.frontmatter.description || "",
      format: "super-agent",
      category: undefined,
      platforms: undefined,
      commands: undefined,
      filePath: s.filePath,
    }));
    this.snapshotCache.persist(this.watchDirs, undefined, entries);

    return this.listSkills();
  }

  /** Start watching for file changes (hot reload). */
  startWatching(): void {
    if (this.watcher) return;

    this.watcher = watch(this.watchDirs, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300 },
    });

    this.watcher
      .on("add", (path) => this.handleFileChange(path, "add"))
      .on("change", (path) => this.handleFileChange(path, "change"))
      .on("unlink", (path) => this.handleFileRemove(path));

    logger.info({ dirs: this.watchDirs }, "Watching for skill changes");
  }

  /** Stop watching for changes. */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Get a skill by ID. */
  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** List all loaded skills. */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** Update a skill's properties (e.g. enabled/disabled). */
  updateSkill(id: string, updates: { enabled?: boolean }): Skill | undefined {
    const skill = this.skills.get(id);
    if (!skill) return undefined;
    if (updates.enabled !== undefined) {
      skill.enabled = updates.enabled;
    }
    this.emit("skill:updated", skill);
    return skill;
  }

  /** Get a skill by name. */
  findByName(name: string): Skill | undefined {
    for (const skill of this.skills.values()) {
      if (skill.frontmatter.name === name) return skill;
    }
    return undefined;
  }

  private scanDirectory(dir: string): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          // Look for SKILL.md inside the directory
          const skillFile = join(fullPath, "SKILL.md");
          if (existsSync(skillFile)) {
            this.loadSkillFile(skillFile);
          }
        } else if (
          stat.isFile() &&
          (entry.endsWith(".md") || entry.endsWith(".skill.md"))
        ) {
          this.loadSkillFile(fullPath);
        }
      }
    } catch (error) {
      logger.error({ dir, error }, "Error scanning skill directory");
    }
  }

  private loadSkillFile(filePath: string): Skill | null {
    try {
      const raw = readFileSync(filePath, "utf-8");

      // Use the multi-format parser (supports OpenClaw, Hermes, Super Agent)
      const parsed = parseSkillFile(raw, filePath);
      const frontmatter = parsed.frontmatter;

      const id = frontmatter.name;
      const skill: Skill = {
        id,
        frontmatter,
        content: parsed.content,
        filePath,
        enabled: true,
        loadedAt: new Date(),
      };

      // Spec v3 Task 2: 计算就绪状态并缓存
      try {
        const readinessResult = evaluateReadiness(skill);
        skill.readiness = {
          status: readinessResult.status,
          missingEnvVars: readinessResult.missingEnvVars,
          missingBins: readinessResult.missingBins,
          setupHelp: readinessResult.setupHelp,
        };
      } catch {
        // 就绪检查失败不影响加载
      }

      const isUpdate = this.skills.has(id);
      this.skills.set(id, skill);

      if (isUpdate) {
        this.emit("skill:updated", skill);
        logger.info({ skillId: id, format: parsed.format }, "Skill updated");
      } else {
        this.emit("skill:loaded", skill);
        logger.info({ skillId: id, format: parsed.format }, "Skill loaded");
      }

      return skill;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error({ filePath, error: errMsg }, "Error loading skill file");
      this.emit("skill:error", filePath, error as Error);
      return null;
    }
  }

  private handleFileChange(path: string, type: "add" | "change"): void {
    if (path.endsWith(".md")) {
      // Phase 3: 文件变更时使缓存失效
      this.snapshotCache.invalidate();
      this.loadSkillFile(path);
    }
  }

  private handleFileRemove(path: string): void {
    // Phase 3: 文件删除时使缓存失效
    this.snapshotCache.invalidate();
    // Find and remove the skill associated with this path
    for (const [id, skill] of this.skills) {
      if (skill.filePath === path) {
        this.skills.delete(id);
        this.emit("skill:removed", id);
        logger.info({ skillId: id }, "Skill removed");
        break;
      }
    }
  }
}
