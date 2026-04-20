/**
 * Skill Tools — tools for Agent to interact with the skill system.
 *
 * Follows the Hermes skill_view / OpenClaw read_tool pattern:
 * Agent sees skill names+descriptions in system prompt, then loads full content on demand.
 *
 * Extended with skill_search + skill_install so Agent can discover and install skills
 * from the marketplace programmatically (without relying on the Web UI).
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult, ToolContext } from "../types/index.js";
import type { SkillLoader } from "./loader.js";
import type { SkillMarketplace } from "./marketplace.js";
import { evaluateReadiness, formatReadinessMessage, SkillReadinessStatus } from "./readiness.js";
import { applyConfigInjection, InMemoryConfigStore, type SkillConfigStore } from "./config-inject.js";
import { scanSkillCommands, handleSlashCommand, formatCommandsList, isSlashCommand, type SkillCommandEntry } from "./commands.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, extname } from "node:path";

/**
 * Create skill-related tools that require a SkillLoader and optional SkillMarketplace.
 * Called during app bootstrap, just like createMemoryTools().
 */
export function createSkillTools(
  loader: SkillLoader,
  marketplace?: SkillMarketplace,
  configStore?: SkillConfigStore,
): ToolDefinition[] {
  const store = configStore ?? new InMemoryConfigStore();
  const tools: ToolDefinition[] = [
    // ── skill_read ──────────────────────────────────────
    {
      name: "skill_read",
      description:
        "Load the full content of a skill by name. The system prompt lists available skills " +
        "with short descriptions — use this tool to read the complete instructions, commands, " +
        "and workflows before executing the task. Always prefer loading a skill over guessing.",
      parameters: z.object({
        name: z.string().describe("Skill name (as shown in <available_skills>)"),
        subPath: z.string().optional().describe("Relative file path within the skill directory (e.g. 'references/api.md')"),
      }),
      execute: async (params: unknown, _ctx?: ToolContext): Promise<ToolResult> => {
        const { name, subPath } = params as { name: string; subPath?: string };

        // Try exact id match first, then by frontmatter name
        let skill = loader.getSkill(name);
        if (!skill) {
          skill = loader.findByName(name);
        }
        // Fuzzy: case-insensitive match
        if (!skill) {
          const lower = name.toLowerCase();
          const all = loader.listSkills();
          skill = all.find(
            (s) =>
              s.id.toLowerCase() === lower ||
              s.frontmatter.name.toLowerCase() === lower,
          );
        }

        if (!skill) {
          const available = loader
            .listSkills()
            .filter((s) => s.enabled)
            .map((s) => s.frontmatter.name)
            .slice(0, 20);
          return {
            success: false,
            output: `Skill "${name}" not found. Available: ${available.join(", ") || "(none)"}. Use skill_search to find and skill_install to install new skills.`,
          };
        }

        if (!skill.enabled) {
          return {
            success: false,
            output: `Skill "${name}" is currently disabled.`,
          };
        }

        // Spec v3 Task 5: 子路径关联文件加载
        if (subPath) {
          const skillDir = dirname(skill.filePath);
          const targetPath = resolve(skillDir, subPath);
          // 安全检查: 确保不越界
          if (!targetPath.startsWith(resolve(skillDir))) {
            return { success: false, output: `Security: subPath "${subPath}" escapes skill directory.` };
          }
          if (!existsSync(targetPath)) {
            // 列出可用文件
            const available = listSkillFiles(skillDir);
            return {
              success: false,
              output: `File "${subPath}" not found in skill directory.\nAvailable: ${available.join(", ") || "(none)"}`,
            };
          }
          try {
            const content = readFileSync(targetPath, "utf-8");
            return {
              success: true,
              output: `# ${skill.frontmatter.name} / ${subPath}\n\n${content}`,
              data: { name: skill.frontmatter.name, subPath, filePath: targetPath },
            };
          } catch (err: any) {
            return { success: false, output: `Failed to read "${subPath}": ${err.message}` };
          }
        }

        // Return the full markdown content (the actual skill instructions)
        // Spec v3 Task 2: 附带就绪状态信息
        const readinessResult = evaluateReadiness(skill);
        const readinessMsg = formatReadinessMessage(readinessResult);

        // Spec v3: 如果有缺失密钥，提供可收集的密钥规格信息
        let secretsHint = "";
        if (readinessResult.secretSpecs.length > 0) {
          const specLines = readinessResult.secretSpecs.map(
            (s) => `  - ${s.envVar}: ${s.prompt}${s.providerUrl ? ` (get from: ${s.providerUrl})` : ""}`
          );
          secretsHint = `\n\n--- Missing Secrets ---\nThe following environment variables are needed:\n${specLines.join("\n")}\nSet them via environment variables or use the configuration system.`;
        }

        // Spec v3 Task 4: 配置注入
        const injectedContent = applyConfigInjection(skill, store);

        // Spec v3 Task 5: 列出关联文件
        const linkedFiles = listSkillFiles(dirname(skill.filePath));
        const linkedSection = linkedFiles.length > 1
          ? `\n\n--- Linked Files ---\n${linkedFiles.filter((f: string) => f !== "SKILL.md" && f !== skill.filePath.split(/[\\/]/).pop()).map((f: string) => `- ${f}`).join("\n")}`
          : "";

        const header = [
          `# Skill: ${skill.frontmatter.name}`,
          skill.frontmatter.description ? `> ${skill.frontmatter.description}` : "",
          skill.frontmatter.version ? `> Version: ${skill.frontmatter.version}` : "",
          `> Source: ${skill.filePath}`,
          readinessMsg ? `\n${readinessMsg}` : "",
          "",
        ]
          .filter(Boolean)
          .join("\n");

        return {
          success: true,
          output: header + injectedContent + linkedSection + secretsHint,
          data: {
            name: skill.frontmatter.name,
            description: skill.frontmatter.description,
            version: skill.frontmatter.version,
            filePath: skill.filePath,
            linkedFiles: linkedFiles.length > 0 ? linkedFiles : undefined,
          },
        };
      },
    },

    // ── skill_list ──────────────────────────────────────
    {
      name: "skill_list",
      description:
        "List all locally installed skills with their names, descriptions, and status. " +
        "Use skill_search to find new skills from the marketplace.",
      parameters: z.object({}),
      execute: async (_params: unknown, _ctx?: ToolContext): Promise<ToolResult> => {
        const skills = loader.listSkills();
        if (skills.length === 0) {
          return {
            success: true,
            output: "No skills installed. Use skill_search to find skills from the marketplace, then skill_install to install them.",
          };
        }
        const lines = skills.map(
          (s) =>
            `- ${s.frontmatter.name}: ${s.frontmatter.description || "(no description)"} [${s.enabled ? "enabled" : "disabled"}]`,
        );
        return {
          success: true,
          output: `${skills.length} skills available:\n${lines.join("\n")}`,
          data: skills.map((s) => ({
            name: s.frontmatter.name,
            description: s.frontmatter.description,
            enabled: s.enabled,
          })),
        };
      },
    },
  ];

  // ── Marketplace tools (only when marketplace instance is provided) ────
  if (marketplace) {
    tools.push(
      // ── skill_search ────────────────────────────────────
      {
        name: "skill_search",
        description:
          "Search the remote skill marketplace (SkillHub, ClawHub) for skills matching a query. " +
          "Returns a list with name, description, sourceUrl. " +
          "Use skill_install with the sourceUrl to install a skill.",
        parameters: z.object({
          query: z.string().describe("Search keywords, e.g. 'git commit', 'code review', 'deploy'"),
        }),
        execute: async (params: unknown, _ctx?: ToolContext): Promise<ToolResult> => {
          const { query } = params as { query: string };
          try {
            const results = await marketplace.search(query);
            if (results.length === 0) {
              return {
                success: true,
                output: `No skills found for "${query}". Try broader or different keywords.`,
              };
            }
            const lines = results.map(
              (r, i) =>
                `${i + 1}. **${r.name}**\n` +
                `   ${r.description || "(no description)"}\n` +
                `   sourceUrl: ${r.sourceUrl}\n` +
                `   source: ${r.sourceName}` +
                (r.author ? ` | author: ${r.author}` : "") +
                (r.rating != null ? ` | rating: ${r.rating}` : ""),
            );
            return {
              success: true,
              output: `Found ${results.length} skill(s) for "${query}":\n\n${lines.join("\n\n")}`,
              data: results.map((r) => ({
                name: r.name,
                description: r.description,
                sourceUrl: r.sourceUrl,
                sourceName: r.sourceName,
                author: r.author,
                rating: r.rating,
              })),
            };
          } catch (err: any) {
            return {
              success: false,
              output: `Marketplace search failed: ${err.message}`,
            };
          }
        },
      },

      // ── skill_install ───────────────────────────────────
      {
        name: "skill_install",
        description:
          "Install a skill from the marketplace by its source URL. " +
          "Get the sourceUrl from skill_search results. " +
          "After installation the skill is immediately available in <available_skills> and can be loaded with skill_read.",
        parameters: z.object({
          sourceUrl: z.string().describe("The raw download URL of the skill (from skill_search results)"),
          sourceName: z.string().optional().describe("Source marketplace name, e.g. 'skillhub'"),
        }),
        execute: async (params: unknown, _ctx?: ToolContext): Promise<ToolResult> => {
          const { sourceUrl, sourceName } = params as {
            sourceUrl: string;
            sourceName?: string;
          };
          try {
            const result = await marketplace.install(
              sourceUrl,
              sourceName ?? "marketplace",
            );
            if (!result.success) {
              return {
                success: false,
                output: `Installation failed: ${result.error}`,
              };
            }
            // Reload skills so the new skill is immediately available
            loader.loadAll();
            return {
              success: true,
              output:
                `Skill "${result.name}" (v${result.version}) installed successfully!\n` +
                `Format: ${result.format} | ID: ${result.skillId}\n` +
                `The skill is now loaded and ready. Use skill_read("${result.name}") to view full instructions.`,
              data: {
                skillId: result.skillId,
                name: result.name,
                version: result.version,
                format: result.format,
              },
            };
          } catch (err: any) {
            return {
              success: false,
              output: `Installation error: ${err.message}`,
            };
          }
        },
      },
    );
  }

  // ── Slash command tool (Spec v3 Task 6: 斜杠命令激活) ────
  // 缓存命令映射，首次调用时加载
  let cachedCommands: Map<string, SkillCommandEntry> | null = null;

  tools.push({
    name: "skill_command",
    description:
      "Execute a skill as a slash command. Format: /skill-name [args]. " +
      "Lists available commands when called without input, or activates a specific skill by command name.",
    parameters: z.object({
      input: z.string().describe("Slash command input, e.g. '/git-commit fix the login bug' or empty to list commands"),
    }),
    execute: async (params: unknown, _ctx?: ToolContext): Promise<ToolResult> => {
      const { input } = params as { input: string };

      // 懒加载命令映射
      if (!cachedCommands) {
        cachedCommands = scanSkillCommands(loader);
      }

      // 无输入时列出可用命令
      if (!input.trim()) {
        const list = formatCommandsList(cachedCommands);
        return {
          success: true,
          output: list || "No slash commands available. Install skills to enable commands.",
          data: { commandCount: cachedCommands.size },
        };
      }

      // 处理斜杠命令
      const result = handleSlashCommand(input, cachedCommands, loader, store);
      if (!result.handled) {
        return {
          success: false,
          output: `"${input}" is not a valid slash command. Use /command-name format.`,
        };
      }

      return {
        success: true,
        output: result.message ?? "Command executed.",
        data: {
          command: result.entry?.command,
          skillName: result.entry?.skillName,
          userArgs: result.userArgs,
        },
      };
    },
  });

  return tools;
}

/** 列出技能目录下的所有可读文件 (Spec v3 Task 5) */
function listSkillFiles(skillDir: string): string[] {
  const textExts = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".toml"]);
  try {
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return [];
    return readdirSync(skillDir)
      .filter((f: string) => !f.startsWith(".") && textExts.has(extname(f).toLowerCase()));
  } catch {
    return [];
  }
}
