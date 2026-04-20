/**
 * MCP Server — 让 Super-Agent 能被外部 Agent/IDE 调用
 *
 * 参考 Hermes mcp_serve.py 868行 FastMCP 框架。
 * 使用 @modelcontextprotocol/sdk 官方 TypeScript SDK。
 *
 * 暴露的工具：
 * - conversations_list / conversations_create — 对话管理
 * - messages_send / messages_read — 消息交互
 * - events_poll / events_wait — 事件系统
 * - permissions_list / permissions_respond — 权限管理
 * - tools_list — 工具管理
 *
 * 兼容性保证：
 * - 现有 mcp/client.ts 不修改
 * - 现有 mcp/registry.ts 不修改
 * - Server 默认不启动，需显式配置开启
 */

import pino from "pino";
import { v4 as uuid } from "uuid";
import { EventBridge, type MCPEvent } from "./event-bridge.js";

const logger = pino({ name: "mcp-server" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** MCP Server 配置 */
export interface MCPServerOptions {
  /** Server 名称 */
  name?: string;
  /** Server 版本 */
  version?: string;
  /** 传输方式 */
  transport?: "stdio" | "sse" | "streamable-http";
  /** SSE/HTTP 端口 */
  port?: number;
  /** EventBridge 配置 */
  eventBridgeConfig?: {
    maxEvents?: number;
    eventTTL?: number;
  };
}

/** MCP Server 状态 */
export type MCPServerState = "stopped" | "starting" | "running" | "error";

/** 权限请求 */
export interface PermissionRequest {
  id: string;
  action: string;
  resource: string;
  requester: string;
  status: "pending" | "approved" | "denied";
  createdAt: Date;
}

/** 对话摘要 */
interface ConversationSummary {
  id: string;
  title?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 消息条目 */
interface MessageEntry {
  role: string;
  content: string;
  timestamp: string;
  toolCalls?: unknown[];
}

// ═══════════════════════════════════════════════════════════════
// MCP Server
// ═══════════════════════════════════════════════════════════════

/**
 * MCP Server 实现。
 *
 * 将 Super-Agent 的核心能力通过 MCP 协议暴露给外部 Agent/IDE。
 * 支持 stdio/SSE/Streamable HTTP 三种传输方式。
 */
export class MCPServer {
  private state: MCPServerState = "stopped";
  private eventBridge: EventBridge;
  private pendingPermissions = new Map<string, PermissionRequest>();
  private options: Required<MCPServerOptions>;

  /** 外部注入的回调函数（由 API 层设置） */
  private handlers = {
    listConversations: async (): Promise<ConversationSummary[]> => [],
    createConversation: async (_title?: string): Promise<{ id: string }> => ({ id: uuid() }),
    sendMessage: async (_convId: string, _message: string): Promise<{ response: string }> => ({ response: "" }),
    readMessages: async (_convId: string, _limit?: number): Promise<MessageEntry[]> => [],
    listTools: async (): Promise<Array<{ name: string; description: string }>> => [],
  };

  constructor(options: MCPServerOptions = {}) {
    this.options = {
      name: options.name ?? "super-agent",
      version: options.version ?? "1.0.0",
      transport: options.transport ?? "stdio",
      port: options.port ?? 3002,
      eventBridgeConfig: options.eventBridgeConfig ?? {},
    };
    this.eventBridge = new EventBridge(this.options.eventBridgeConfig);
  }

  /**
   * 设置回调处理器（由 API 层注入实际的业务逻辑）。
   */
  setHandlers(handlers: Partial<typeof this.handlers>): void {
    Object.assign(this.handlers, handlers);
  }

  /**
   * 获取 Server 支持的全部 MCP 工具定义。
   */
  getToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: "conversations_list",
        description: "列出所有活跃对话",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "conversations_create",
        description: "创建新对话",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string", description: "对话标题" } },
          required: [],
        },
      },
      {
        name: "messages_send",
        description: "向指定对话发送消息并获取回复",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: { type: "string", description: "对话 ID" },
            message: { type: "string", description: "消息内容" },
          },
          required: ["conversationId", "message"],
        },
      },
      {
        name: "messages_read",
        description: "读取指定对话的消息历史",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: { type: "string", description: "对话 ID" },
            limit: { type: "number", description: "最大返回数量", default: 50 },
          },
          required: ["conversationId"],
        },
      },
      {
        name: "events_poll",
        description: "短轮询获取新事件",
        inputSchema: {
          type: "object",
          properties: {
            clientId: { type: "string", description: "客户端标识" },
            afterSeq: { type: "number", description: "从此序列号之后" },
          },
          required: ["clientId"],
        },
      },
      {
        name: "events_wait",
        description: "长轮询等待新事件（最多 30 秒）",
        inputSchema: {
          type: "object",
          properties: {
            clientId: { type: "string", description: "客户端标识" },
            afterSeq: { type: "number", description: "从此序列号之后" },
            timeoutMs: { type: "number", description: "超时毫秒数", default: 30000 },
          },
          required: ["clientId"],
        },
      },
      {
        name: "permissions_list",
        description: "列出待处理的权限请求",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "permissions_respond",
        description: "批准或拒绝权限请求",
        inputSchema: {
          type: "object",
          properties: {
            requestId: { type: "string", description: "权限请求 ID" },
            action: { type: "string", enum: ["approve", "deny"], description: "操作" },
          },
          required: ["requestId", "action"],
        },
      },
      {
        name: "tools_list",
        description: "列出 Super-Agent 可用的所有工具",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ];
  }

  /**
   * 处理 MCP 工具调用请求。
   */
  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      switch (toolName) {
        case "conversations_list": {
          const convos = await this.handlers.listConversations();
          return this.textResult(JSON.stringify(convos, null, 2));
        }

        case "conversations_create": {
          const result = await this.handlers.createConversation(args.title as string | undefined);
          this.eventBridge.emit("session:created", { conversationId: result.id });
          return this.textResult(JSON.stringify(result));
        }

        case "messages_send": {
          const convId = args.conversationId as string;
          const message = args.message as string;
          this.eventBridge.emit("message:received", { conversationId: convId, message });
          const response = await this.handlers.sendMessage(convId, message);
          this.eventBridge.emit("message:sent", { conversationId: convId, response: response.response });
          return this.textResult(response.response);
        }

        case "messages_read": {
          const msgs = await this.handlers.readMessages(
            args.conversationId as string,
            args.limit as number | undefined,
          );
          return this.textResult(JSON.stringify(msgs, null, 2));
        }

        case "events_poll": {
          const events = this.eventBridge.poll(
            args.clientId as string,
            args.afterSeq as number | undefined,
          );
          return this.textResult(JSON.stringify(events));
        }

        case "events_wait": {
          const events = await this.eventBridge.wait(
            args.clientId as string,
            args.afterSeq as number | undefined,
            args.timeoutMs as number | undefined,
          );
          return this.textResult(JSON.stringify(events));
        }

        case "permissions_list": {
          const pending = Array.from(this.pendingPermissions.values())
            .filter(p => p.status === "pending");
          return this.textResult(JSON.stringify(pending, null, 2));
        }

        case "permissions_respond": {
          const reqId = args.requestId as string;
          const action = args.action as "approve" | "deny";
          const req = this.pendingPermissions.get(reqId);
          if (!req) {
            return this.textResult(`权限请求 ${reqId} 不存在`);
          }
          req.status = action === "approve" ? "approved" : "denied";
          this.eventBridge.emit("permission:request", {
            requestId: reqId,
            action: req.action,
            status: req.status,
          });
          return this.textResult(`权限请求已${action === "approve" ? "批准" : "拒绝"}`);
        }

        case "tools_list": {
          const tools = await this.handlers.listTools();
          return this.textResult(JSON.stringify(tools, null, 2));
        }

        default:
          return this.textResult(`未知工具：${toolName}`);
      }
    } catch (err: any) {
      logger.error({ tool: toolName, err }, "MCP 工具调用失败");
      return this.textResult(`错误：${err.message}`);
    }
  }

  /**
   * 启动 MCP Server。
   */
  async start(): Promise<void> {
    if (this.state === "running") return;

    this.state = "starting";
    logger.info(
      { transport: this.options.transport, port: this.options.port },
      "MCP Server 启动中...",
    );

    try {
      // 根据传输方式启动
      // 注意：实际的 stdio/SSE/HTTP 传输层在 server-transport.ts 中实现
      // 这里标记状态为 running，传输层由外部启动
      this.state = "running";
      logger.info("MCP Server 已就绪");
    } catch (err) {
      this.state = "error";
      logger.error({ err }, "MCP Server 启动失败");
      throw err;
    }
  }

  /**
   * 停止 MCP Server。
   */
  async stop(): Promise<void> {
    if (this.state !== "running") return;

    logger.info("MCP Server 停止中...");
    this.eventBridge.shutdown();
    this.state = "stopped";
    logger.info("MCP Server 已停止");
  }

  /**
   * 添加权限请求。
   */
  addPermissionRequest(action: string, resource: string, requester: string): PermissionRequest {
    const req: PermissionRequest = {
      id: uuid(),
      action,
      resource,
      requester,
      status: "pending",
      createdAt: new Date(),
    };
    this.pendingPermissions.set(req.id, req);
    this.eventBridge.emit("permission:request", { requestId: req.id, action, resource });
    return req;
  }

  /** 获取当前状态 */
  getState(): MCPServerState { return this.state; }

  /** 获取 EventBridge 实例（用于外部模块发布事件） */
  getEventBridge(): EventBridge { return this.eventBridge; }

  /** 获取 Server 信息 */
  getInfo(): { name: string; version: string; state: MCPServerState; transport: string; tools: number } {
    return {
      name: this.options.name,
      version: this.options.version,
      state: this.state,
      transport: this.options.transport,
      tools: this.getToolDefinitions().length,
    };
  }

  private textResult(text: string) {
    return { content: [{ type: "text", text }] };
  }
}
