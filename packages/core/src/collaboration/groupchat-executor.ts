/**
 * GroupChat Executor — AutoGen 风格群聊协商执行器。
 *
 * 从 orchestrator.ts 中提取，降低主文件的复杂度。
 * 负责多 Agent 群聊的轮次管理、发言者选择、终止条件检测。
 *
 * 依赖：
 *   - 类型从 orchestrator.ts 导入（接口/类型定义，编译时安全）
 *   - AgentManager / AgentRuntime 从 ../agent/ 导入
 */

import { v4 as uuid } from "uuid";
import { EventEmitter } from "eventemitter3";
import pino from "pino";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { Attachment } from "../types/index.js";
import type {
  CollabMessage,
  GroupChatConfig,
  GroupChatResult,
  TerminationCondition,
  GraphSpeakerConfig,
} from "./orchestrator.js";
import { withTimeout } from "./orchestrator.js";

const logger = pino({ name: "groupchat-executor" });

// ─── 附件辅助纯函数 ─────────────────────────────────────────

/** S-2 修复：按 path/url/filename 去重附件列表 */
export function deduplicateAttachments(attachments: Attachment[]): Attachment[] {
  const seen = new Set<string>();
  return attachments.filter(att => {
    const key = att.path ?? att.url ?? att.filename ?? "";
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── F-4: JSON 数组多级提取 ──────────────────────────────

/** 从 LLM 输出中提取 JSON 字符串数组 */
export function extractJsonArray(text: string): string[] | null {
  try {
    const arr = JSON.parse(text.trim());
    if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) return arr;
  } catch { /* continue */ }
  const matches = [...text.matchAll(/\[[\s\S]*?\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse(matches[i][0]);
      if (Array.isArray(arr) && arr.every((v) => typeof v === "string")) return arr;
    } catch { /* skip */ }
  }
  return null;
}

// ─── I-3: 可插拔终止条件实现 ───────────────────────────

export class MaxTurnsTermination implements TerminationCondition {
  constructor(private maxTurns: number) {}
  check(_messages: CollabMessage[], turn: number): { shouldTerminate: false } | { shouldTerminate: true; reason: string } {
    if (turn >= this.maxTurns) {
      return { shouldTerminate: true, reason: `Max turns (${this.maxTurns}) reached` };
    }
    return { shouldTerminate: false };
  }
  reset(): void {}
}

export class MaxTimeTermination implements TerminationCondition {
  constructor(private maxTimeMs: number) {}
  check(_messages: CollabMessage[], _turn: number, elapsedMs: number): { shouldTerminate: false } | { shouldTerminate: true; reason: string } {
    if (elapsedMs >= this.maxTimeMs) {
      return { shouldTerminate: true, reason: `Max time (${this.maxTimeMs}ms) exceeded` };
    }
    return { shouldTerminate: false };
  }
  reset(): void {}
}

export class KeywordTermination implements TerminationCondition {
  constructor(private keywords: string[]) {}
  check(messages: CollabMessage[]): { shouldTerminate: false } | { shouldTerminate: true; reason: string } {
    const last = messages.at(-1);
    if (last) {
      const matched = this.keywords.find((kw) => last.content.includes(kw));
      if (matched) {
        return { shouldTerminate: true, reason: `Keyword "${matched}" detected` };
      }
    }
    return { shouldTerminate: false };
  }
  reset(): void {}
}

export class LegacyCallbackTermination implements TerminationCondition {
  constructor(private callback: (messages: CollabMessage[]) => boolean) {}
  check(messages: CollabMessage[]): { shouldTerminate: false } | { shouldTerminate: true; reason: string } {
    if (this.callback(messages)) {
      return { shouldTerminate: true, reason: "Legacy callback condition met" };
    }
    return { shouldTerminate: false };
  }
  reset(): void {}
}

// ─── GroupChat Executor ──────────────────────────────────────

export class GroupChatExecutor extends EventEmitter {
  private agentManager: AgentManager;
  private speakerSuggestionCache = new Map<string, { queue: string[]; lastRefresh: number }>();

  constructor(agentManager: AgentManager) {
    super();
    this.agentManager = agentManager;
  }

  async run(config: GroupChatConfig, initialMessage: string, signal?: AbortSignal): Promise<GroupChatResult> {
    const chatId = config.id ?? `gchat_${uuid().slice(0, 8)}`;
    const startTime = Date.now();
    const messages: CollabMessage[] = [];
    const participants = this.resolveParticipants(config.participantIds);

    logger.info({ chatId, name: config.name, participants: participants.length, maxTurns: config.maxTurns },
      "GroupChat started");
    this.emit("groupchat:start", { chatId, name: config.name });

    if (config.systemMessage) {
      messages.push({
        id: uuid(), agentId: "system", agentName: "System",
        content: config.systemMessage, role: "system", timestamp: new Date(),
      });
    }

    messages.push({
      id: uuid(), agentId: "user", agentName: "User",
      content: initialMessage, role: "chat", timestamp: new Date(),
    });

    let turn = 0;
    let speakerIndex = 0;
    let status: GroupChatResult["status"] = "max_turns";

    const allConditions: TerminationCondition[] = [...(config.terminationConditions ?? [])];
    if (config.terminationKeyword) {
      allConditions.push(new KeywordTermination([config.terminationKeyword]));
    }
    if (config.terminationCondition) {
      allConditions.push(new LegacyCallbackTermination(config.terminationCondition));
    }

    try {
      while (turn < config.maxTurns) {
        if (signal?.aborted) {
          status = "cancelled";
          logger.info({ chatId, turn }, "GroupChat cancelled by user");
          break;
        }
        turn++;

        const speaker = await this.selectSpeaker(config, participants, messages, speakerIndex, turn, chatId);
        if (!speaker) { status = "error"; break; }

        const conversationContext = this.buildConversationContext(config, messages, speaker);
        const sessionId = `gchat_${chatId}_${speaker.id}`;
        const turnTimeoutMs = config.turnTimeoutMs ?? 3_600_000;
        const maxRetry = config.maxRetryPerTurn ?? 1;
        let response: string | undefined;
        let turnAttachments: Attachment[] | undefined;
        let lastTurnError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetry; attempt++) {
          try {
            const result = await withTimeout(
              speaker.chat(conversationContext, sessionId),
              turnTimeoutMs, `GroupChat turn ${turn}`,
            );
            response = result.response;
            turnAttachments = result.attachments;
            lastTurnError = null;
            break;
          } catch (err: any) {
            lastTurnError = err;
            if (attempt < maxRetry) {
              logger.warn({ chatId, turn, attempt, error: err.message }, "Turn failed, retrying");
            }
          }
        }

        if (lastTurnError || !response) {
          messages.push({
            id: uuid(), agentId: speaker.id, agentName: speaker.state.config.name,
            content: `[Error: ${lastTurnError?.message ?? "No response"}]`,
            role: "system", timestamp: new Date(),
          });
          if (config.speakerSelection === "auto") {
            this.invalidateSpeakerCache(config.id ?? chatId, speaker.id);
          }
          speakerIndex = (participants.indexOf(speaker) + 1) % participants.length;
          continue;
        }

        const msg: CollabMessage = {
          id: uuid(), agentId: speaker.id, agentName: speaker.state.config.name,
          content: response, role: "chat", timestamp: new Date(),
          attachments: turnAttachments?.length ? turnAttachments : undefined,
        };
        messages.push(msg);
        this.emit("groupchat:message", { chatId, message: msg, turn });

        const elapsedMs = Date.now() - startTime;
        for (const cond of allConditions) {
          const termResult = cond.check(messages, turn, elapsedMs);
          if (termResult.shouldTerminate) {
            status = "terminated";
            logger.info({ chatId, turn, reason: termResult.reason }, "GroupChat terminated by condition");
            break;
          }
        }
        if (status === "terminated") break;

        speakerIndex = (participants.indexOf(speaker) + 1) % participants.length;
      }

      if (turn >= config.maxTurns && status === "max_turns") {
        logger.info({ chatId, turn }, "GroupChat reached max turns");
      }

      const chatAttachments = deduplicateAttachments(messages.flatMap(m => m.attachments ?? []));
      const result: GroupChatResult = {
        type: "groupchat", chatId, name: config.name, status, messages,
        turns: turn, totalDurationMs: Date.now() - startTime,
        summary: messages.length > 0 ? messages[messages.length - 1].content : "",
        allAttachments: chatAttachments.length ? chatAttachments : undefined,
      };

      this.emit("groupchat:complete", result);
      return result;
    } catch (err: any) {
      const isCancelled = signal?.aborted === true;
      return {
        type: "groupchat", chatId, name: config.name,
        status: isCancelled ? "cancelled" : "error", messages,
        turns: turn, totalDurationMs: Date.now() - startTime, error: err.message,
      };
    } finally {
      this.lastSpeakerByChat.delete(config.id ?? chatId);
      this.speakerSuggestionCache.delete(config.id ?? chatId);
    }
  }

  private resolveParticipants(ids: string[]): AgentRuntime[] {
    return ids.map((id) => {
      const agent = this.agentManager.getAgent(id);
      if (!agent) throw new Error(`Participant agent '${id}' not found`);
      return agent;
    });
  }

  private async selectSpeaker(
    config: GroupChatConfig, participants: AgentRuntime[], messages: CollabMessage[],
    currentIndex: number, turn?: number, chatId?: string,
  ): Promise<AgentRuntime | null> {
    switch (config.speakerSelection) {
      case "round_robin": return participants[currentIndex % participants.length];
      case "random": return participants[Math.floor(Math.random() * participants.length)];
      case "auto": return this.autoSelectSpeaker(config, participants, messages, turn ?? 0, chatId ?? "default");
      case "manual": {
        if (!config.manualSpeakerOrder?.length) return participants[currentIndex % participants.length];
        const idx = ((turn ?? 1) - 1) % config.manualSpeakerOrder.length;
        return participants.find((p) => p.id === config.manualSpeakerOrder![idx]) ?? participants[0];
      }
      case "graph": {
        const gc = config.graphConfig;
        if (!gc) return participants[0];
        if (turn === 1 || messages.length <= 1) {
          return participants.find((p) => p.id === gc.startAgent) ?? participants[0];
        }
        const lastMsg = [...messages].reverse().find(
          (m) => m.role === "chat" && m.agentId !== "user" && m.agentId !== "system"
        );
        const lastSpeakerId = lastMsg?.agentId;
        if (!lastSpeakerId) return participants.find((p) => p.id === gc.startAgent) ?? participants[0];
        const successors = gc.transitions[lastSpeakerId] ?? [];
        if (successors.length === 0) {
          logger.info({ chatId, lastSpeakerId }, "I-4 graph: No successors, using round_robin fallback");
          return participants[currentIndex % participants.length];
        }
        if (successors.length === 1) {
          return participants.find((p) => p.id === successors[0]) ?? participants[0];
        }
        return this.graphSelectFromCandidates(config, participants, messages, successors, chatId ?? "default");
      }
      case "handoff": {
        if (messages.length <= 1) return participants[currentIndex % participants.length];
        const lastChatMsg = [...messages].reverse().find(
          (m) => m.role === "chat" && m.agentId !== "user" && m.agentId !== "system"
        );
        if (lastChatMsg) {
          const match = lastChatMsg.content.match(/\[HANDOFF:([^\]]+)\]/);
          if (match) {
            const target = match[1].trim();
            const nextSpeaker = participants.find(
              (p) => p.id === target || p.state.config.name === target
            );
            if (nextSpeaker) {
              logger.debug({ chatId, from: lastChatMsg.agentId, to: nextSpeaker.id }, "I-4 handoff: Agent handoff");
              return nextSpeaker;
            }
            logger.warn({ chatId, target }, "I-4 handoff: Target not found, fallback to round_robin");
          }
        }
        return participants[currentIndex % participants.length];
      }
      default: return participants[0];
    }
  }

  private lastSpeakerByChat = new Map<string, string | null>();

  private async autoSelectSpeaker(
    config: GroupChatConfig, participants: AgentRuntime[], messages: CollabMessage[],
    turn: number, chatId: string,
  ): Promise<AgentRuntime | null> {
    const chatKey = config.id ?? chatId;
    const moderatorId = config.moderatorAgentId ?? config.participantIds[0];
    const moderator = this.agentManager.getAgent(moderatorId);
    if (!moderator) return participants[0];

    const cached = this.speakerSuggestionCache.get(chatKey);
    const cacheExpired = !cached || cached.queue.length === 0 || (turn - cached.lastRefresh > 5);
    let selectedId: string | undefined;

    if (!cacheExpired && cached!.queue.length > 0) {
      selectedId = cached!.queue.shift();
      logger.debug({ chatKey, turn, selectedId, remaining: cached!.queue.length }, "Speaker from cache");
    } else {
      const participantList = participants
        .map((p) => `- ${p.state.config.name} (${p.id}): ${p.state.config.description ?? p.state.config.role ?? "agent"}`)
        .join("\n");
      const recentMessages = messages.slice(-10)
        .map((m) => `[${m.agentName}]: ${m.content.slice(0, 200)}`)
        .join("\n");
      const selectionPrompt = `You are selecting the next speakers in a group conversation.

Participants:
${participantList}

Recent conversation:
${recentMessages}

Based on the conversation flow, who should speak next? Respond with a JSON array of the next 3 speaker names (exact agent names), in order. Example: ["Agent A", "Agent B", "Agent C"]
Only output the JSON array, nothing else.`;

      try {
        const { response } = await withTimeout(
          moderator.chat(selectionPrompt, `speaker_select_${chatKey}`), 30_000, "Speaker selection",
        );
        const suggestions = extractJsonArray(response);
        if (suggestions && suggestions.length > 0) {
          const resolvedIds = suggestions
            .map((name) => {
              const norm = name.trim().toLowerCase();
              const match = participants.find(
                (p) => p.state.config.name.toLowerCase() === norm || p.id.toLowerCase() === norm
              );
              return match?.id;
            })
            .filter((id): id is string => id !== undefined);
          if (resolvedIds.length > 0) {
            selectedId = resolvedIds.shift();
            this.speakerSuggestionCache.set(chatKey, { queue: resolvedIds, lastRefresh: turn });
            logger.debug({ chatKey, turn, selectedId, cached: resolvedIds.length }, "Speaker from LLM (cached rest)");
          }
        }
      } catch (err) {
        logger.warn({ chatKey, error: err }, "Speaker selection LLM call failed, using fallback");
      }
      if (!selectedId) {
        selectedId = participants[0]?.id;
        this.speakerSuggestionCache.delete(chatKey);
      }
    }

    let match = participants.find((p) => p.id === selectedId);
    const lastSpeakerId = this.lastSpeakerByChat.get(chatKey) ?? null;
    if (match && lastSpeakerId === match.id && participants.length > 2) {
      const others = participants.filter((p) => p.id !== match!.id);
      match = others[Math.floor(Math.random() * others.length)];
    }
    const selected = match ?? participants[0];
    this.lastSpeakerByChat.set(chatKey, selected.id);
    return selected;
  }

  invalidateSpeakerCache(chatKey: string, agentId: string): void {
    const cached = this.speakerSuggestionCache.get(chatKey);
    if (cached) cached.queue = cached.queue.filter((id) => id !== agentId);
  }

  private async graphSelectFromCandidates(
    config: GroupChatConfig, participants: AgentRuntime[], messages: CollabMessage[],
    candidateIds: string[], chatId: string,
  ): Promise<AgentRuntime | null> {
    const moderatorId = config.moderatorAgentId ?? config.participantIds[0];
    const moderator = this.agentManager.getAgent(moderatorId);
    if (!moderator) return participants.find((p) => candidateIds.includes(p.id)) ?? participants[0];

    const candidateList = candidateIds
      .map((id) => { const p = participants.find((a) => a.id === id); return p ? `- ${p.state.config.name} (${p.id})` : null; })
      .filter(Boolean).join("\n");
    const recentMessages = messages.slice(-5)
      .map((m) => `[${m.agentName}]: ${m.content.slice(0, 150)}`).join("\n");
    const prompt = `Based on the conversation, select the next speaker from these candidates:
${candidateList}

Recent conversation:
${recentMessages}

Respond with the exact agent name only.`;

    try {
      const { response } = await withTimeout(
        moderator.chat(prompt, `graph_select_${chatId}`), 15_000, "Graph speaker selection",
      );
      const norm = response.trim().toLowerCase();
      return participants.find(
        (p) => candidateIds.includes(p.id) && (p.state.config.name.toLowerCase() === norm || p.id.toLowerCase() === norm)
      ) ?? participants.find((p) => candidateIds.includes(p.id)) ?? participants[0];
    } catch {
      return participants.find((p) => candidateIds.includes(p.id)) ?? participants[0];
    }
  }

  private buildConversationContext(
    config: GroupChatConfig, messages: CollabMessage[], speaker: AgentRuntime,
  ): string {
    const windowSize = config.contextWindowSize ?? 20;
    const recentMessages = messages.slice(-windowSize)
      .map((m) => { const prefix = m.agentId === speaker.id ? "[You]" : `[${m.agentName}]`; return `${prefix}: ${m.content}`; })
      .join("\n\n");
    const otherParticipants = config.participantIds
      .filter((id) => id !== speaker.id)
      .map((id) => { const agent = this.agentManager.getAgent(id); return agent ? agent.state.config.name : id; })
      .join(", ");
    return `You are participating in a group conversation "${config.name}".
Other participants: ${otherParticipants}

Conversation so far:
${recentMessages}

Please contribute your perspective. Be concise and relevant.${
      config.terminationKeyword
        ? `\n\nWhen the group has reached consensus or the task is complete, include "${config.terminationKeyword}" in your response.`
        : ""
    }`;
  }
}
