/**
 * 离线转换脚本 — 将 agency-agents-zh 仓库的 211 个专家 Agent .md 文件
 * 解析 Frontmatter + Markdown 正文，按部门拆分输出为 TypeScript catalog 文件。
 *
 * 运行方式:
 *   npx tsx packages/core/scripts/import-agency-agents.ts          # 正常运行
 *   npx tsx packages/core/scripts/import-agency-agents.ts --dry-run # 只预览不写入
 *
 * v4 改善：
 * - P0-2: ID 改为 builtin_${department}-${slug}，避免跨部门同名碰撞
 * - P1-6: normalizeColor() 在源头归一化 CSS 颜色名为 hex
 * - P2-1: metadata 增加 version + importedAt 字段
 * - P3-1: 支持 --dry-run 参数，只预览不写入文件
 *
 * v3 审查修正：
 * - 排除 integrations / strategy / examples / scripts 目录
 * - 递归扫描 game-development 子目录（unity/unreal-engine/godot/blender/roblox-studio）
 * - Frontmatter 过滤：无 name 字段的文件跳过（strategy 目录全部无 Frontmatter）
 * - tools 字段为逗号分隔字符串，需 split 处理
 * - color 字段在源头归一化为 hex 格式
 */

import matter from "gray-matter";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 常量定义 ────────────────────────────────────────────

// 17 个有效部门目录（v3 修正：移除 integrations 和 strategy）
const DEPARTMENTS = [
  "academic", "design", "engineering", "finance",
  "game-development", "hr", "legal",
  "marketing", "paid-media", "product", "project-management",
  "sales", "spatial-computing", "specialized",
  "supply-chain", "support", "testing",
];

// 排除的目录（非 Agent 角色目录）
const EXCLUDED_DIRS = ["examples", "integrations", "strategy", "scripts", ".github"];

// P3-1: --dry-run 模式支持
const DRY_RUN = process.argv.includes("--dry-run");

// P2-1: 版本号和导入时间戳
const CATALOG_VERSION = "1.0.0";
const IMPORTED_AT = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// P1-6: CSS 颜色名到 hex 映射表（源头归一化，前端不再需要兼容）
const CSS_COLOR_TO_HEX: Record<string, string> = {
  purple: "#8B5CF6", green: "#10B981", teal: "#14B8A6",
  blue: "#3B82F6", orange: "#F97316", violet: "#8B5CF6",
  red: "#EF4444", pink: "#EC4899", yellow: "#EAB308",
  indigo: "#6366F1", cyan: "#06B6D4", white: "#FFFFFF",
  black: "#000000", gray: "#6B7280", grey: "#6B7280",
};

/**
 * P1-6: 将 CSS 颜色名或非标准格式统一归一化为 #RRGGBB hex
 * - 已经是 hex 格式：直接返回（自动补全 #RGB → #RRGGBB）
 * - CSS 颜色名：查表转换
 * - 无法识别：返回 null
 */
function normalizeColor(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 已经是 #RRGGBB 格式
  if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;

  // #RGB 简写 → #RRGGBB
  if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed.split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  // CSS 颜色名查表
  const hex = CSS_COLOR_TO_HEX[trimmed.toLowerCase()];
  if (hex) return hex;

  // 无法识别的格式，返回 null（前端使用默认色）
  console.warn(`  ⚠️ 无法归一化颜色: "${trimmed}"，将使用默认色`);
  return null;
}

// 部门中文名映射（完整 17 项）
const DEPT_LABELS: Record<string, string> = {
  "academic": "学术研究",
  "design": "设计",
  "engineering": "工程",
  "finance": "金融",
  "game-development": "游戏开发",
  "hr": "人力资源",
  "legal": "法务",
  "marketing": "市场营销",
  "paid-media": "付费媒体",
  "product": "产品",
  "project-management": "项目管理",
  "sales": "销售",
  "spatial-computing": "空间计算",
  "specialized": "专业领域",
  "supply-chain": "供应链",
  "support": "客户支持",
  "testing": "测试",
};

// ─── 工具函数 ────────────────────────────────────────────

/**
 * 递归收集目录下所有 .md 文件（处理 game-development 子目录）
 */
function collectMdFiles(dirPath: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dirPath)) return results;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.join(dirPath, entry.name));
    } else if (entry.isDirectory()) {
      // 递归进入子目录（如 game-development/unity/）
      results.push(...collectMdFiles(path.join(dirPath, entry.name)));
    }
  }
  return results;
}

/**
 * 解析单个 Agent .md 文件为 AgentConfig 对象
 * v3: 无 Frontmatter name 字段则返回 null（安全兜底）
 */
