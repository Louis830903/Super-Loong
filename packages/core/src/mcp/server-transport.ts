/**
 * MCP Server 传输层 — stdio / SSE / Streamable HTTP
 *
 * 为 MCPServer 提供三种传输方式的适配实现。
 * 每种传输方式独立，按需启用。
 *
 * - stdio：CLI 集成（IDE 直接调用）
 * - SSE：Web 场景（Server-Sent Events）
 * - Streamable HTTP：MCP 最新标准
 */

import pino from "pino";
import type { MCPServer } from "./server.js";

const logger = pino({ name: "mcp-server-transport" });

// ═══════════════════════════════════════════════════════════════
// 传输层接口
// ═══════════════════════════════════════════════════════════════

/** 传输层抽象接口 */
export interface MCPTransport {
  /** 传输类型 */
  readonly type: "stdio" | "sse" | "streamable-http";
  /** 启动传输 */
  start(): Promise<void>;
  /** 停止传输 */
  stop(): Promise<void>;
  /** 是否运行中 */
  isRunning(): boolean;
}

// ═══════════════════════════════════════════════════════════════
// stdio 传输（JSON-RPC over stdin/stdout）
// ═══════════════════════════════════════════════════════════════

/**
 * stdio 传输 — 通过标准输入/输出通信。
 *
 * 适用于 IDE 集成场景（如 VS Code 扩展直接 spawn 进程）。
 * 每行一个 JSON-RPC 消息。
 */
export class StdioTransport implements MCPTransport {
  readonly type = "stdio" as const;
  private running = false;
  private buffer = "";

  constructor(private server: MCPServer) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.processBuffer();
    });

    process.stdin.on("end", () => {
      this.running = false;
    });

    // 发送 server capabilities
    this.send({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        serverInfo: this.server.getInfo(),
        capabilities: {
          tools: { listChanged: true },
        },
      },
    });

    logger.info("stdio 传输已启动");
  }

  async stop(): Promise<void> {
    this.running = false;
    process.stdin.removeAllListeners("data");
    logger.info("stdio 传输已停止");
  }

  isRunning(): boolean {
    return this.running;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        this.handleMessage(message).catch(err => {
          logger.error({ err }, "处理 stdio 消息失败");
        });
      } catch {
        logger.warn({ line: trimmed.slice(0, 100) }, "无效 JSON 消息");
      }
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.method === "tools/list") {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: this.server.getToolDefinitions() },
      });
    } else if (msg.method === "tools/call") {
      const result = await this.server.handleToolCall(
        msg.params.name,
        msg.params.arguments ?? {},
      );
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        result,
      });
    } else if (msg.method === "ping") {
      this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      this.send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
    }
  }

  private send(data: unknown): void {
    process.stdout.write(JSON.stringify(data) + "\n");
  }
}

// ═══════════════════════════════════════════════════════════════
// SSE 传输（Server-Sent Events）
// ═══════════════════════════════════════════════════════════════

/**
 * SSE 传输配置（需要外部 HTTP 框架支持）。
 *
 * 这里提供路由处理器工厂，由 Fastify 路由集成。
 */
export interface SSEHandlerConfig {
  /** MCP Server 实例 */
  server: MCPServer;
  /** 路由前缀（默认 /mcp） */
  prefix?: string;
}

/**
 * 创建 SSE 传输的路由处理器。
 *
 * 返回一组可注册到 Fastify 的路由处理器：
 * - GET {prefix}/sse — SSE 事件流
 * - POST {prefix}/message — 接收客户端消息
 */
export function createSSEHandlers(config: SSEHandlerConfig) {
  const { server } = config;

  return {
    /**
     * SSE 事件流处理器。
     * 客户端通过此端点接收事件通知。
     */
    async handleSSE(request: any, reply: any): Promise<void> {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // 发送初始连接消息
      reply.raw.write(`data: ${JSON.stringify({
        type: "connection",
        serverInfo: server.getInfo(),
      })}\n\n`);

      // 通过 EventBridge 推送事件
      const clientId = `sse-${Date.now()}`;
      const bridge = server.getEventBridge();
      let running = true;

      const pump = async () => {
        while (running) {
          try {
            const events = await bridge.wait(clientId, undefined, 30_000);
            for (const event of events) {
              reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          } catch {
            running = false;
          }
        }
      };

      request.raw.on("close", () => { running = false; });
      pump().catch(() => { /* 连接关闭 */ });
    },

    /**
     * 消息接收处理器。
     * 客户端通过此端点发送 JSON-RPC 请求。
     */
    async handleMessage(request: any, reply: any): Promise<unknown> {
      const msg = request.body;

      if (msg.method === "tools/list") {
        return { jsonrpc: "2.0", id: msg.id, result: { tools: server.getToolDefinitions() } };
      }

      if (msg.method === "tools/call") {
        const result = await server.handleToolCall(
          msg.params.name,
          msg.params.arguments ?? {},
        );
        return { jsonrpc: "2.0", id: msg.id, result };
      }

      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
    },
  };
}

/**
 * 根据配置创建合适的传输层实例。
 */
export function createTransport(
  server: MCPServer,
  type: "stdio" | "sse" | "streamable-http",
): MCPTransport | null {
  switch (type) {
    case "stdio":
      return new StdioTransport(server);
    case "sse":
    case "streamable-http":
      // SSE 和 Streamable HTTP 通过 Fastify 路由集成，不返回独立传输
      logger.info({ type }, "SSE/HTTP 传输通过路由集成，无需独立传输层");
      return null;
    default:
      logger.warn({ type }, "未知传输类型");
      return null;
  }
}
