/**
 * Approval — 安全审批机制
 *
 * 参考 Hermes approval.py L199-L919 完整实现:
 * - 三级审批: once(单次) / session(会话级) / always(永久)
 * - 会话隔离: 通过 sessionKey 区分
 * - 网关异步审批: 创建 ApprovalEntry + Promise 阻塞等待
 *
 * 职责: 当 CommandGuard 检测到危险命令时，提供审批流程。
 * 不修改 SecurityManager，作为独立模块运行。
 */

import pino from "pino";
import { randomUUID } from "node:crypto";
import type { CommandGuardResult } from "./command-guard.js";

const logger = pino({ name: "approval" });

// ─── 类型定义 ──────────────────────────────────────────────

/** 审批级别 */
export type ApprovalScope = "once" | "session" | "always";

/** 审批状态 */
export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout";

/** 审批条目 */
export interface ApprovalEntry {
  id: string;
  command: string;
  guardResult: CommandGuardResult;
  scope: ApprovalScope;
  status: ApprovalStatus;
  sessionKey: string;
  createdAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

/** 审批请求结果 */
export interface ApprovalResult {
  approved: boolean;
  scope: ApprovalScope;
  reason?: string;
}

// ─── 审批存储 ──────────────────────────────────────────────

/** 会话级已批准的模式 — Map<sessionKey, Set<patternKey>> */
const _sessionApproved = new Map<string, Set<string>>();

/** 永久白名单 — 会话间持久 */
const _permanentApproved = new Set<string>();

/** 待审批队列 — Map<entryId, ApprovalEntry + resolve回调> */
const _pendingApprovals = new Map<string, {
  entry: ApprovalEntry;
  resolve: (result: ApprovalResult) => void;
}>();

// ─── 核心检查函数 ──────────────────────────────────────────

/**
 * 检查命令是否已被批准（无需再次审批）
 *
 * 检查顺序:
 * 1. 永久白名单
 * 2. 会话级白名单
 *
 * @param patternKey 危险模式键名
 * @param sessionKey 会话标识
 */
export function isApproved(patternKey: string, sessionKey: string): boolean {
  // 永久白名单
  if (_permanentApproved.has(patternKey)) return true;

  // 会话级白名单
  const sessionSet = _sessionApproved.get(sessionKey);
  if (sessionSet?.has(patternKey)) return true;

  return false;
}

/**
 * 记录审批结果
 */
export function recordApproval(
  patternKey: string,
  sessionKey: string,
  scope: ApprovalScope,
): void {
  switch (scope) {
    case "once":
      // ℹ️ 设计意图: "once" 表示“仅此一次”，不持久化到任何存储。
      // 审批结果通过 requestApproval() 返回的 Promise resolve 传递，
      // isApproved() 对 once scope 始终返回 false 是正确行为——
      // 这确保下次相同命令会再次触发审批。
      break;
    case "session":
      if (!_sessionApproved.has(sessionKey)) {
        _sessionApproved.set(sessionKey, new Set());
      }
      _sessionApproved.get(sessionKey)!.add(patternKey);
      logger.info({ patternKey, sessionKey }, "会话级审批已记录");
      break;
    case "always":
      _permanentApproved.add(patternKey);
      logger.info({ patternKey }, "永久审批已记录");
      break;
  }
}

/**
 * 创建审批请求（用于网关异步审批）
 *
 * @param command 待审批的命令
 * @param guardResult CommandGuard 检测结果
 * @param sessionKey 会话标识
 * @param timeoutMs 审批等待超时（默认300秒）
 * @returns Promise，在用户审批或超时后 resolve
 */
export function requestApproval(
  command: string,
  guardResult: CommandGuardResult,
  sessionKey: string,
  timeoutMs = 300_000,
): Promise<ApprovalResult> {
  const id = `approval-${Date.now()}-${randomUUID().slice(0, 8)}`; // P3-T7: 安全随机数替代 Math.random()

  return new Promise((resolve) => {
    const entry: ApprovalEntry = {
      id,
      command,
      guardResult,
      scope: "once",
      status: "pending",
      sessionKey,
      createdAt: new Date(),
    };

    _pendingApprovals.set(id, { entry, resolve });

    logger.info({ id, command: command.slice(0, 80), pattern: guardResult.patternKey }, "审批请求已创建");

    // 超时自动拒绝
    setTimeout(() => {
      const pending = _pendingApprovals.get(id);
      if (pending && pending.entry.status === "pending") {
        pending.entry.status = "timeout";
        pending.entry.resolvedAt = new Date();
        _pendingApprovals.delete(id);
        resolve({ approved: false, scope: "once", reason: "审批超时" });
        logger.info({ id }, "审批请求超时");
      }
    }, timeoutMs);
  });
}

/**
 * 解决审批请求（用户通过网关/CLI 批准或拒绝）
 * 
 * P3-T4: 新增 resolverSessionKey 参数用于身份验证，
 * 确保审批人与创建审批请求的用户属于同一会话。
 */
export function resolveApproval(
  entryId: string,
  approved: boolean,
  scope: ApprovalScope = "once",
  resolvedBy?: string,
  resolverSessionKey?: string,
): boolean {
  const pending = _pendingApprovals.get(entryId);
  if (!pending) return false;

  // P3-T4: 审批人身份验证 — resolver 的 session 必须与审批请求的 session 一致
  if (resolverSessionKey && resolverSessionKey !== pending.entry.sessionKey) {
    logger.warn({
      entryId,
      expectedSession: pending.entry.sessionKey?.slice(0, 8),
      actualSession: resolverSessionKey.slice(0, 8),
    }, "审批人 session 与审批请求 session 不匹配，拒绝操作");
    return false;
  }

  const { entry, resolve } = pending;
  entry.status = approved ? "approved" : "denied";
  entry.resolvedAt = new Date();
  entry.resolvedBy = resolvedBy;
  entry.scope = scope;

  if (approved && entry.guardResult.patternKey) {
    recordApproval(entry.guardResult.patternKey, entry.sessionKey, scope);
  }

  _pendingApprovals.delete(entryId);
  resolve({ approved, scope, reason: approved ? "用户批准" : "用户拒绝" });

  logger.info({ id: entryId, approved, scope }, "审批请求已解决");
  return true;
}

/**
 * 批量批准所有待审批请求
 */
export function resolveAllPending(
  approved: boolean,
  scope: ApprovalScope = "session",
): number {
  let count = 0;
  for (const [id] of _pendingApprovals) {
    resolveApproval(id, approved, scope);
    count++;
  }
  return count;
}

/**
 * 获取所有待审批请求
 */
export function listPendingApprovals(): ApprovalEntry[] {
  return Array.from(_pendingApprovals.values()).map(p => ({ ...p.entry }));
}

/**
 * 清理会话级审批记录
 */
export function clearSessionApprovals(sessionKey: string): void {
  _sessionApproved.delete(sessionKey);
}

/**
 * 清除所有审批记录（仅用于测试）
 */
export function _resetApprovals(): void {
  _sessionApproved.clear();
  _permanentApproved.clear();
  _pendingApprovals.clear();
}
