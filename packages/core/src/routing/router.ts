/**
 * Message Router — routes inbound messages to the correct agent.
 *
 * Supports routing by:
 * - Channel binding (channel → specific agent)
 * - Session key (platform:chatId → agent)
 * - Default agent fallback
 *
 * References:
 * - OpenClaw src/agents/resolve-route.ts
 * - Hermes gateway/session.py (build_session_key)
 */

import pino from "pino";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { InboundMessage } from "../types/index.js";

const logger = pino({ name: "router" });

export interface RouteBinding {
  channelId: string;
  agentId: string;
  /** Optional chat ID filter — if set, only messages from this chat route here. */
  chatId?: string;
}

export class MessageRouter {
  private bindings: RouteBinding[] = [];
  private defaultAgentId: string | null = null;

  constructor(private agentManager: AgentManager) {}

  /** Set the default agent for unmatched messages. */
  setDefaultAgent(agentId: string): void {
    this.defaultAgentId = agentId;
  }

  /** Add a channel → agent binding. */
  addBinding(binding: RouteBinding): void {
    this.bindings.push(binding);
  }

  /** Remove a binding. */
  removeBinding(channelId: string, agentId: string): void {
    this.bindings = this.bindings.filter(
      (b) => !(b.channelId === channelId && b.agentId === agentId)
    );
  }

  /** Clear all bindings. */
  clearBindings(): void {
    this.bindings = [];
  }

  /** List all bindings. */
  listBindings(): RouteBinding[] {
    return [...this.bindings];
  }

  /**
   * Resolve which agent should handle an inbound message.
   *
   * Priority:
   * 1. Exact match: channelId + chatId
   * 2. Channel match: channelId only
   * 3. Default agent
   */
  resolve(message: InboundMessage): AgentRuntime | null {
    // 1. Exact channel+chat binding
    const exact = this.bindings.find(
      (b) => b.channelId === message.channelId && b.chatId === message.chatId
    );
    if (exact) {
      const agent = this.agentManager.getAgent(exact.agentId);
      if (agent) return agent;
    }

    // 2. Channel-level binding
    const channelMatch = this.bindings.find(
      (b) => b.channelId === message.channelId && !b.chatId
    );
    if (channelMatch) {
      const agent = this.agentManager.getAgent(channelMatch.agentId);
      if (agent) return agent;
    }

    // 3. Default agent
    if (this.defaultAgentId) {
      return this.agentManager.getAgent(this.defaultAgentId) ?? null;
    }

    logger.warn(
      { channelId: message.channelId, chatId: message.chatId },
      "No agent found for message"
    );
    return null;
  }

  /**
   * Build a session key from an inbound message.
   * Format: platform:chatId[:threadId]
   */
  static buildSessionKey(message: InboundMessage): string {
    const parts = [message.platform, message.chatId];
    if (message.threadId) parts.push(message.threadId);
    return parts.join(":");
  }
}
