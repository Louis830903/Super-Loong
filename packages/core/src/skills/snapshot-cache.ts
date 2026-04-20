/**
 * Skill Snapshot Cache — 双层技能缓存（学 Hermes 磁盘技能快照）
 *
 * Layer 1: LRU 内存缓存（OrderedMap，最大 8 条，进程内极速命中）
 * Layer 2: 磁盘 JSON 快照（~/.super-agent/.skills_snapshot.json，冷启动加速）
 *
 * 缓存失效策略：基于 manifest（mtime_ms + file_size）校验，任一文件变化→整体失效。
 * 对标 Hermes agent/prompt_builder.py 的 _SKILLS_PROMPT_CACHE / _SKILLS_SNAPSHOT_VERSION。
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, relative, extname } from "node:path";
import { homedir } from "node:os";
import pino from "pino";

const logger = pino({ name: "skill-snapshot-cache" });

// ─── 数据结构 ──────────────────────────────────────────────

export interface SkillManifest {
  /** 文件相对路径 → [mtime_ms, file_size_bytes] */
  files: Record<string, [number, number]>;
}

export interface SkillSnapshotEntry {
  id: string;
  name: string;
  description: string;
  format: string;
  category?: string;
  platforms?: string[];
  commands?: string[];
  filePath: string;
}

export interface SkillSnapshot {
  version: number;
  manifest: SkillManifest;
  skills: SkillSnapshotEntry[];
  createdAt: string;
}

// ─── 常量 ──────────────────────────────────────────────────

const SNAPSHOT_VERSION = 1;
const LRU_MAX_SIZE = 8;

/** 快照文件存储目录 */
const getSnapshotDir = (): string => join(homedir(), ".super-agent");
const getSnapshotPath = (): string => join(getSnapshotDir(), ".skills_snapshot.json");

/** 技能文件扩展名 */
const SKILL_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);

// ─── SkillSnapshotCache 类 ────────────────────────────────

export class SkillSnapshotCache {
  /** LRU 内存缓存（Map 保持插入顺序，模拟 LRU） */
  private lruCache = new Map<string, SkillSnapshotEntry[]>();

  /**
   * 加载技能（快速路径）：
   * 1. 检查 LRU 内存缓存 → 命中则直接返回
   * 2. 读取磁盘快照 JSON → 校验 manifest → 匹配则返回
   * 3. 返回 null 表示缓存未命中，需要调用方全量扫描
   */
  load(dirs: string[], platform?: string): SkillSnapshotEntry[] | null {
    const key = this.computeCacheKey(dirs, platform);

    // Layer 1: LRU 内存缓存
    if (this.lruCache.has(key)) {
      // 将命中项移到最后（模拟 LRU 访问更新）
      const cached = this.lruCache.get(key)!;
      this.lruCache.delete(key);
      this.lruCache.set(key, cached);
      logger.debug({ key: key.slice(0, 12) }, "Skill cache HIT (LRU memory)");
      return cached;
    }

    // Layer 2: 磁盘快照
    const snapshot = this.readSnapshot();
    if (snapshot) {
      // 校验版本
      if (snapshot.version !== SNAPSHOT_VERSION) {
        logger.info("Snapshot version mismatch, rebuilding");
        return null;
      }
      // 校验 manifest
      const currentManifest = this.buildManifest(dirs);
      if (this.manifestMatches(snapshot.manifest, currentManifest)) {
        // 命中：写入 LRU 缓存
        this.putLRU(key, snapshot.skills);
        logger.info({ count: snapshot.skills.length }, "Skill cache HIT (disk snapshot)");
        return snapshot.skills;
      }
      logger.info("Skill manifest changed, cache invalidated");
    }

    return null;
  }

