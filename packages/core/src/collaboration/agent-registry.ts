/**
 * A2A Agent 注册表 — 跨进程 Agent 发现与注册
 *
 * 提供 IAgentRegistry 接口及两种实现：
 * - InMemoryAgentRegistry：Map-based MVP，TTL 过期检测
 * - SqliteAgentRegistry：持久化版本，查 agent_registry 表
 *
 * @see a2a-spec.md §4 发现策略（四级回退）
 * @see Spec §5.3 Task 5.2 + §7.2 Agent Card
 */

import type { A2AAgentCard } from "./a2a-types.js";
import { getDatabase } from "../persistence/sqlite.js";

// ─── 注册表接口 ─────────────────────────────────────────────

/** Agent 注册条目（注册表内部存储） */
export interface AgentRegistryEntry {
  card: A2AAgentCard;
  endpoint: string;
  lastHeartbeat: number; // Date.now() 毫秒时间戳
  ttlMs: number;
  status: "online" | "offline" | "draining";
}

/** Agent 发现过滤条件 */
export interface DiscoverFilter {
  /** 按技能标签过滤 */
  capability?: string;
  /** 按技能 tag 过滤 */
  tag?: string;
  /** 仅返回在线 Agent */
  onlineOnly?: boolean;
}

/**
 * Agent 注册表接口 — 所有实现需满足此契约。
 * orchestrator 的四级回退中第 3 级（Curated Registry）使用此接口。
 */
export interface IAgentRegistry {
  /** 注册 Agent（含心跳 TTL），已存在则更新 */
  register(card: A2AAgentCard, ttlMs?: number): Promise<void>;
  /** 注销 Agent */
  unregister(agentId: string): Promise<void>;
  /** 心跳保活 — 刷新 lastHeartbeat 时间戳 */
  heartbeat(agentId: string): Promise<void>;
  /** 按条件发现 Agent */
  discover(filter?: DiscoverFilter): Promise<A2AAgentCard[]>;
  /** 精确解析单个 Agent（按 name 查找） */
  resolve(agentId: string): Promise<A2AAgentCard | null>;
}

// ─── 内存注册表（MVP） ──────────────────────────────────────

/** 默认心跳 TTL：30 秒 */
const DEFAULT_TTL_MS = 30_000;

/**
 * InMemoryAgentRegistry — 基于 Map 的轻量注册表。
 * 适用于单进程开发场景，进程退出后数据丢失。
 * TTL 过期检测在 discover/resolve 时惰性执行。
 */
export class InMemoryAgentRegistry implements IAgentRegistry {
  private entries = new Map<string, AgentRegistryEntry>();

  async register(card: A2AAgentCard, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
    const agentId = card.name; // 用 name 作为注册 ID
    this.entries.set(agentId, {
      card,
      endpoint: card.url,
      lastHeartbeat: Date.now(),
      ttlMs,
      status: "online",
    });
  }

  async unregister(agentId: string): Promise<void> {
    this.entries.delete(agentId);
  }

  async heartbeat(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (entry) {
      entry.lastHeartbeat = Date.now();
      entry.status = "online";
    }
  }

  async discover(filter?: DiscoverFilter): Promise<A2AAgentCard[]> {
    this.evictExpired();
    const results: A2AAgentCard[] = [];
    for (const entry of this.entries.values()) {
      // 过滤离线
      if (filter?.onlineOnly && entry.status !== "online") continue;
      // 按 capability（匹配 skill name）
      if (filter?.capability) {
        const hasCapability = entry.card.skills.some(
          (s) => s.name.toLowerCase().includes(filter.capability!.toLowerCase()),
        );
        if (!hasCapability) continue;
      }
      // 按 tag（匹配 skill tags）
      if (filter?.tag) {
        const hasTag = entry.card.skills.some((s) =>
          s.tags.some((t) => t.toLowerCase().includes(filter.tag!.toLowerCase())),
        );
        if (!hasTag) continue;
      }
      results.push(entry.card);
    }
    return results;
  }

  async resolve(agentId: string): Promise<A2AAgentCard | null> {
    this.evictExpired();
    const entry = this.entries.get(agentId);
    if (!entry || entry.status === "offline") return null;
    return entry.card;
  }

