/**
 * 级联故障检测器（Task 1.5）
 *
 * 借鉴 self-healing-agents 的级联故障识别机制：
 * - 7 种内置级联特征签名
 * - 5 分钟窗口内 3+ 失败 → 标记为级联
 * - 级联命中时推荐"先修复根因"而非逐条处理
 */

import type { InteractionCase } from "./engine.js";
import pino from "pino";

const logger = pino({ name: "cascade-detector" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 级联特征签名定义 */
export interface CascadeSignature {
  /** 签名唯一标识 */
  id: string;
  /** 人类可读名称 */
  label: string;
  /** 匹配失败原因中的关键词（不区分大小写） */
  keywords: string[];
  /** 推荐的根因修复策略 */
  rootFixHint: string;
}

/** 级联检测结果 */
export interface CascadeResult {
  /** 是否检测到级联 */
  detected: boolean;
  /** 匹配到的签名 */
  signature: CascadeSignature | null;
  /** 置信度 (0-1)：命中 case 数 / 总 recent failures */
  confidence: number;
  /** 窗口内的失败 case ID 列表 */
  involvedCaseIds: string[];
  /** 推荐的修复策略 */
  recommendation: string;
}

// ═══════════════════════════════════════════════════════════════
// 7 种内置级联特征签名
// ═══════════════════════════════════════════════════════════════

const CASCADE_SIGNATURES: CascadeSignature[] = [
  {
    id: "gateway_down",
    label: "网关不可用",
    keywords: ["gateway", "proxy", "upstream", "connection refused", "econnrefused", "502", "503", "504"],
    rootFixHint: "检查网关/代理服务状态，确认后端服务是否存活",
  },
  {
    id: "disk_full",
    label: "磁盘空间不足",
    keywords: ["disk", "space", "no space", "enospc", "quota", "full", "insufficient"],
    rootFixHint: "清理临时文件和日志；扩容或迁移数据",
  },
  {
    id: "network_down",
    label: "网络中断",
    keywords: ["network", "dns", "resolve", "timeout", "etimedout", "unreachable", "no route"],
    rootFixHint: "检查网络连接和 DNS 解析；确认防火墙规则",
  },
  {
    id: "git_locked",
    label: "Git 操作锁定",
    keywords: ["git", "lock", "index.lock", "rebase", "merge conflict", "cherry-pick"],
    rootFixHint: "手动解除 Git 锁；abort 冲突的 rebase/merge 操作",
  },
  {
    id: "auth_expired",
    label: "认证过期",
    keywords: ["auth", "token", "401", "unauthorized", "expired", "credentials", "login", "session"],
    rootFixHint: "刷新认证令牌；检查凭证有效期；重新登录",
  },
  {
    id: "api_outage",
    label: "外部 API 故障",
    keywords: ["api", "rate limit", "429", "500", "internal server", "unavailable", "maintenance"],
    rootFixHint: "等待服务恢复；切换降级策略；联系 API 提供方",
  },
  {
    id: "tmp_cleanup",
    label: "临时文件清理",
    keywords: ["tmp", "temp", "cache", "cleanup", "stale", "lock file"],
    rootFixHint: "清理过期临时文件和缓存；重启相关进程释放文件句柄",
  },
];

// ═══════════════════════════════════════════════════════════════
// CascadeDetector 核心类
// ═══════════════════════════════════════════════════════════════

export class CascadeDetector {
  /** 时间窗口（毫秒），默认 5 分钟 */
  private windowMs: number;
  /** 最小失败数阈值，默认 3 */
  private minFailures: number;
  /** 置信度阈值，默认 0.7 */
  private confidenceThreshold: number;

  constructor(
    windowMs: number = 5 * 60 * 1000,
    minFailures: number = 3,
    confidenceThreshold: number = 0.7,
  ) {
    this.windowMs = windowMs;
    this.minFailures = minFailures;
    this.confidenceThreshold = confidenceThreshold;
  }

  /**
   * 检查最近的失败案例是否构成级联故障
   *
   * @param recentCases 最近的 InteractionCase 列表（按时间降序）
   * @returns 级联检测结果
   */
  check(recentCases: InteractionCase[]): CascadeResult {
    const now = Date.now();

    // 1. 仅考虑时间窗口内的失败案例
    const windowCases = recentCases.filter((c) => {
      const elapsed = now - c.timestamp.getTime();
      return elapsed <= this.windowMs && !c.success;
    });

    const notDetected: CascadeResult = {
      detected: false,
      signature: null,
      confidence: 0,
      involvedCaseIds: [],
      recommendation: "",
    };

    // 数量不足 → 无需检测
    if (windowCases.length < this.minFailures) return notDetected;

    // 2. 遍历每个签名，检测匹配度
    let bestMatch: { signature: CascadeSignature; matchedCount: number } | null = null;

    for (const sig of CASCADE_SIGNATURES) {
      let matchedCount = 0;
      for (const c of windowCases) {
        const combined = `${c.failureReason ?? ""} ${c.userMessage} ${c.agentResponse}`.toLowerCase();
        // 任一关键词命中即计为匹配
        if (sig.keywords.some((kw) => combined.includes(kw.toLowerCase()))) {
          matchedCount++;
        }
      }

      const confidence = matchedCount / windowCases.length;
      if (confidence >= this.confidenceThreshold) {
        if (!bestMatch || confidence > (bestMatch.matchedCount / windowCases.length)) {
          bestMatch = { signature: sig, matchedCount };
        }
      }
    }

    if (!bestMatch) return notDetected;

    const confidence = bestMatch.matchedCount / windowCases.length;
    const involvedIds = windowCases.map((c) => c.id);

    const result: CascadeResult = {
      detected: true,
      signature: bestMatch.signature,
      confidence: Math.round(confidence * 100) / 100,
      involvedCaseIds: involvedIds,
      recommendation: `检测到级联故障"${bestMatch.signature.label}"（置信度: ${confidence.toFixed(2)}）。建议优先修复根因：${bestMatch.signature.rootFixHint}。涉及 ${involvedIds.length} 个失败案例。`,
    };

    logger.warn({
      signature: bestMatch.signature.id,
      confidence,
      involvedCases: involvedIds.length,
    }, "Cascade failure detected");

    return result;
  }

  /**
   * 获取所有已注册的级联签名（供 UI 展示/诊断用）
   */
  static getSignatures(): CascadeSignature[] {
    return [...CASCADE_SIGNATURES];
  }

  /**
   * 注册自定义级联签名
   */
  static registerSignature(sig: CascadeSignature): void {
    CASCADE_SIGNATURES.push(sig);
  }
}
