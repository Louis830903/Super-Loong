/**
 * 风险评分引擎（Task 1.1）
 *
 * 借鉴 self-healing-agents 的风险感知决策：
 * - 8 档内置风险剖面，覆盖常见部署/数据/网络/支付场景
 * - 4 级决策矩阵（auto_apply → escalate）
 * - Fix 类型修正系数（retry/patch/heal 对风险的加减权）
 */

import pino from "pino";
const logger = pino({ name: "risk-engine" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 8 种内置风险剖面 */
export type RiskProfile =
  | "static_site"
  | "cron_job"
  | "social_media"
  | "email"
  | "payment"
  | "deployment"
  | "config"
  | "database";

/** 4 级决策 */
export type RiskDecision = "auto_apply" | "apply_with_caution" | "human_review" | "escalate";

/** Fix 类型 */
export type FixType = "retry" | "patch" | "heal";

/** 单条风险剖面定义 */
export interface RiskProfileDef {
  profile: RiskProfile;
  baseRisk: number; // 0.0–1.0
  reversible: boolean;
  userFacing: boolean;
  dataLoss: boolean;
  description: string;
}

/** 评分结果 */
export interface RiskScore {
  score: number; // 0.0–1.0
  decision: RiskDecision;
  profile: RiskProfile | "unknown";
  factors: string[]; // 影响评分的因子说明
}

// ═══════════════════════════════════════════════════════════════
// 8 档内置风险剖面
// ═══════════════════════════════════════════════════════════════

const RISK_PROFILES: Record<RiskProfile, RiskProfileDef> = {
  static_site: {
    profile: "static_site",
    baseRisk: 0.2,
    reversible: true,
    userFacing: true,
    dataLoss: false,
    description: "静态网站/页面：低风险，变更可轻易回滚",
  },
  cron_job: {
    profile: "cron_job",
    baseRisk: 0.3,
    reversible: true,
    userFacing: false,
    dataLoss: false,
    description: "定时任务：中等偏低风险，后台运行不影响用户",
  },
  social_media: {
    profile: "social_media",
    baseRisk: 0.4,
    reversible: true,
    userFacing: true,
    dataLoss: false,
    description: "社交媒体操作：中等风险，对外发布但可删除",
  },
  email: {
    profile: "email",
    baseRisk: 0.5,
    reversible: false,
    userFacing: true,
    dataLoss: false,
    description: "邮件发送：中等风险，发送后不可撤回",
  },
  payment: {
    profile: "payment",
    baseRisk: 0.9,
    reversible: false,
    userFacing: false,
    dataLoss: true,
    description: "支付/交易：极高风险，涉及资金和数据安全",
  },
  deployment: {
    profile: "deployment",
    baseRisk: 0.7,
    reversible: true,
    userFacing: true,
    dataLoss: false,
    description: "部署操作：高风险，可能影响线上服务",
  },
  config: {
    profile: "config",
    baseRisk: 0.6,
    reversible: true,
    userFacing: false,
    dataLoss: false,
    description: "配置变更：中高风险，可能影响系统行为",
  },
  database: {
    profile: "database",
    baseRisk: 0.8,
    reversible: false,
    userFacing: false,
    dataLoss: true,
    description: "数据库操作：高风险，数据变更可能不可逆",
  },
};

// ═══════════════════════════════════════════════════════════════
// Fix 类型修正系数（借鉴 self-healing-agents）
// ═══════════════════════════════════════════════════════════════

const FIX_TYPE_MODIFIERS: Record<FixType, number> = {
  retry: -0.15, // 重试：降低风险（只重复已有操作）
  patch: 0.0,   // 修补：风险不变
  heal: +0.1,   // 自愈：略增风险（自动修改系统行为）
};

// ═══════════════════════════════════════════════════════════════
// 4 级决策矩阵
// ═══════════════════════════════════════════════════════════════

function scoreToDecision(score: number): RiskDecision {
  if (score <= 0.3) return "auto_apply";
  if (score <= 0.6) return "apply_with_caution";
  if (score <= 0.8) return "human_review";
  return "escalate";
}

// ═══════════════════════════════════════════════════════════════
// RiskEngine 核心类
// ═══════════════════════════════════════════════════════════════

export class RiskEngine {
  /**
   * 根据技能名称/描述推断风险剖面
   *
   * 关键词匹配策略：扫描 skillName + description 中的领域关键词
   */
  detectProfile(skillName: string, description: string): RiskProfile | "unknown" {
    const text = `${skillName} ${description}`.toLowerCase();

    // 按 specificity（特异性）排序：先匹配具体领域，再通用
    if (/\b(payment|pay|checkout|invoice|billing|transaction|charge|refund)\b/.test(text)) return "payment";
    if (/\b(database|db|sql|query|migration|schema|table|insert|delete|truncate)\b/.test(text)) return "database";
    if (/\b(deploy|release|publish|cdn|rollback|staging|production)\b/.test(text)) return "deployment";
    if (/\b(config|settings|env|environment|configure|setup|init)\b/.test(text)) return "config";
    if (/\b(email|mail|newsletter|send|smtp|sendgrid)\b/.test(text)) return "email";
    if (/\b(social|tweet|post|facebook|instagram|linkedin|weibo|twitter)\b/.test(text)) return "social_media";
    if (/\b(cron|schedule|job|task|automation|定时|任务)\b/.test(text)) return "cron_job";
    if (/\b(static|html|css|page|website|landing|blog)\b/.test(text)) return "static_site";

    return "unknown";
  }

  /**
   * 计算最终风险评分
   *
   * @param skillName   技能名称
   * @param description 技能描述
   * @param fixType     Fix 类型（retry / patch / heal）
   * @returns RiskScore 含评分、决策级别、影响因子
   */
  score(
    skillName: string,
    description: string,
    fixType?: FixType,
  ): RiskScore {
    const factors: string[] = [];
    const profile = this.detectProfile(skillName, description);

    // 1. 基础分：根据风险剖面
    let score: number;
    let profileLabel: RiskProfile | "unknown";

    if (profile !== "unknown") {
      const def = RISK_PROFILES[profile];
      score = def.baseRisk;
      profileLabel = profile;
      factors.push(`风险剖面: ${def.description} (baseRisk=${def.baseRisk})`);

      // 附加因子：reversible 减分，userFacing 加分，dataLoss 加分
      if (def.reversible) {
        score = Math.max(0, score - 0.1);
        factors.push("可逆操作 (-0.1)");
      }
      if (def.userFacing) {
        score = Math.min(1.0, score + 0.1);
        factors.push("用户可见 (+0.1)");
      }
      if (def.dataLoss) {
        score = Math.min(1.0, score + 0.15);
        factors.push("数据丢失风险 (+0.15)");
      }
    } else {
      // 未知领域：默认中等风险
      score = 0.4;
      profileLabel = "unknown";
      factors.push("未知风险剖面 (default=0.4)");
    }

    // 2. Fix 类型修正
    if (fixType) {
      const modifier = FIX_TYPE_MODIFIERS[fixType];
      score = Math.max(0, Math.min(1.0, score + modifier));
      factors.push(`Fix 类型 "${fixType}" 修正 (${modifier >= 0 ? "+" : ""}${modifier})`);
    }

    // 3. 技能名称/描述额外安全信号
    // 敏感词检测惩罚
    const sensitiveTokens = ["sudo", "root", "admin", "rm -rf", "delete all", "drop table", "format"];
    for (const token of sensitiveTokens) {
      if (skillName.toLowerCase().includes(token) || description.toLowerCase().includes(token)) {
        score = Math.min(1.0, score + 0.2);
        factors.push(`敏感词 "${token}" (+0.2)`);
        break; // 只加一次
      }
    }

    const finalScore = Math.round(score * 100) / 100; // 保留两位小数
    const decision = scoreToDecision(finalScore);

    logger.debug({ profile: profileLabel, finalScore, decision, factors }, "Risk score calculated");

    return {
      score: finalScore,
      decision,
      profile: profileLabel,
      factors,
    };
  }

  /**
   * 获取所有可用的风险剖面定义（供 UI 展示）
   */
  static getProfiles(): RiskProfileDef[] {
    return Object.values(RISK_PROFILES);
  }

  /**
   * 根据风险剖面获取定义
   */
  static getProfileDef(profile: RiskProfile): RiskProfileDef | null {
    return RISK_PROFILES[profile] ?? null;
  }
}