  /**
   * 全量扫描完成后，由调用方调用此方法将结果写入双层缓存。
   */
  persist(dirs: string[], platform: string | undefined, skills: SkillSnapshotEntry[]): void {
    const key = this.computeCacheKey(dirs, platform);
    const manifest = this.buildManifest(dirs);

    // 写入 LRU
    this.putLRU(key, skills);

    // 写入磁盘快照
    const snapshot: SkillSnapshot = {
      version: SNAPSHOT_VERSION,
      manifest,
      skills,
      createdAt: new Date().toISOString(),
    };
    this.writeSnapshot(snapshot);
    logger.info({ count: skills.length }, "Skill snapshot persisted to disk");
  }

  /** 使缓存失效（技能文件变更时由 SkillLoader 调用） */
  invalidate(): void {
    this.lruCache.clear();
    // 磁盘快照不主动删除，下次 load() 时 manifest 校验会自然失效
    logger.debug("Skill cache invalidated (LRU cleared)");
  }

  // ─── Manifest 构建与校验 ──────────────────────────────────

  /** 构建当前文件系统的 manifest（mtime + size） */
  buildManifest(dirs: string[]): SkillManifest {
    const files: Record<string, [number, number]> = {};

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      this.scanDirForManifest(dir, dir, files);
    }

    return { files };
  }

  /** 递归扫描目录，收集技能文件的 mtime 和 size */
  private scanDirForManifest(
    baseDir: string,
    currentDir: string,
    files: Record<string, [number, number]>,
  ): void {
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = join(currentDir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        this.scanDirForManifest(baseDir, fullPath, files);
      } else if (SKILL_EXTENSIONS.has(extname(entry).toLowerCase())) {
        const relPath = relative(baseDir, fullPath);
        files[relPath] = [Math.floor(stat.mtimeMs), stat.size];
      }
    }
  }

  /** 比较两个 manifest 是否一致 */
  private manifestMatches(a: SkillManifest, b: SkillManifest): boolean {
    const keysA = Object.keys(a.files).sort();
    const keysB = Object.keys(b.files).sort();

    if (keysA.length !== keysB.length) return false;

    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      const [mtimeA, sizeA] = a.files[keysA[i]];
      const [mtimeB, sizeB] = b.files[keysB[i]];
      if (mtimeA !== mtimeB || sizeA !== sizeB) return false;
    }

    return true;
  }

  // ─── 磁盘快照 IO ─────────────────────────────────────────

  /** 读取磁盘快照 */
  private readSnapshot(): SkillSnapshot | null {
    const path = getSnapshotPath();
    if (!existsSync(path)) return null;

    try {
      const raw = readFileSync(path, "utf-8");
      return JSON.parse(raw) as SkillSnapshot;
    } catch (err: any) {
      logger.warn({ error: err.message }, "Failed to read skill snapshot, will rebuild");
      return null;
    }
  }

  /** 原子写入磁盘快照（先写临时文件再 rename，防止损坏） */
  private writeSnapshot(snapshot: SkillSnapshot): void {
    const dir = getSnapshotDir();
    const path = getSnapshotPath();
    const tmpPath = path + ".tmp";

    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf-8");
      // 原子替换：先删旧文件再 rename（Windows 兼容）
      try { unlinkSync(path); } catch { /* 文件不存在则忽略 */ }
      renameSync(tmpPath, path);
    } catch (err: any) {
      logger.warn({ error: err.message }, "Failed to persist skill snapshot");
      // 清理临时文件
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  // ─── LRU 辅助 ─────────────────────────────────────────────

  /** 插入 LRU 缓存，超出容量时淘汰最旧条目 */
  private putLRU(key: string, skills: SkillSnapshotEntry[]): void {
    if (this.lruCache.size >= LRU_MAX_SIZE) {
      // 淘汰最早插入的条目（Map 迭代器第一个）
      const oldestKey = this.lruCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.lruCache.delete(oldestKey);
      }
    }
    this.lruCache.set(key, skills);
  }

  /** 计算缓存键（dirs + platform 的哈希） */
  private computeCacheKey(dirs: string[], platform?: string): string {
    const raw = dirs.sort().join("|") + "||" + (platform ?? "");
    return createHash("sha256").update(raw).digest("hex");
  }
}
