/**
 * OpenClaw → Super Agent 数据迁移核心逻辑。
 *
 * 参考 Hermes openclaw_to_hermes.py（2793 行）中 migrate_soul / migrate_memory /
 * migrate_skills / migrate_mcp_servers / migrate_daily_memory 的算法实现。
 *
 * 设计原则：
 * - preview: 纯只读扫描，不写任何文件
 * - execute: 逐项执行写入，捕获每项的成功/失败状态
 * - 每条迁移项独立 try/catch，单条失败不影响其他项
 * - Task 6: 所有同步 I/O (existsSync/readFileSync/writeFileSync/...) → 异步 fs.promises
 */

import { paths, saveMCPServer } from "@super-agent/core";
import JSON5 from "json5";
import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

// ═══ 常量（与 Hermes 保持一致）═══════════════════════════════════════

/** 记忆条目分隔符（Hermes ENTRY_DELIMITER） */
const ENTRY_DELIMITER = "\n§\n";

/** MEMORY.md 字符上限（Hermes DEFAULT_MEMORY_CHAR_LIMIT） */
const MEMORY_CHAR_LIMIT = 2200;

/** USER.md 字符上限（Hermes DEFAULT_USER_CHAR_LIMIT） */
const USER_CHAR_LIMIT = 1375;

/** Skills 导入子目录名（Hermes SKILL_CATEGORY_DIRNAME） */
const SKILL_IMPORT_DIR = "openclaw-imports";

// ═══ 类型定义 ═══════════════════════════════════════════════════════

export interface MigrationItem {
  kind: string;
  label: string;
  status: "found" | "not_found" | "will_overwrite" | "conflict";
  detail: string;
}

export interface MigrationPreview {
  openclawExists: boolean;
  openclawPath: string;
  items: MigrationItem[];
}

export interface MigrationResult {
  kind: string;
  label: string;
  status: "migrated" | "skipped" | "conflict" | "not_found" | "error" | "found";
  message: string;
}

export interface MigrationReport {
  success: boolean;
  results: MigrationResult[];
  summary: string;
}

// ═══ 异步文件存在性检查（用 stat() 而非 access()，避免权限假阴性）════

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

// ═══ 工具函数 ═════════════════════════════════════════════════════

/** 获取 OpenClaw 数据目录（与 resolveStateDir 逻辑一致） */
function getOpenClawHome(): string {
  if (process.env.OPENCLAW_HOME) return nodePath.resolve(process.env.OPENCLAW_HOME);
  return nodePath.join(os.homedir(), ".openclaw");
}

/** 查找 OpenClaw workspace 目录（优先 workspace/，回退 workspace-main/） */
async function findWorkspaceDir(openclawHome: string): Promise<string | null> {
  const candidates = [
    nodePath.join(openclawHome, "workspace"),
    nodePath.join(openclawHome, "workspace-main"),
    nodePath.join(openclawHome, "workspace.default"),
  ];
  for (const c of candidates) {
    if (await exists(c)) {
      const s = await fs.stat(c);
      if (s.isDirectory()) return c;
    }
  }
  return null;
}

