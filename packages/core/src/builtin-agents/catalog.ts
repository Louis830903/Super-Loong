/**
 * 内置专家 Agent 总目录 — 汇总所有部门
 * 自动生成 — 请勿手动编辑
 *
 * 总计: 211 个 Agent，覆盖 17 个部门
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

/** 所有内置专家 Agent 的完整目录 */
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
