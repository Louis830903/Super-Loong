/**
 * JSONL Writer — append-only conversation transcript files.
 *
 * Design follows:
 * - OpenClaw: sessions/{sessionId}.jsonl — one JSON object per line
 * - Hermes:   sessions/ + sessions.json index file
 *
 * This is a **supplementary** layer to SQLite — it does NOT replace the database.
 * Benefits:
 * - Each message is an independent line → crash loses at most one message
 * - Human-readable: `grep`, `tail -f`, `jq` all work natively
 * - Easy export/import (standard JSONL format)
 *
 * The sessions.json index enables fast listing without querying SQLite.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";
import { paths } from "../config/paths.js";

const logger = pino({ name: "jsonl-writer" });

// ─── Types ──────────────────────────────────────────────────

/** Minimal message record for JSONL serialization */
export interface JsonlMessage {
  id?: number;
  conversationId: string;
  role: string;
  content: string | null;
  toolCallId?: string | null;
  toolCalls?: string | null;
  toolName?: string | null;
  timestamp: string;
  tokenCount?: number | null;
}

/** Session index entry (stored in sessions.json) */
export interface SessionIndexEntry {
  title: string | null;
  agentId: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  jsonlFile: string;
}

/** Full sessions.json structure */
interface SessionIndex {
  version: number;
  sessions: Record<string, SessionIndexEntry>;
}

// ─── JsonlWriter Class ─────────────────────────────────────

export class JsonlWriter {
  private indexCache: SessionIndex | null = null;
  private indexDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Debounce delay for flushing index to disk (ms) */
  private static readonly INDEX_FLUSH_DELAY_MS = 2000;

  /**
   * Append a message to the conversation's JSONL file.
   * Creates the file if it doesn't exist.
   */
  append(conversationId: string, message: JsonlMessage): void {
    try {
      const filePath = this.resolveJsonlPath(conversationId);
      const line = JSON.stringify(message) + "\n";
      fs.appendFileSync(filePath, line, "utf-8");
    } catch (err) {
      logger.warn({ conversationId, err }, "Failed to append JSONL message");
    }
  }

  /**
   * Read all messages from a conversation's JSONL file.
   * Returns empty array if file doesn't exist or is corrupted.
   */
  readAll(conversationId: string): JsonlMessage[] {
    try {
      const filePath = this.resolveJsonlPath(conversationId);
      if (!fs.existsSync(filePath)) return [];

      const content = fs.readFileSync(filePath, "utf-8");
      const messages: JsonlMessage[] = [];

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed) as JsonlMessage);
        } catch {
          // Skip corrupted lines (append-only format — partial writes are ok)
          logger.debug({ conversationId }, "Skipped corrupted JSONL line");
        }
      }

      return messages;
    } catch (err) {
      logger.warn({ conversationId, err }, "Failed to read JSONL file");
      return [];
    }
  }

  /**
   * Update the session index entry for a conversation.
   * Debounced — batches rapid updates into a single disk write.
   */
  updateIndex(
    conversationId: string,
    entry: Partial<SessionIndexEntry> & { agentId: string },
  ): void {
    const index = this.loadIndex();
    const existing = index.sessions[conversationId];
    const now = new Date().toISOString();

    index.sessions[conversationId] = {
      title: entry.title ?? existing?.title ?? null,
      agentId: entry.agentId,
      model: entry.model ?? existing?.model ?? null,
      createdAt: existing?.createdAt ?? entry.createdAt ?? now,
      updatedAt: now,
      messageCount: entry.messageCount ?? (existing?.messageCount ?? 0),
      jsonlFile: `${conversationId}.jsonl`,
    };

    this.indexDirty = true;
    this.scheduleSaveIndex();
  }

  /**
   * Increment the message count in the index for a conversation.
   */
  incrementMessageCount(conversationId: string): void {
    const index = this.loadIndex();
    const entry = index.sessions[conversationId];
    if (entry) {
      entry.messageCount++;
      entry.updatedAt = new Date().toISOString();
      this.indexDirty = true;
      this.scheduleSaveIndex();
    }
  }

  /**
   * Remove a conversation's JSONL file and index entry.
   */
  remove(conversationId: string): void {
    // Remove JSONL file
    try {
      const filePath = this.resolveJsonlPath(conversationId);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.warn({ conversationId, err }, "Failed to delete JSONL file");
    }

    // Remove from index
    const index = this.loadIndex();
    if (index.sessions[conversationId]) {
      delete index.sessions[conversationId];
      this.indexDirty = true;
      this.scheduleSaveIndex();
    }
  }

  /**
   * Get all session index entries (fast — no DB query needed).
   */
  listSessions(): Record<string, SessionIndexEntry> {
    return { ...this.loadIndex().sessions };
  }

  /**
   * Flush pending index writes immediately (call on shutdown).
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.indexDirty) {
      this.saveIndex();
    }
  }

  // ─── Private Helpers ──────────────────────────────────────

  private resolveJsonlPath(conversationId: string): string {
    return path.join(paths.sessions(), `${conversationId}.jsonl`);
  }

  private resolveIndexPath(): string {
    return path.join(paths.sessions(), "sessions.json");
  }

  private loadIndex(): SessionIndex {
    if (this.indexCache) return this.indexCache;

    const indexPath = this.resolveIndexPath();
    try {
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, "utf-8");
        this.indexCache = JSON.parse(raw) as SessionIndex;
        return this.indexCache;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to load sessions.json, starting fresh");
    }

    this.indexCache = { version: 1, sessions: {} };
    return this.indexCache;
  }

  private saveIndex(): void {
    if (!this.indexCache) return;
    try {
      const indexPath = this.resolveIndexPath();
      fs.writeFileSync(indexPath, JSON.stringify(this.indexCache, null, 2), "utf-8");
      this.indexDirty = false;
    } catch (err) {
      logger.warn({ err }, "Failed to save sessions.json");
    }
  }

  private scheduleSaveIndex(): void {
    if (this.flushTimer) return; // already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.indexDirty) {
        this.saveIndex();
      }
    }, JsonlWriter.INDEX_FLUSH_DELAY_MS);
  }
}

// ─── Singleton ──────────────────────────────────────────────

let _instance: JsonlWriter | null = null;

/** Get the global JsonlWriter singleton. */
export function getJsonlWriter(): JsonlWriter {
  if (!_instance) {
    _instance = new JsonlWriter();
  }
  return _instance;
}