/** 加载 OpenClaw 配置文件（JSON5 格式，支持注释和尾逗号） */
async function loadOpenClawConfig(openclawHome: string): Promise<Record<string, unknown> | null> {
  const configPath = nodePath.join(openclawHome, "openclaw.json");
  if (!(await exists(configPath))) return null;
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON5.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 标准化文本用于去重比较（与 Hermes normalize_text 一致）：
 * 移除多余空白 + 转小写
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 从 Markdown 文本中提取条目（与 Hermes extract_markdown_entries 一致）。
 * 解析标题、列表项、段落，生成带上下文前缀的条目列表。
 */
function extractMarkdownEntries(text: string): string[] {
  const entries: string[] = [];
  const headings: string[] = [];
  let paragraphLines: string[] = [];
  let inCodeBlock = false;

  const contextPrefix = (): string => {
    const filtered = headings.filter(
      (h) => !/(?:MEMORY|USER|SOUL|AGENTS|TOOLS|IDENTITY)\.md/i.test(h),
    );
    return filtered.join(" > ");
  };

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    const textBlock = paragraphLines.map((l) => l.trim()).join(" ").trim();
    paragraphLines = [];
    if (!textBlock) return;
    const prefix = contextPrefix();
    entries.push(prefix ? `${prefix}: ${textBlock}` : textBlock);
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const stripped = line.trim();

    // 代码块
    if (stripped.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      flushParagraph();
      continue;
    }
    if (inCodeBlock) continue;

    // 标题行
    const headingMatch = stripped.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const textValue = headingMatch[2].trim();
      while (headings.length >= level) headings.pop();
      headings.push(textValue);
      continue;
    }

    // 列表项
    const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*\S)\s*$/);
    if (bulletMatch) {
      flushParagraph();
      const content = bulletMatch[1].trim();
      const prefix = contextPrefix();
      entries.push(prefix ? `${prefix}: ${content}` : content);
      continue;
    }

    // 空行
    if (!stripped) {
      flushParagraph();
      continue;
    }

    // 表格行
    if (stripped.startsWith("|") && stripped.endsWith("|")) {
      flushParagraph();
      continue;
    }

    // 普通段落行
    paragraphLines.push(stripped);
  }

  flushParagraph();

  // 去重
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeText(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(entry.trim());
  }
  return deduped;
}

/**
 * 解析已存在的记忆文件条目（与 Hermes parse_existing_memory_entries 一致）。
 * 如果文件已存在且包含 § 分隔符，按分隔符拆分；否则用标题/列表解析。
 */
async function parseExistingMemoryEntries(filePath: string): Promise<string[]> {
  if (!(await exists(filePath))) return [];
  const raw = await fs.readFile(filePath, "utf-8");
  if (!raw.trim()) return [];
  if (raw.includes(ENTRY_DELIMITER)) {
    return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
  }
  return extractMarkdownEntries(raw);
}

/**
 * 合并条目（与 Hermes merge_entries 一致）。
 * 基于 normalized text 去重，按字符上限截断。
 */
function mergeEntries(
  existing: string[],
  incoming: string[],
  limit: number,
): { merged: string[]; added: number; duplicates: number; overflowed: string[] } {
  const merged = [...existing];
  const seen = new Set(existing.filter((e) => e.trim()).map(normalizeText));
  let added = 0;
  let duplicates = 0;
  const overflowed: string[] = [];

  let currentLen = merged.length > 0 ? ENTRY_DELIMITER.length * (merged.length - 1) + merged.reduce((s, e) => s + e.length, 0) : 0;

  for (const entry of incoming) {
    const normalized = normalizeText(entry);
    if (!normalized) continue;
    if (seen.has(normalized)) {
      duplicates++;
      continue;
    }
    const candidateLen =
      merged.length === 0
        ? entry.length
        : currentLen + ENTRY_DELIMITER.length + entry.length;
    if (candidateLen > limit) {
      overflowed.push(entry);
      continue;
    }
    merged.push(entry);
    seen.add(normalized);
    currentLen = candidateLen;
    added++;
  }

  return { merged, added, duplicates, overflowed };
}

