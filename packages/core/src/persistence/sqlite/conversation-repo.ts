/**
 * Conversation 持久化层（CORE-P1-02 批 3 抽离）。
 *
 * 承载：
 *   - ConversationRecord / ConvMessageRecord 结构
 *   - conversations / conv_messages 表的 CRUD（含事务保护）
 *   - JSONL 双写（createConversation / deleteConversation / appendConvMessage）
 *   - searchConvMessages：better-sqlite3 原生支持 FTS5，直接 MATCH conv_messages_fts
 *
 * 设计说明：
 *   - 本 repo 的 FTS 查询是 conv_messages_fts，与 fts-repo.ts 中的 memories_fts /
 *     sessions_fts 不同，独立判断/回退，避免跨 repo 耦合。
 *   - JSONL 双写为 best-effort（catch 后吞异常），不影响 SQLite 主写入成功。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getJsonlWriter } from "../jsonl-writer.js";
import { getDatabase, scheduleSave } from "./client.js";

export interface ConversationRecord {
  id: string;
  agentId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageRole: string | null;
  modelOverride: string | null;
}

export interface ConvMessageRecord {
  id: number;
  conversationId: string;
  role: string;
  content: string | null;
  toolCallId: string | null;
  toolCalls: string | null;
  toolName: string | null;
  timestamp: string;
  tokenCount: number | null;
}

/** Create a new conversation */
export function createConversation(id: string, agentId: string, title?: string, modelOverride?: string): ConversationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conversations (id, agentId, title, createdAt, updatedAt, modelOverride) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, agentId, title ?? null, now, now, modelOverride ?? null],
  );
  scheduleSave();
  const record: ConversationRecord = { id, agentId, title: title ?? null, createdAt: now, updatedAt: now, messageCount: 0, lastMessagePreview: null, lastMessageRole: null, modelOverride: modelOverride ?? null };

  // JSONL dual-write: update session index
  try {
    getJsonlWriter().updateIndex(id, { agentId, title: title ?? null, model: modelOverride ?? null, createdAt: now });
  } catch { /* best-effort */ }

  return record;
}

/** Get a conversation by ID */
export function getConversation(id: string): ConversationRecord | null {
  const db = getDatabase();
  const results = db.exec(
    "SELECT id, agentId, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageRole, modelOverride FROM conversations WHERE id = ?",
    [id],
  );
  if (!results.length || !results[0].values.length) return null;
  const v = results[0].values[0];
  return {
    id: v[0] as string, agentId: v[1] as string, title: v[2] as string | null,
    createdAt: v[3] as string, updatedAt: v[4] as string,
    messageCount: (v[5] as number) ?? 0, lastMessagePreview: v[6] as string | null,
    lastMessageRole: v[7] as string | null, modelOverride: v[8] as string | null,
  };
}

/** List conversations for an agent, ordered by updatedAt DESC */
export function listConversations(agentId: string): ConversationRecord[] {
  const db = getDatabase();
  const results = db.exec(
    "SELECT id, agentId, title, createdAt, updatedAt, messageCount, lastMessagePreview, lastMessageRole, modelOverride FROM conversations WHERE agentId = ? ORDER BY updatedAt DESC",
    [agentId],
  );
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as string, agentId: v[1] as string, title: v[2] as string | null,
    createdAt: v[3] as string, updatedAt: v[4] as string,
    messageCount: (v[5] as number) ?? 0, lastMessagePreview: v[6] as string | null,
    lastMessageRole: v[7] as string | null, modelOverride: v[8] as string | null,
  }));
}

/** Update conversation title */
export function updateConversationTitle(id: string, title: string): void {
  const db = getDatabase();
  db.run("UPDATE conversations SET title = ?, updatedAt = ? WHERE id = ?", [title, new Date().toISOString(), id]);
  scheduleSave();
}

/** Update conversation model override (null to clear and use default agent model) */
export function updateConversationModel(id: string, modelOverride: string | null): void {
  const db = getDatabase();
  db.run("UPDATE conversations SET modelOverride = ?, updatedAt = ? WHERE id = ?", [modelOverride, new Date().toISOString(), id]);
  scheduleSave();
}

/** Delete a conversation and all its messages */
export function deleteConversation(id: string): boolean {
  const db = getDatabase();
  const existing = getConversation(id);
  if (!existing) return false;
  // B-14: 事务保护，确保消息和会话原子删除
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM conv_messages WHERE conversationId = ?", [id]);
    db.run("DELETE FROM conversations WHERE id = ?", [id]);
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  scheduleSave();

  // JSONL dual-write: remove JSONL file and index entry
  try { getJsonlWriter().remove(id); } catch { /* best-effort */ }

  return true;
}

/**
 * 原子替换会话的所有消息 — 用于压缩后持久化。
 * 在事务中先删除旧消息，再批量插入新消息，保证一致性。
 */
