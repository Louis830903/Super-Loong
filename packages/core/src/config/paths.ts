/**
 * Central path resolution for Super Agent data directory.
 *
 * Design follows:
 * - OpenClaw: resolveStateDir() → ~/.openclaw/ with env override + legacy fallback
 * - Hermes:   get_hermes_home() → ~/.hermes/ with HERMES_HOME env override
 *
 * Three-level fallback:
 *  1. SA_HOME environment variable (highest priority)
 *  2. ~/.super-agent (standard location)
 *  3. ./data/ (legacy / development fallback — if old DB exists there)
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import pino from "pino";

const logger = pino({ name: "paths" });

// Cache resolved home to avoid repeated fs checks
let _resolvedHome: string | null = null;

/**
 * Resolve the Super Agent data root directory.
 * Uses a three-level fallback (like OpenClaw resolveStateDir):
 *  1. SA_HOME env var
 *  2. ~/.super-agent
 *  3. ./data/ (if legacy DB exists and ~/.super-agent doesn't)
 */
export function resolveHome(): string {
  if (_resolvedHome) return _resolvedHome;

  // 1. Environment variable override
  if (process.env.SA_HOME) {
    _resolvedHome = path.resolve(process.env.SA_HOME);
    return _resolvedHome;
  }

  // 2. Standard user-home location
  const standard = path.join(os.homedir(), ".super-agent");

  // 3. Legacy ./data/ compat: if old DB exists and new dir doesn't, use legacy
  const legacy = path.resolve("./data");
  if (
    !fs.existsSync(standard) &&
    fs.existsSync(path.join(legacy, "super-agent.db"))
  ) {
    logger.info(
      { legacy },
      "Using legacy data directory (migrate to ~/.super-agent by moving files)"
    );
    _resolvedHome = legacy;
    return _resolvedHome;
  }

  _resolvedHome = standard;
  return _resolvedHome;
}

/**
 * Reset the cached home path (useful for testing or after env change).
 */
export function resetResolvedHome(): void {
  _resolvedHome = null;
}

/**
 * Central path map — all derived paths branch from resolveHome().
 * Follows Hermes get_*_dir() / get_*_path() naming pattern.
 */
export const paths = {
  /** Root data directory */
  home: () => resolveHome(),
  /** SQLite main database */
  db: () => path.join(resolveHome(), "super-agent.db"),
  /** Rolling backup (quick restore) */
  dbBak: () => path.join(resolveHome(), "super-agent.db.bak"),
  /** JSONL conversation transcripts */
  sessions: () => path.join(resolveHome(), "sessions"),
  /** Skill hot-reload directory */
  skills: () => path.join(resolveHome(), "skills"),
  /** Structured log files (optional) */
  logs: () => path.join(resolveHome(), "logs"),
  /** Temporary cache */
  cache: () => path.join(resolveHome(), "cache"),
  /** OAuth / external credentials */
  credentials: () => path.join(resolveHome(), "credentials"),
  /** Sandbox persistent workspaces */
  sandboxes: () => path.join(resolveHome(), "sandboxes"),
  /** Old clobbered backup snapshots */
  backups: () => path.join(resolveHome(), "backups"),
  /** Agent notes — readable/writable by Agent (Hermes MEMORY.md) */
  memory: () => path.join(resolveHome(), "MEMORY.md"),
  /** User profile — maintained by Agent (Hermes USER.md) */
  user: () => path.join(resolveHome(), "USER.md"),
  /** Global persona — human-editable only (Hermes SOUL.md) */
  soul: () => path.join(resolveHome(), "SOUL.md"),
  /** Global config JSON */
  config: () => path.join(resolveHome(), "config.json"),
};

/**
 * Ensure critical directories exist (call once at startup).
 * Creates them recursively if missing.
 */
export function ensureDirectories(): void {
  const dirs = [
    paths.home(),
    paths.sessions(),
    paths.skills(),
    paths.logs(),
    paths.cache(),
    paths.backups(),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}
