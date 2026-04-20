/**
 * Project Context File Discovery & Injection.
 *
 * Discovers project-level context files (similar to Hermes' priority-based
 * discovery + OpenClaw's size limits) and injects them into the system prompt.
 *
 * Priority order (first match wins):
 * 1. .super-agent.md / SUPER-AGENT.md (searches up to git root)
 * 2. AGENTS.md / agents.md (cwd only)
 * 3. .cursorrules / .cursor/rules/*.mdc (Cursor compatibility)
 *
 * Security: All content passes through injection-guard before injection.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { scanForInjection } from "./injection-guard.js";

// ─── Constants ───────────────────────────────────────────────

/** Max characters for a single context file */
const MAX_SINGLE_FILE_CHARS = 20_000;
/** Max total characters for all context files combined */
const MAX_TOTAL_CHARS = 50_000;
/** How many directories to walk up when searching for git root */
const MAX_WALK_UP = 20;

// ─── Discovery Logic ─────────────────────────────────────────

interface ContextFile {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Walk upward from `startDir` until we find a `.git` directory or hit the limit.
 */
function findGitRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return resolve(startDir); // fallback to startDir
}

/**
 * Try to read a file if it exists and is within size limits.
 */
function tryReadFile(filePath: string): ContextFile | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;

    const raw = readFileSync(filePath, "utf-8");
    if (raw.length <= MAX_SINGLE_FILE_CHARS) {
      return { path: filePath, content: raw, truncated: false };
    }

    // Head+tail truncation with middle marker
    const headSize = Math.floor(MAX_SINGLE_FILE_CHARS * 0.6);
    const tailSize = MAX_SINGLE_FILE_CHARS - headSize - 80; // 80 for marker
    const truncated =
      raw.slice(0, headSize) +
      "\n\n... [TRUNCATED: file exceeded 20K char limit — middle section omitted] ...\n\n" +
      raw.slice(-tailSize);
    return { path: filePath, content: truncated, truncated: true };
  } catch {
    return null;
  }
}

/**
 * Discover project context files from the given root directory.
 *
 * Returns sanitized content ready for system prompt injection.
 * Empty string if no context files are found.
 */
export function discoverContextFiles(rootDir?: string): string {
  if (!rootDir) return "";

  const cwd = resolve(rootDir);
  const gitRoot = findGitRoot(cwd);
  const files: ContextFile[] = [];
  let totalBytes = 0;

  // Priority 1: .super-agent.md / SUPER-AGENT.md (search upward to git root)
  const superAgentNames = [".super-agent.md", "SUPER-AGENT.md"];
  let dir = cwd;
  let found = false;
  while (!found) {
    for (const name of superAgentNames) {
      const f = tryReadFile(join(dir, name));
      if (f) {
        files.push(f);
        totalBytes += f.content.length;
        found = true;
        break;
      }
    }
    if (found) break;
    if (dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Priority 2: AGENTS.md / agents.md (cwd only)
  if (files.length === 0) {
    for (const name of ["AGENTS.md", "agents.md"]) {
      const f = tryReadFile(join(cwd, name));
      if (f && totalBytes + f.content.length <= MAX_TOTAL_CHARS) {
        files.push(f);
        totalBytes += f.content.length;
        break;
      }
    }
  }

  // Priority 3: .cursorrules / .cursor/rules/*.mdc (cwd only)
  if (files.length === 0) {
    // .cursorrules file
    const cr = tryReadFile(join(cwd, ".cursorrules"));
    if (cr && totalBytes + cr.content.length <= MAX_TOTAL_CHARS) {
      files.push(cr);
      totalBytes += cr.content.length;
    }

    // .cursor/rules/*.mdc
    const cursorRulesDir = join(cwd, ".cursor", "rules");
    try {
      if (existsSync(cursorRulesDir)) {
        const mdcFiles = readdirSync(cursorRulesDir)
          .filter((f) => f.endsWith(".mdc"))
          .sort();
        for (const mdcName of mdcFiles) {
          if (totalBytes >= MAX_TOTAL_CHARS) break;
          const f = tryReadFile(join(cursorRulesDir, mdcName));
          if (f && totalBytes + f.content.length <= MAX_TOTAL_CHARS) {
            files.push(f);
            totalBytes += f.content.length;
          }
        }
      }
    } catch {
      // ignore directory read errors
    }
  }

  if (files.length === 0) return "";

  // Security scan all discovered content
  const parts: string[] = ["## Project Context"];
  for (const file of files) {
    const scan = scanForInjection(file.content, file.path);
    parts.push(`### ${file.path}${file.truncated ? " (truncated)" : ""}`);
    parts.push(scan.content);
  }

  return parts.join("\n");
}