/** 确保目标目录存在 */
async function ensureDir(dirPath: string): Promise<void> {
  if (!(await exists(dirPath))) {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

// ═══ 六项迁移子函数 ═══════════════════════════════════════════════

/** 迁移 SOUL.md */
async function migrateSoul(
  workspaceDir: string | null,
  targetPath: string,
  overwrite: boolean,
  execute: boolean,
): Promise<MigrationResult> {
  if (!workspaceDir) {
    return { kind: "soul", label: "SOUL.md", status: "not_found", message: "未找到 OpenClaw workspace 目录" };
  }

  const srcPath = nodePath.join(workspaceDir, "SOUL.md");
  if (!(await exists(srcPath))) {
    return { kind: "soul", label: "SOUL.md", status: "not_found", message: "源文件不存在" };
  }

  const fileExists = await exists(targetPath);
  if (fileExists && !overwrite) {
    return { kind: "soul", label: "SOUL.md", status: "conflict", message: "目标文件已存在，跳过（可勾选覆盖）" };
  }

  if (execute) {
    try {
      const content = await fs.readFile(srcPath, "utf-8");
      await fs.writeFile(targetPath, content, "utf-8");
      return { kind: "soul", label: "SOUL.md", status: "migrated", message: `已迁移 (${(content.length / 1024).toFixed(1)} KB)${fileExists ? " [已覆盖]" : ""}` };
    } catch (err: any) {
      return { kind: "soul", label: "SOUL.md", status: "error", message: `写入失败: ${err.message}` };
    }
  }

  const stat = await fs.stat(srcPath);
  return { kind: "soul", label: "SOUL.md", status: "found", message: `可迁移 (${(stat.size / 1024).toFixed(1)} KB)${fileExists ? " [将覆盖已有文件]" : ""}` };
}

/** 通用 Markdown 条目迁移（处理 MEMORY.md / USER.md / 每日记忆） */
async function migrateMemoryMarkdown(
  kind: string,
  label: string,
  srcPath: string | null,
  dstPath: string,
  charLimit: number,
  overwrite: boolean,
  execute: boolean,
): Promise<MigrationResult> {
  if (!srcPath || !(await exists(srcPath))) {
    return { kind, label, status: "not_found", message: "源文件不存在" };
  }

  const incoming = extractMarkdownEntries(await fs.readFile(srcPath, "utf-8"));
  if (incoming.length === 0) {
    return { kind, label, status: "not_found", message: "无可导入的条目" };
  }

  const existing = await parseExistingMemoryEntries(dstPath);
  const { merged, added, duplicates, overflowed } = mergeEntries(existing, incoming, charLimit);

  if (added === 0 && overflowed.length === 0) {
    return { kind, label, status: "skipped", message: `无新增条目（${duplicates} 条重复）` };
  }

  if (execute) {
    try {
      await ensureDir(nodePath.dirname(dstPath));
      await fs.writeFile(dstPath, merged.join(ENTRY_DELIMITER) + (merged.length > 0 ? "\n" : ""), "utf-8");

      // 超限条目写入 overflow 文件
      let overflowMsg = "";
      if (overflowed.length > 0) {
        const overflowPath = dstPath.replace(/\.md$/, "-overflow.md");
        await fs.writeFile(overflowPath, overflowed.join(ENTRY_DELIMITER) + "\n", "utf-8");
        overflowMsg = `，${overflowed.length} 条超限已写入 overflow 文件`;
      }

      return {
        kind,
        label,
        status: "migrated",
        message: `合并完成: 新增 ${added} 条，去重 ${duplicates} 条${overflowMsg}`,
      };
    } catch (err: any) {
      return { kind, label, status: "error", message: `写入失败: ${err.message}` };
    }
  }

  let detail = `原有 ${existing.length} 条，将新增 ${added} 条（${duplicates} 条重复）`;
  if (overflowed.length > 0) detail += `，${overflowed.length} 条超限`;
  return { kind, label, status: "found", message: detail };
}

/** 迁移 Skills */
async function migrateSkills(
  workspaceDir: string | null,
  targetSkillsDir: string,
  overwrite: boolean,
  execute: boolean,
): Promise<MigrationResult> {
  if (!workspaceDir) {
    return { kind: "skills", label: "技能 (Skills)", status: "not_found", message: "未找到 OpenClaw workspace 目录" };
  }

  const srcSkillsDir = nodePath.join(workspaceDir, "skills");
  if (!(await exists(srcSkillsDir))) {
    return { kind: "skills", label: "技能 (Skills)", status: "not_found", message: "源 skills 目录不存在" };
  }
  const srcSkillsStat = await fs.stat(srcSkillsDir);
  if (!srcSkillsStat.isDirectory()) {
    return { kind: "skills", label: "技能 (Skills)", status: "not_found", message: "源 skills 路径不是目录" };
  }

  // 扫描所有含 SKILL.md 的子目录
  const skillDirs: string[] = [];
  const entries = await fs.readdir(srcSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = nodePath.join(srcSkillsDir, entry.name, "SKILL.md");
    if (await exists(skillMdPath)) {
      skillDirs.push(entry.name);
    }
  }

  if (skillDirs.length === 0) {
    return { kind: "skills", label: "技能 (Skills)", status: "not_found", message: "未找到含 SKILL.md 的技能目录" };
  }

  const dstDir = nodePath.join(targetSkillsDir, SKILL_IMPORT_DIR);

  if (execute) {
    let migrated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const skillName of skillDirs) {
      const srcDir = nodePath.join(srcSkillsDir, skillName);
      const dstSkillDir = nodePath.join(dstDir, skillName);

      if (await exists(dstSkillDir)) {
        if (!overwrite) {
          skipped++;
          continue;
        }
        // 覆盖：先删除再复制
        try {
          await fs.rm(dstSkillDir, { recursive: true, force: true });
        } catch {
          errors.push(`${skillName}: 无法删除已有目录`);
          continue;
        }
      }

      try {
        await ensureDir(dstDir);
        await copyDirRecursive(srcDir, dstSkillDir);
        migrated++;
      } catch (err: any) {
        errors.push(`${skillName}: ${err.message}`);
      }
    }

    const parts: string[] = [];
    if (migrated > 0) parts.push(`${migrated} 个已迁移`);
    if (skipped > 0) parts.push(`${skipped} 个已跳过（目标已存在）`);
    if (errors.length > 0) parts.push(`${errors.length} 个失败: ${errors.join("; ")}`);

    return {
      kind: "skills",
      label: "技能 (Skills)",
      status: migrated > 0 ? "migrated" : errors.length > 0 ? "error" : "skipped",
      message: parts.join("，"),
    };
  }

  return {
    kind: "skills",
    label: "技能 (Skills)",
    status: "found",
    message: `将迁移 ${skillDirs.length} 个技能到 ${SKILL_IMPORT_DIR}/`,
  };
}

/** 递归复制目录 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = nodePath.join(src, entry.name);
    const destPath = nodePath.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** 迁移 MCP Servers */
async function migrateMcpServers(
  openclawHome: string,
  overwrite: boolean,
  execute: boolean,
): Promise<MigrationResult> {
  const config = await loadOpenClawConfig(openclawHome);
  if (!config) {
    return { kind: "mcp", label: "MCP 服务器", status: "not_found", message: "无法读取 openclaw.json" };
  }

  const mcpConfig = ((config as any).mcp ?? {}) as Record<string, unknown>;
  const servers = (mcpConfig.servers ?? {}) as Record<string, unknown>;
  const serverNames = Object.keys(servers);

  if (serverNames.length === 0) {
    return { kind: "mcp", label: "MCP 服务器", status: "not_found", message: "openclaw.json 中未配置 MCP 服务器" };
  }

  if (execute) {
    let migrated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const name of serverNames) {
      const srv = servers[name] as Record<string, unknown> | undefined;
      if (!srv || typeof srv !== "object") continue;

      // 使用 openclaw- 前缀避免与已有配置冲突
      const superId = `openclaw-${name}`;
      const transport = srv.command ? "stdio" : srv.url ? "sse" : "stdio";

      try {
        saveMCPServer({
          id: superId,
          name: `OpenClaw: ${name}`,
          transport,
          command: (srv.command as string) ?? null,
          args: (srv.args as unknown[]) ?? [],
          url: (srv.url as string) ?? null,
          env: (srv.env as Record<string, string>) ?? {},
          auth: (srv.auth as Record<string, unknown>) ?? undefined,
          enabled: srv.enabled !== false, // 默认启用
          createdAt: new Date().toISOString(),
        });
        migrated++;
      } catch (err: any) {
        errors.push(`${name}: ${err.message}`);
      }
    }

    const parts: string[] = [];
    if (migrated > 0) parts.push(`${migrated} 个已导入`);
    if (skipped > 0) parts.push(`${skipped} 个已跳过`);
    if (errors.length > 0) parts.push(`${errors.length} 个失败: ${errors.join("; ")}`);

    return {
      kind: "mcp",
      label: "MCP 服务器",
      status: migrated > 0 ? "migrated" : errors.length > 0 ? "error" : "skipped",
      message: parts.join("，"),
    };
  }

  return {
    kind: "mcp",
    label: "MCP 服务器",
    status: "found",
    message: `将导入 ${serverNames.length} 个 MCP 服务器配置`,
  };
}