function parseAgentFile(filePath: string, department: string) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  // v3 审查：无 Frontmatter 或无 name 字段的文件跳过
  if (!data.name) return null;

  const slug = path.basename(filePath, ".md");

  // v3 审查：tools 字段为逗号分隔字符串，需 split 处理
  let originalTools: string[] | null = null;
  if (typeof data.tools === "string") {
    originalTools = data.tools.split(",").map((t: string) => t.trim()).filter(Boolean);
  } else if (Array.isArray(data.tools)) {
    originalTools = data.tools;
  }

  return {
    // P0-2: ID 包含部门前缀，避免跨部门同名碰撞
    id: `builtin_${department}-${slug}`,
    name: data.name as string,
    description: (data.description as string) || "",
    systemPrompt: content.trim(),
    tools: [] as string[],
    skills: [] as string[],
    channels: [] as string[],
    memoryEnabled: true,
    maxToolIterations: 25,
    metadata: {
      isBuiltin: true,
      source: "agency-agents-zh",
      department,
      departmentLabel: DEPT_LABELS[department] || department,
      // P1-6: 源头归一化颜色为 hex
      color: normalizeColor(data.color as string),
      slug,
      originalTools,
      // P2-1: 版本号和导入时间戳
      version: CATALOG_VERSION,
      importedAt: IMPORTED_AT,
    },
  };
}

// ─── 主逻辑 ──────────────────────────────────────────────

