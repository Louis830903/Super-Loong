/**
 * 内置专家 Agent 总目录 — 汇总所有部门
 * 自动生成 — 请勿手动编辑
 *
 * 总计: 211 个 Agent，覆盖 17 个部门
 *
 * P4-T4: 懒加载改造 — catalog 仅存元数据(id/name/description)，
 * systemPrompt 通过动态 import 按需加载，大幅降低启动内存占用。
 */

import { academic_agents } from "./catalog-academic.js";
import { design_agents } from "./catalog-design.js";
import { engineering_agents } from "./catalog-engineering.js";
import { finance_agents } from "./catalog-finance.js";
import { game_development_agents } from "./catalog-game-development.js";
import { hr_agents } from "./catalog-hr.js";
import { legal_agents } from "./catalog-legal.js";
import { marketing_agents } from "./catalog-marketing.js";
import { paid_media_agents } from "./catalog-paid-media.js";
import { product_agents } from "./catalog-product.js";
import { project_management_agents } from "./catalog-project-management.js";
import { sales_agents } from "./catalog-sales.js";
import { spatial_computing_agents } from "./catalog-spatial-computing.js";
import { specialized_agents } from "./catalog-specialized.js";
import { supply_chain_agents } from "./catalog-supply-chain.js";
import { support_agents } from "./catalog-support.js";
import { testing_agents } from "./catalog-testing.js";

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

/**
 * P4-T4: 部门→模块导入映射，用于按需懒加载 systemPrompt
 * 启动时不导入任何子 catalog，仅在需要 systemPrompt 时才动态加载对应的部门模块
 */
const DEPT_IMPORTERS: Record<string, () => Promise<readonly BuiltinAgentEntry[]>> = {
  academic: () => import("./catalog-academic.js").then(m => m.academic_agents),
  design: () => import("./catalog-design.js").then(m => m.design_agents),
  engineering: () => import("./catalog-engineering.js").then(m => m.engineering_agents),
  finance: () => import("./catalog-finance.js").then(m => m.finance_agents),
  "game-development": () => import("./catalog-game-development.js").then(m => m.game_development_agents),
  hr: () => import("./catalog-hr.js").then(m => m.hr_agents),
  legal: () => import("./catalog-legal.js").then(m => m.legal_agents),
  marketing: () => import("./catalog-marketing.js").then(m => m.marketing_agents),
  "paid-media": () => import("./catalog-paid-media.js").then(m => m.paid_media_agents),
  product: () => import("./catalog-product.js").then(m => m.product_agents),
  "project-management": () => import("./catalog-project-management.js").then(m => m.project_management_agents),
  sales: () => import("./catalog-sales.js").then(m => m.sales_agents),
  "spatial-computing": () => import("./catalog-spatial-computing.js").then(m => m.spatial_computing_agents),
  specialized: () => import("./catalog-specialized.js").then(m => m.specialized_agents),
  "supply-chain": () => import("./catalog-supply-chain.js").then(m => m.supply_chain_agents),
  support: () => import("./catalog-support.js").then(m => m.support_agents),
  testing: () => import("./catalog-testing.js").then(m => m.testing_agents),
};

/** P4-T4: systemPrompt 按需缓存，避免重复 import */
const systemPromptCache = new Map<string, string>();

/**
 * P4-T4: 按需加载指定 Agent 的 systemPrompt
 * 优先从 builtinAgentCatalog（模块初始化时已导入）查找，
 * 兜底通过动态 import 对应部门的 catalog 文件并缓存。
 * @returns systemPrompt 字符串，未找到返回 undefined
 */
export async function getBuiltinSystemPrompt(agentId: string): Promise<string | undefined> {
  // 优先从已导入的 builtinAgentCatalog 中查找
  const entry = builtinAgentCatalog.find(e => e.id === agentId);
  if (entry) return entry.systemPrompt;

  // 兜底：动态导入
  if (systemPromptCache.has(agentId)) {
    return systemPromptCache.get(agentId);
  }
  // 从 agentId 提取部门: builtin_{dept}-{slug}
  const match = agentId.match(/^builtin_([a-z-]+)-/);
  if (!match) return undefined;
  const dept = match[1];
  const importer = DEPT_IMPORTERS[dept];
  if (!importer) return undefined;
  try {
    const entries = await importer();
    for (const e of entries) {
      if (!systemPromptCache.has(e.id)) {
        systemPromptCache.set(e.id, e.systemPrompt);
      }
    }
    return systemPromptCache.get(agentId);
  } catch {
    return undefined;
  }
}

/**
 * P4-T4: 同步获取已缓存的 systemPrompt（仅在已通过 getBuiltinSystemPrompt 预热后可用）
 */
export function getCachedSystemPrompt(agentId: string): string | undefined {
  return systemPromptCache.get(agentId);
}

/**
 * 完全目录（含 systemPrompt）— 保持向后兼容。
 * 由子 catalog 的静态导入组装。
 */
export const builtinAgentCatalog: BuiltinAgentEntry[] = [
  ...academic_agents,
  ...design_agents,
  ...engineering_agents,
  ...finance_agents,
  ...game_development_agents,
  ...hr_agents,
  ...legal_agents,
  ...marketing_agents,
  ...paid_media_agents,
  ...product_agents,
  ...project_management_agents,
  ...sales_agents,
  ...spatial_computing_agents,
  ...specialized_agents,
  ...supply_chain_agents,
  ...support_agents,
  ...testing_agents,
];

/**
 * P4-T4: 静态元数据目录 — 仅包含 id/name/description 等轻量字段，
 * 不含 systemPrompt，启动时仅需少量内存。
 * 从 builtinAgentCatalog 中提取，去除 systemPrompt。
 */
export const builtinAgentCatalogMeta: BuiltinAgentMeta[] = builtinAgentCatalog.map(
  ({ systemPrompt, ...meta }) => meta
);

/** 部门标签映射 */
export const DEPT_LABELS: Record<string, string> = {
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
  "testing": "测试"
};

/** 部门列表（有序） */
export const DEPARTMENTS = ["academic","design","engineering","finance","game-development","hr","legal","marketing","paid-media","product","project-management","sales","spatial-computing","specialized","supply-chain","support","testing"] as const;