  /** 惰性淘汰过期条目 — TTL 超过后标记为 offline */
  private evictExpired(): void {
    const now = Date.now();
    for (const [, entry] of this.entries) {
      if (entry.status === "online" && now - entry.lastHeartbeat > entry.ttlMs) {
        entry.status = "offline";
      }
    }
  }
}

// ─── SQLite 持久化注册表 ────────────────────────────────────

/**
 * SqliteAgentRegistry — 查 agent_registry 表实现持久化。
 * 适用于需要跨进程/重启后保留注册信息的场景。
 * TTL 过期同样在查询时惰性检测。
 */
export class SqliteAgentRegistry implements IAgentRegistry {
  async register(card: A2AAgentCard, ttlMs: number = DEFAULT_TTL_MS): Promise<void> {
    const db = getDatabase();
    const agentId = card.name;
    const now = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO agent_registry (agentId, card, endpoint, lastHeartbeat, ttlMs, status)
       VALUES (?, ?, ?, ?, ?, 'online')`,
      [agentId, JSON.stringify(card), card.url, now, ttlMs],
    );
  }

  async unregister(agentId: string): Promise<void> {
    const db = getDatabase();
    db.run("DELETE FROM agent_registry WHERE agentId = ?", [agentId]);
  }

  async heartbeat(agentId: string): Promise<void> {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      "UPDATE agent_registry SET lastHeartbeat = ?, status = 'online' WHERE agentId = ?",
      [now, agentId],
    );
  }

  async discover(filter?: DiscoverFilter): Promise<A2AAgentCard[]> {
    const db = getDatabase();
    // 先惰性淘汰过期条目
    this.evictExpiredSync(db);

    let sql = "SELECT card FROM agent_registry WHERE 1=1";
    const params: unknown[] = [];

    if (filter?.onlineOnly) {
      sql += " AND status = 'online'";
    }

    const rows = db.exec(sql, params);
    if (!rows.length || !rows[0].values.length) return [];

    const results: A2AAgentCard[] = [];
    for (const row of rows[0].values) {
      try {
        const card: A2AAgentCard = JSON.parse(row[0] as string);
        // 应用 capability / tag 过滤（SQL 层无法查 JSON 内部字段）
        if (filter?.capability) {
          const hasCapability = card.skills.some(
            (s) => s.name.toLowerCase().includes(filter.capability!.toLowerCase()),
          );
          if (!hasCapability) continue;
        }
        if (filter?.tag) {
          const hasTag = card.skills.some((s) =>
            s.tags.some((t) => t.toLowerCase().includes(filter.tag!.toLowerCase())),
          );
          if (!hasTag) continue;
        }
        results.push(card);
      } catch {
        // JSON 解析失败的条目跳过
      }
    }
    return results;
  }

  async resolve(agentId: string): Promise<A2AAgentCard | null> {
    const db = getDatabase();
    this.evictExpiredSync(db);

    const rows = db.exec(
      "SELECT card FROM agent_registry WHERE agentId = ? AND status = 'online'",
      [agentId],
    );
    if (!rows.length || !rows[0].values.length) return null;
    try {
      return JSON.parse(rows[0].values[0][0] as string);
    } catch {
      return null;
    }
  }

  /**
   * 惰性淘汰过期条目 — 对比 lastHeartbeat + ttlMs 与当前时间。
   * SQLite 中 datetime 用 ISO 8601 存储，计算用 JS 层完成。
   */
  private evictExpiredSync(db: ReturnType<typeof getDatabase>): void {
    const now = Date.now();
    const rows = db.exec(
      "SELECT agentId, lastHeartbeat, ttlMs FROM agent_registry WHERE status = 'online'",
    );
    if (!rows.length || !rows[0].values.length) return;

    for (const row of rows[0].values) {
      const agentId = row[0] as string;
      const lastHeartbeat = new Date(row[1] as string).getTime();
      const ttlMs = row[2] as number;
      if (now - lastHeartbeat > ttlMs) {
        db.run(
          "UPDATE agent_registry SET status = 'offline' WHERE agentId = ?",
          [agentId],
        );
      }
    }
  }
}