/** 迁移每日记忆（workspace/memory/*.md → MEMORY.md） */
async function migrateDailyMemory(
  workspaceDir: string | null,
  targetMemoryPath: string,
  overwrite: boolean,
  execute: boolean,
): Promise<MigrationResult> {
  if (!workspaceDir) {
    return { kind: "daily-memory", label: "每日记忆", status: "not_found", message: "未找到 OpenClaw workspace 目录" };
  }

  const srcDir = nodePath.join(workspaceDir, "memory");
  if (!(await exists(srcDir))) {
    return { kind: "daily-memory", label: "每日记忆", status: "not_found", message: "workspace/memory/ 目录不存在" };
  }
  const srcStat = await fs.stat(srcDir);
  if (!srcStat.isDirectory()) {
    return { kind: "daily-memory", label: "每日记忆", status: "not_found", message: "workspace/memory/ 不是目录" };
  }

  const dirEntries = await fs.readdir(srcDir);
  const mdFiles = dirEntries
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (mdFiles.length === 0) {
    return { kind: "daily-memory", label: "每日记忆", status: "not_found", message: "无 .md 文件" };
  }

  // 收集所有每日记忆条目
  const allIncoming: string[] = [];
  for (const mdFile of mdFiles) {
    const content = await fs.readFile(nodePath.join(srcDir, mdFile), "utf-8");
    const entries = extractMarkdownEntries(content);
    allIncoming.push(...entries);
  }

  if (allIncoming.length === 0) {
    return { kind: "daily-memory", label: "每日记忆", status: "not_found", message: "无可导入的条目" };
  }

  const existing = await parseExistingMemoryEntries(targetMemoryPath);
  const { merged, added, duplicates, overflowed } = mergeEntries(existing, allIncoming, MEMORY_CHAR_LIMIT);

  if (added === 0 && overflowed.length === 0) {
    return { kind: "daily-memory", label: "每日记忆", status: "skipped", message: `无新增条目（${duplicates} 条重复）` };
  }

  if (execute) {
    try {
      await ensureDir(nodePath.dirname(targetMemoryPath));
      await fs.writeFile(targetMemoryPath, merged.join(ENTRY_DELIMITER) + (merged.length > 0 ? "\n" : ""), "utf-8");

      let overflowMsg = "";
      if (overflowed.length > 0) {
        const overflowPath = targetMemoryPath.replace(/\.md$/, "-overflow.md");
        await fs.writeFile(overflowPath, overflowed.join(ENTRY_DELIMITER) + "\n", "utf-8");
        overflowMsg = `，${overflowed.length} 条超限已写入 overflow 文件`;
      }

      return {
        kind: "daily-memory",
        label: "每日记忆",
        status: "migrated",
        message: `从 ${mdFiles.length} 个文件合并: 新增 ${added} 条，去重 ${duplicates} 条${overflowMsg}`,
      };
    } catch (err: any) {
      return { kind: "daily-memory", label: "每日记忆", status: "error", message: `写入失败: ${err.message}` };
    }
  }

  let detail = `从 ${mdFiles.length} 个文件提取 ${allIncoming.length} 条，将新增 ${added} 条（${duplicates} 条重复）`;
  if (overflowed.length > 0) detail += `，${overflowed.length} 条超限`;
  return { kind: "daily-memory", label: "每日记忆", status: "found", message: detail };
}