export function replaceConvMessages(
  conversationId: string,
  messages: Array<{ role: string; content: string | null; toolCallId?: string; toolCalls?: string; toolName?: string }>,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run("BEGIN TRANSACTION");
  try {
    db.run("DELETE FROM conv_messages WHERE conversationId = ?", [conversationId]);
    for (const msg of messages) {
      db.run(
        `INSERT INTO conv_messages (conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [conversationId, msg.role, msg.content ?? null, msg.toolCallId ?? null,
         msg.toolCalls ?? null, msg.toolName ?? null, now, null],
      );
    }
    const preview = messages.length > 0 ? (messages[messages.length - 1].content ?? "").slice(0, 80) : null;
    db.run(
      "UPDATE conversations SET messageCount = ?, updatedAt = ?, lastMessagePreview = ? WHERE id = ?",
      [messages.length, now, preview, conversationId],
    );
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  scheduleSave();
}

/** Append a single message to a conversation and update counters */
export function appendConvMessage(
  conversationId: string,
  role: string,
  content: string | null,
  opts?: { toolCallId?: string; toolCalls?: string; toolName?: string; tokenCount?: number },
): number {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO conv_messages (conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [conversationId, role, content ?? null, opts?.toolCallId ?? null, opts?.toolCalls ?? null,
     opts?.toolName ?? null, now, opts?.tokenCount ?? null],
  );
  // Update conversation counters
  const preview = content ? content.slice(0, 80) : null;
  db.run(
    `UPDATE conversations SET messageCount = messageCount + 1, updatedAt = ?, lastMessagePreview = ?, lastMessageRole = ? WHERE id = ?`,
    [now, preview, role, conversationId],
  );
  scheduleSave();
  // Return the inserted row ID
  const idResult = db.exec("SELECT last_insert_rowid()");
  const rowId = idResult.length ? (idResult[0].values[0][0] as number) : 0;

  // JSONL dual-write: append message and increment index counter
  try {
    getJsonlWriter().append(conversationId, {
      id: rowId, conversationId, role, content: content ?? null,
      toolCallId: opts?.toolCallId ?? null, toolCalls: opts?.toolCalls ?? null,
      toolName: opts?.toolName ?? null, timestamp: now, tokenCount: opts?.tokenCount ?? null,
    });
    getJsonlWriter().incrementMessageCount(conversationId);
  } catch { /* best-effort */ }

  return rowId;
}

/** Get messages for a conversation, with optional pagination */
export function getConvMessages(
  conversationId: string,
  opts?: { limit?: number; before?: number },
): ConvMessageRecord[] {
  const db = getDatabase();
  const limit = opts?.limit ?? 200;
  let sql = "SELECT id, conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount FROM conv_messages WHERE conversationId = ?";
  const params: unknown[] = [conversationId];
  if (opts?.before) {
    sql += " AND id < ?";
    params.push(opts.before);
  }
  sql += " ORDER BY id ASC";
  // For pagination: get the last N messages
  if (opts?.before) {
    // When paging backward, use a subquery to get the right slice
    sql = `SELECT * FROM (SELECT id, conversationId, role, content, toolCallId, toolCalls, toolName, timestamp, tokenCount FROM conv_messages WHERE conversationId = ? AND id < ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
    params.length = 0;
    params.push(conversationId, opts.before, limit);
  } else {
    sql += " LIMIT ?";
    params.push(limit);
  }
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
    // better-sqlite3 保证 TEXT 列返回 string | null，无需 Uint8Array 检查
    content: v[3] as string | null,
    toolCallId: v[4] as string | null,
    toolCalls: v[5] as string | null,
    toolName: v[6] as string | null,
    timestamp: v[7] as string,
    tokenCount: v[8] as number | null,
  }));
}

/** FTS5 search across conversation messages（better-sqlite3 原生支持 FTS5，直接 MATCH） */
export function searchConvMessages(
  query: string,
  opts?: { agentId?: string; limit?: number },
): Array<{ id: number; conversationId: string; role: string; snippet: string; timestamp: string }> {
  const db = getDatabase();
  const limit = opts?.limit ?? 30;

  let sql: string;
  // P0-A8: FTS5 查询注入防护
  const safeQuery = '"' + query.replace(/"/g, '""') + '"';
  const params: unknown[] = [safeQuery];
  if (opts?.agentId) {
    sql = `SELECT m.id, m.conversationId, m.role, snippet(conv_messages_fts, 0, '>>>', '<<<', '...', 40) AS snip, m.timestamp
           FROM conv_messages_fts
           JOIN conv_messages m ON m.id = conv_messages_fts.rowid
           JOIN conversations c ON c.id = m.conversationId
           WHERE conv_messages_fts MATCH ? AND c.agentId = ?
           ORDER BY rank LIMIT ?`;
    params.push(opts.agentId, limit);
  } else {
    sql = `SELECT m.id, m.conversationId, m.role, snippet(conv_messages_fts, 0, '>>>', '<<<', '...', 40) AS snip, m.timestamp
           FROM conv_messages_fts
           JOIN conv_messages m ON m.id = conv_messages_fts.rowid
           WHERE conv_messages_fts MATCH ?
           ORDER BY rank LIMIT ?`;
    params.push(limit);
  }
  const results = db.exec(sql, params);
  if (!results.length) return [];
  return results[0].values.map((v: unknown[]) => ({
    id: v[0] as number, conversationId: v[1] as string, role: v[2] as string,
    snippet: v[3] as string, timestamp: v[4] as string,
  }));
}