function main() {
  // P3-1: dry-run 模式提示
  if (DRY_RUN) {
    console.log("🔍 Dry-run 模式：仅预览，不写入文件\n");
  }

  // agency-agents-zh 仓库路径（与 super-agent 同级）
  const repoRoot = path.resolve(__dirname, "../../../../agency-agents-zh");

  if (!fs.existsSync(repoRoot)) {
    console.error(`❌ agency-agents-zh 仓库未找到: ${repoRoot}`);
    console.error("   请确保仓库已 clone 到 super-agent 同级目录");
    process.exit(1);
  }

  const outputDir = path.resolve(__dirname, "../src/builtin-agents");
  fs.mkdirSync(outputDir, { recursive: true });

  // 按部门收集所有 Agent
  const allAgents: Array<ReturnType<typeof parseAgentFile>> = [];
  const deptStats: Record<string, number> = {};

  for (const dept of DEPARTMENTS) {
    const deptDir = path.join(repoRoot, dept);
    const mdFiles = collectMdFiles(deptDir);
    let count = 0;

    for (const filePath of mdFiles) {
      const agent = parseAgentFile(filePath, dept);
      if (agent) {
        allAgents.push(agent);
        count++;
      }
    }

    deptStats[dept] = count;
    console.log(`  ✅ ${dept}: ${count} agents`);
  }

  // 检查 ID 唯一性
  const idSet = new Set<string>();
  const duplicates: string[] = [];
  for (const agent of allAgents) {
    if (!agent) continue;
    if (idSet.has(agent.id)) {
      duplicates.push(agent.id);
    }
    idSet.add(agent.id);
  }
  if (duplicates.length > 0) {
    console.error(`❌ 发现重复 ID: ${duplicates.join(", ")}`);
    process.exit(1);
  }

  // ─── 按部门拆分输出 TS 文件 ─────────────────────────

  const validAgents = allAgents.filter(Boolean);
  const deptImports: string[] = [];

  for (const dept of DEPARTMENTS) {
    const deptAgents = validAgents.filter((a) => a!.metadata.department === dept);
    if (deptAgents.length === 0) continue;

    const varName = dept.replace(/-/g, "_");
    const fileContent = `/**
 * ${DEPT_LABELS[dept] || dept} 部门内置 Agent 目录
 * 自动生成 — 请勿手动编辑
 * 来源: agency-agents-zh/${dept}/
 * 数量: ${deptAgents.length}
 */

export const ${varName}_agents = ${JSON.stringify(deptAgents, null, 2)} as const;
`;

    const fileName = `catalog-${dept}.ts`;
    // P3-1: dry-run 模式不写入文件
    if (!DRY_RUN) {
      fs.writeFileSync(path.join(outputDir, fileName), fileContent, "utf-8");
    }
    deptImports.push({ dept, varName, fileName, count: deptAgents.length } as any);
  }

  // ─── 生成汇总 catalog.ts ─────────────────────────────
  // ⚠️ 注意：BuiltinAgentEntry 接口由 catalog.ts 手动维护，此处不覆盖
  // 脚本只更新 import 语句、builtinAgentCatalog 数组、DEPT_LABELS 和 DEPARTMENTS

  const importLines = (deptImports as any[])
    .map((d: any) => `import { ${d.varName}_agents } from "./catalog-${d.dept}.js";`)
    .join("\n");

  const spreadLines = (deptImports as any[])
    .map((d: any) => `  ...${d.varName}_agents,`)
    .join("\n");

  const catalogContent = `/**
 * 内置专家 Agent 总目录 — 汇总所有部门
 * 自动生成 — 请勿手动编辑
 *
 * 总计: ${validAgents.length} 个 Agent，覆盖 ${Object.keys(deptStats).length} 个部门
 *
 * P4-T4: 懒加载改造 — catalog 仅存元数据(id/name/description)，
 * systemPrompt 通过动态 import 按需加载，大幅降低启动内存占用。
 */

${importLines}

/** 内置 Agent 条目的显式类型定义（避免 TS7056 超长推断） */
export interface BuiltinAgentEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly channels: readonly string[];
  readonly memoryEnabled: boolean;
  readonly maxToolIterations: number;
  readonly metadata: {
    readonly isBuiltin: true;
    readonly source: string;
    readonly department: string;
    readonly departmentLabel: string;
    readonly color: string | null;
    readonly slug: string;
    readonly originalTools: string | readonly string[] | null;
    /** P2-1: 内置 Agent 版本号，用于增量更新比对 */
    readonly version?: string;
    /** P2-1: 导入时间戳 */
    readonly importedAt?: string;
  };
}

/** 元数据条目（不含 systemPrompt，用于启动时快速加载） */
export interface BuiltinAgentMeta {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly channels: readonly string[];
  readonly memoryEnabled: boolean;
  readonly maxToolIterations: number;
  readonly metadata: BuiltinAgentEntry["metadata"];
}

/** 所有内置专家 Agent 的完整目录（含 systemPrompt） */
export const builtinAgentCatalog: BuiltinAgentEntry[] = [
${spreadLines}
];

/**
 * P4-T4: 静态元数据目录 — 仅包含 id/name/description 等轻量字段，
 * 不含 systemPrompt，启动时仅需少量内存。
 * 从 builtinAgentCatalog 中提取，去除 systemPrompt。
 */
export const builtinAgentCatalogMeta: BuiltinAgentMeta[] = builtinAgentCatalog.map(
  ({ systemPrompt, ...meta }) => meta
);

/**
 * P4-T4: 部门→模块导入映射，用于按需懒加载 systemPrompt
 */
const DEPT_IMPORTERS: Record<string, () => Promise<readonly BuiltinAgentEntry[]>> = {
${(deptImports as any[])
    .map((d: any) => `  "${d.dept}": () => import("./catalog-${d.dept}.js").then(m => m.${d.varName}_agents),`)
    .join("\n")}
};

/** P4-T4: systemPrompt 按需缓存，避免重复 import */
const systemPromptCache = new Map<string, string>();

/**
 * P4-T4: 按需加载指定 Agent 的 systemPrompt
 * 优先从 builtinAgentCatalog（模块初始化时已导入）查找，
 * 兜底通过动态 import 对应部门的 catalog 文件并缓存。
 */
export async function getBuiltinSystemPrompt(agentId: string): Promise<string | undefined> {
  const entry = builtinAgentCatalog.find(e => e.id === agentId);
  if (entry) return entry.systemPrompt;
  if (systemPromptCache.has(agentId)) return systemPromptCache.get(agentId);
  const match = agentId.match(/^builtin_([a-z-]+)-/);
  if (!match) return undefined;
  const dept = match[1];
  const importer = DEPT_IMPORTERS[dept];
  if (!importer) return undefined;
  try {
    const entries = await importer();
    for (const e of entries) {
      if (!systemPromptCache.has(e.id)) systemPromptCache.set(e.id, e.systemPrompt);
    }
    return systemPromptCache.get(agentId);
  } catch { return undefined; }
}

/** P4-T4: 同步获取已缓存的 systemPrompt */
export function getCachedSystemPrompt(agentId: string): string | undefined {
  return systemPromptCache.get(agentId);
}

/** 部门标签映射 */
export const DEPT_LABELS: Record<string, string> = ${JSON.stringify(DEPT_LABELS, null, 2)};

/** 部门列表（有序） */
export const DEPARTMENTS = ${JSON.stringify(DEPARTMENTS)} as const;
`;
    fs.writeFileSync(path.join(outputDir, "catalog.ts"), catalogContent, "utf-8");
  }

  // ─── 输出统计 ─────────────────────────────────────────

  console.log("\n═══════════════════════════════════════");
  console.log(`  ${DRY_RUN ? "🔍 [DRY-RUN]" : "✅"} 总计: ${validAgents.length} 个 Agent`);
  console.log(`  📁 部门: ${Object.keys(deptStats).length} 个`);
  console.log(`  🔖 版本: ${CATALOG_VERSION}  📅 导入: ${IMPORTED_AT}`);
  if (!DRY_RUN) {
    console.log(`  📄 输出: ${outputDir}/catalog.ts + ${(deptImports as any[]).length} 个子文件`);
  } else {
    console.log(`  📄 预览完成，未写入任何文件`);
  }
  console.log("═══════════════════════════════════════\n");
}

main();