// ═══ 公开 API ═════════════════════════════════════════════════════

/**
 * 预览迁移（纯只读，不写任何文件）。
 * 扫描 OpenClaw 数据目录，返回 6 项数据的预览状态。
 */
export async function previewMigration(): Promise<MigrationPreview> {
  const openclawHome = getOpenClawHome();
  const openclawExists = await exists(openclawHome);
  const items: MigrationItem[] = [];

  if (!openclawExists) {
    return { openclawExists: false, openclawPath: openclawHome, items: [] };
  }

  // 确认 openclawHome 是目录
  const homeStat = await fs.stat(openclawHome);
  if (!homeStat.isDirectory()) {
    return { openclawExists: false, openclawPath: openclawHome, items: [] };
  }

  const workspaceDir = await findWorkspaceDir(openclawHome);
  const targetHome = paths.home();
  const config = await loadOpenClawConfig(openclawHome);
  const mcpServers = config ? Object.keys((((config as any).mcp ?? {}) as any).servers ?? {}) : [];

  // 1. SOUL.md
  const soulSrc = workspaceDir ? nodePath.join(workspaceDir, "SOUL.md") : null;
  if (soulSrc && (await exists(soulSrc))) {
    const stat = await fs.stat(soulSrc);
    const soulExists = await exists(paths.soul());
    items.push({
      kind: "soul", label: "SOUL.md",
      status: soulExists ? "will_overwrite" : "found",
      detail: `源: ${soulSrc} (${(stat.size / 1024).toFixed(1)} KB)${soulExists ? " [目标文件已存在]" : ""}`,
    });
  } else {
    items.push({ kind: "soul", label: "SOUL.md", status: "not_found", detail: "未找到 SOUL.md" });
  }

  // 2. MEMORY.md
  const memorySrc = workspaceDir ? nodePath.join(workspaceDir, "MEMORY.md") : null;
  if (memorySrc && (await exists(memorySrc))) {
    const content = await fs.readFile(memorySrc, "utf-8");
    const entries = extractMarkdownEntries(content);
    items.push({
      kind: "memory", label: "MEMORY.md",
      status: "found",
      detail: `${entries.length} 条记忆条目`,
    });
  } else {
    items.push({ kind: "memory", label: "MEMORY.md", status: "not_found", detail: "未找到 MEMORY.md" });
  }

  // 3. USER.md
  const userSrc = workspaceDir ? nodePath.join(workspaceDir, "USER.md") : null;
  if (userSrc && (await exists(userSrc))) {
    const content = await fs.readFile(userSrc, "utf-8");
    const entries = extractMarkdownEntries(content);
    items.push({
      kind: "user", label: "USER.md",
      status: "found",
      detail: `${entries.length} 条用户信息`,
    });
  } else {
    items.push({ kind: "user", label: "USER.md", status: "not_found", detail: "未找到 USER.md" });
  }

  // 4. Skills
  if (workspaceDir) {
    const skillsDir = nodePath.join(workspaceDir, "skills");
    if ((await exists(skillsDir))) {
      const skillsStat = await fs.stat(skillsDir);
      if (skillsStat.isDirectory()) {
        const dirEntries = await fs.readdir(skillsDir, { withFileTypes: true });
        let skillCount = 0;
        for (const d of dirEntries) {
          if (d.isDirectory() && (await exists(nodePath.join(skillsDir, d.name, "SKILL.md")))) {
            skillCount++;
          }
        }
        if (skillCount > 0) {
          const destExists = await exists(nodePath.join(paths.skills(), SKILL_IMPORT_DIR));
          items.push({
            kind: "skills", label: "技能 (Skills)",
            status: destExists ? "will_overwrite" : "found",
            detail: `${skillCount} 个技能${destExists ? " [目标目录已存在]" : ""}`,
          });
        } else {
          items.push({ kind: "skills", label: "技能 (Skills)", status: "not_found", detail: "未找到含 SKILL.md 的技能目录" });
        }
      } else {
        items.push({ kind: "skills", label: "技能 (Skills)", status: "not_found", detail: "未找到 skills 目录" });
      }
    } else {
      items.push({ kind: "skills", label: "技能 (Skills)", status: "not_found", detail: "未找到 skills 目录" });
    }
  } else {
    items.push({ kind: "skills", label: "技能 (Skills)", status: "not_found", detail: "未找到 workspace" });
  }

  // 5. MCP Servers
  if (mcpServers.length > 0) {
    items.push({
      kind: "mcp", label: "MCP 服务器",
      status: "found",
      detail: `${mcpServers.length} 个服务器配置`,
    });
  } else {
    items.push({ kind: "mcp", label: "MCP 服务器", status: "not_found", detail: "未配置 MCP 服务器" });
  }

  // 6. 每日记忆
  if (workspaceDir) {
    const dailyDir = nodePath.join(workspaceDir, "memory");
    if ((await exists(dailyDir))) {
      const dailyStat = await fs.stat(dailyDir);
      if (dailyStat.isDirectory()) {
        const dirEntries = await fs.readdir(dailyDir);
        const mdCount = dirEntries.filter((f) => f.endsWith(".md")).length;
        if (mdCount > 0) {
          items.push({
            kind: "daily-memory", label: "每日记忆",
            status: "found",
            detail: `${mdCount} 个记忆文件`,
          });
        } else {
          items.push({ kind: "daily-memory", label: "每日记忆", status: "not_found", detail: "无 .md 文件" });
        }
      } else {
        items.push({ kind: "daily-memory", label: "每日记忆", status: "not_found", detail: "未找到 memory/ 目录" });
      }
    } else {
      items.push({ kind: "daily-memory", label: "每日记忆", status: "not_found", detail: "未找到 memory/ 目录" });
    }
  } else {
    items.push({ kind: "daily-memory", label: "每日记忆", status: "not_found", detail: "未找到 workspace" });
  }

  return {
    openclawExists: true,
    openclawPath: openclawHome,
    items,
  };
}

