/**
 * Multi-Format Skill Parser — compatible with OpenClaw, Hermes, and Super Agent formats.
 *
 * Format detection:
 * 1. OpenClaw: Pure Markdown or SKILL.md with minimal/no frontmatter
 * 2. Hermes: YAML frontmatter with requires_toolsets, fallback_for_toolsets
 * 3. Super Agent: Extended frontmatter with platforms, security, metadata
 */

import matter from "gray-matter";
import type { SkillFrontmatter } from "../types/index.js";

export type SkillFormat = "super-agent" | "openclaw" | "hermes" | "unknown";

export interface ParsedSkill {
  format: SkillFormat;
  frontmatter: SkillFrontmatter;
  content: string;
  rawFrontmatter: Record<string, unknown>;
}

/**
 * Detect the format of a skill file and parse it into a unified structure.
 */
export function parseSkillFile(raw: string, filePath?: string): ParsedSkill {
  const { data, content } = matter(raw);
  const format = detectFormat(data, filePath);

  let frontmatter: SkillFrontmatter;
  switch (format) {
    case "openclaw":
      frontmatter = parseOpenClawFormat(data, content, filePath);
      break;
    case "hermes":
      frontmatter = parseHermesFormat(data);
      break;
    default:
      frontmatter = parseSuperAgentFormat(data);
      break;
  }

  return {
    format,
    frontmatter,
    content: content.trim(),
    rawFrontmatter: data,
  };
}

/** Detect skill format based on frontmatter content and file path */
function detectFormat(data: Record<string, unknown>, filePath?: string): SkillFormat {
  // Hermes format: has requires_toolsets or fallback_for_toolsets
  if (data.requires_toolsets || data.fallback_for_toolsets) {
    return "hermes";
  }

  // Super Agent format: has platforms, security, or metadata.tags
  if (data.platforms || data.security || (data.metadata as any)?.tags) {
    return "super-agent";
  }

  // OpenClaw format: minimal frontmatter (just name/description) or SKILL.md
  if (filePath?.endsWith("SKILL.md") || filePath?.endsWith(".skill.md")) {
    return "openclaw";
  }

  // If has name and description but nothing else fancy, likely OpenClaw
  if (data.name && data.description && Object.keys(data).length <= 4) {
    return "openclaw";
  }

  // Default to super-agent if has proper frontmatter
  if (data.name && data.description) {
    return "super-agent";
  }

  return "unknown";
}

/** Parse OpenClaw format (minimal frontmatter) */
function parseOpenClawFormat(
  data: Record<string, unknown>,
  content: string,
  filePath?: string,
): SkillFrontmatter {
  return {
    name: (data.name as string) || extractNameFromPath(filePath) || "unnamed-skill",
    description: (data.description as string) || extractFirstLine(content) || "Imported from OpenClaw",
    version: (data.version as string) || "1.0.0",
    platforms: data.platforms as string[] | undefined,
    metadata: {
      tags: data.tags as string[] | undefined,
      source: "openclaw" as any,
    } as any,
  };
}

/** Parse Hermes format (YAML frontmatter with toolset requirements) */
function parseHermesFormat(data: Record<string, unknown>): SkillFrontmatter {
  return {
    name: (data.name as string) || "unnamed-hermes-skill",
    description: (data.description as string) || "",
    version: (data.version as string) || "1.0.0",
    prerequisites: {
      envVars: data.requires_toolsets
        ? (data.requires_toolsets as string[]).map((t) => `TOOLSET_${t.toUpperCase()}`)
        : undefined,
    },
    metadata: {
      tags: data.tags as string[] | undefined,
      relatedSkills: data.fallback_for_toolsets as string[] | undefined,
      source: "hermes" as any,
    } as any,
  };
}

/** Parse Super Agent native format */
function parseSuperAgentFormat(data: Record<string, unknown>): SkillFrontmatter {
  return {
    name: (data.name as string) || "unnamed-skill",
    description: (data.description as string) || "",
    version: (data.version as string) || "1.0.0",
    platforms: data.platforms as string[] | undefined,
    prerequisites: data.prerequisites as SkillFrontmatter["prerequisites"],
    security: data.security as SkillFrontmatter["security"],
    metadata: data.metadata as SkillFrontmatter["metadata"],
  };
}

function extractNameFromPath(filePath?: string): string | null {
  if (!filePath) return null;
  const parts = filePath.replace(/\\/g, "/").split("/");
  // If it's SKILL.md, use parent directory name
  const fileName = parts[parts.length - 1];
  if (fileName === "SKILL.md") {
    return parts[parts.length - 2] || null;
  }
  return fileName.replace(/\.(skill\.)?md$/, "") || null;
}

function extractFirstLine(content: string): string | null {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  return firstLine.replace(/^#+\s*/, "").trim().slice(0, 200);
}