/**
 * 执行迁移。
 * @param options.overwrite - 是否覆盖已存在的目标文件（默认 false）
 */
export async function executeMigration(options: { overwrite?: boolean } = {}): Promise<MigrationReport> {
  const overwrite = options.overwrite ?? false;
  const openclawHome = getOpenClawHome();
  const workspaceDir = await findWorkspaceDir(openclawHome);
  const results: MigrationResult[] = [];

  // 1. SOUL.md
  results.push(await migrateSoul(workspaceDir, paths.soul(), overwrite, true));

  // 2. MEMORY.md
  const memorySrcPath = workspaceDir ? nodePath.join(workspaceDir, "MEMORY.md") : null;
  results.push(
    await migrateMemoryMarkdown("memory", "MEMORY.md", memorySrcPath, paths.memory(), MEMORY_CHAR_LIMIT, overwrite, true),
  );

  // 3. USER.md
  const userSrcPath = workspaceDir ? nodePath.join(workspaceDir, "USER.md") : null;
  results.push(
    await migrateMemoryMarkdown("user", "USER.md", userSrcPath, paths.user(), USER_CHAR_LIMIT, overwrite, true),
  );

  // 4. Skills
  results.push(await migrateSkills(workspaceDir, paths.skills(), overwrite, true));

  // 5. MCP Servers
  results.push(await migrateMcpServers(openclawHome, overwrite, true));

  // 6. 每日记忆
  results.push(await migrateDailyMemory(workspaceDir, paths.memory(), overwrite, true));

  const errorCount = results.filter((r) => r.status === "error").length;
  const migratedCount = results.filter((r) => r.status === "migrated").length;
  const skippedCount = results.filter((r) => r.status === "skipped" || r.status === "conflict").length;
  const notFoundCount = results.filter((r) => r.status === "not_found").length;

  return {
    success: errorCount === 0,
    results,
    summary: `迁移完成: ${migratedCount} 项成功, ${skippedCount} 项跳过, ${notFoundCount} 项未找到${errorCount > 0 ? `, ${errorCount} 项失败` : ""}`,
  };
}
