/**
 * MCP Client — connects to Model Context Protocol servers.
 *
 * Supports three transport types:
 * - stdio: Launch a local process and communicate via stdin/stdout
 * - sse: Connect to an SSE endpoint
 * - streamable-http: Connect via HTTP streaming
 *
 * Uses @modelcontextprotocol/sdk when available, falls back to
 * manual JSON-RPC for basic functionality.
 */

import { spawn, ChildProcess } from "node:child_process";
import pino from "pino";
import { v4 as uuid } from "uuid";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { z } from "zod";

const logger = pino({ name: "mcp-client" });

export interface MCPAuthConfig {
  /** Authentication type */
  type: "bearer" | "api-key" | "basic";
  /** Bearer token (for type "bearer") */
  token?: string;
  /** API key value (for type "api-key") */
  apiKey?: string;
  /** Custom header name for API key (default: "X-API-Key") */
  headerName?: string;
  /** Username for basic auth */
  username?: string;
  /** Password for basic auth */
  password?: string;
}

export interface MCPServerConfig {
  id?: string;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  /** stdio mode: command to launch */
  command?: string;
  /** stdio mode: command arguments */
  args?: string[];
  /** sse/http mode: server URL */
  url?: string;
  /** Authentication configuration for SSE/HTTP transports */
  auth?: MCPAuthConfig;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Is this server enabled? */
  enabled?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Which MCP server provides this tool */
  serverName: string;
  serverId: string;
}

export type MCPServerStatus = "connected" | "disconnected" | "connecting" | "error";

/** Sanitize a name for use in tool identifiers (LLM-safe: a-z, 0-9, underscore only). */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase() || "unknown";
}

export class MCPClient {
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private tools: MCPTool[] = [];
  private _status: MCPServerStatus = "disconnected";
  private _error: string | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";
  /** Auto-reconnect state for stdio transport */
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  private readonly reconnectDelayMs = 2000;
  private reconnecting = false;
  /** Set to true during intentional disconnect to suppress auto-reconnect. */
  private intentionalDisconnect = false;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  get status(): MCPServerStatus {
    return this._status;
  }

  get error(): string | null {
    return this._error;
  }

  /** Connect to the MCP server */
  async connect(): Promise<void> {
    if (this._status === "connected") return;

    this.intentionalDisconnect = false; // Allow auto-reconnect for this new session
    this._status = "connecting";
    this._error = null;

    try {
      if (this.config.transport === "stdio") {
        await this.connectStdio();
      } else {
        // For SSE/HTTP, send initialize request if URL available
        if (this.config.url) {
          try {
            const authHeaders = this.buildAuthHeaders();
            const initResp = await fetch(`${this.config.url}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...authHeaders },
              signal: AbortSignal.timeout(15000),
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: { tools: {} },
                  clientInfo: { name: "super-agent", version: "0.1.0" },
                },
              }),
            });
            if (initResp.ok) {
              logger.info({ name: this.config.name }, "MCP HTTP/SSE server initialized");
            }
          } catch (initErr) {
            // Initialize is best-effort for HTTP/SSE — server may not require it
            logger.debug({ name: this.config.name, error: initErr }, "MCP HTTP/SSE initialize skipped");
          }
        }
        this._status = "connected";
        logger.info({ name: this.config.name, transport: this.config.transport }, "MCP server marked as connected (on-demand)");
        // HTTP/SSE 也需要发现工具，否则工具列表永远为空
        await this.listTools();
      }
    } catch (err) {
      this._status = "error";
      this._error = err instanceof Error ? err.message : String(err);
      logger.error({ name: this.config.name, error: this._error }, "MCP connection failed");
      throw err;
    }
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true; // Suppress auto-reconnect on process close
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.tools = [];
    this._status = "disconnected";
    this.pendingRequests.clear();
    logger.info({ name: this.config.name }, "MCP server disconnected");
  }

  /** List available tools from this MCP server */
  async listTools(): Promise<MCPTool[]> {
    if (this.config.transport === "stdio" && this.process) {
      try {
        const result = await this.sendRequest("tools/list", {});
        this.tools = (result.tools ?? []).map((t: any) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          serverName: this.config.name,
          serverId: this.config.id ?? this.config.name,
        }));
      } catch (err) {
        logger.error({ name: this.config.name, error: err }, "Failed to list MCP tools");
      }
    } else if (this.config.url && (this.config.transport === "sse" || this.config.transport === "streamable-http")) {
      // HTTP/SSE: send tools/list via JSON-RPC over HTTP
      try {
        const authHeaders = this.buildAuthHeaders();
        const response = await fetch(`${this.config.url}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method: "tools/list",
            params: {},
          }),
        });
        if (response.ok) {
          const msg = await response.json() as any;
          const result = msg.result ?? msg;
          this.tools = (result.tools ?? []).map((t: any) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            serverName: this.config.name,
            serverId: this.config.id ?? this.config.name,
          }));
          logger.info({ name: this.config.name, count: this.tools.length }, "MCP HTTP tools discovered");
        }
      } catch (err) {
        logger.error({ name: this.config.name, error: err }, "Failed to list MCP tools via HTTP");
      }
    }
    return this.tools;
  }

  /** Alias for listTools */
  async getTools(): Promise<MCPTool[]> {
    return this.listTools();
  }

  /** Call a tool on this MCP server */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (this.config.transport === "stdio" && this.process) {
        const result = await this.sendRequest("tools/call", { name, arguments: args });
        const content = result.content ?? [];
        const textParts = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        return {
          success: !result.isError,
          output: textParts.join("\n") || JSON.stringify(result),
          data: result,
        };
      }

      // For SSE/HTTP transports, make HTTP request with auth
      if (this.config.url) {
        const authHeaders = this.buildAuthHeaders();
        const response = await fetch(`${this.config.url}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        const msg = await response.json() as any;
        const result = msg.result ?? msg;
        const content = result.content ?? [];
        const textParts = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        return {
          success: response.ok && !result.isError,
          output: textParts.join("\n") || JSON.stringify(result),
          data: result,
        };
      }

      return { success: false, output: "MCP server not connected", error: "Not connected" };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, output: errMsg, error: errMsg };
    }
  }

  /** Convert MCP tools to unified ToolDefinition format */
  toToolDefinitions(): ToolDefinition[] {
    const safeName = sanitizeName(this.config.name);
    return this.tools.map((mcpTool) => ({
      name: `mcp_${safeName}_${sanitizeName(mcpTool.name)}`,
      description: `[MCP:${this.config.name}] ${mcpTool.description}`,
      parameters: z.object({}).passthrough(),
      // Preserve the real inputSchema from the MCP server so the LLM knows
      // which parameters to pass. buildToolDefinitions() in runtime.ts
      // uses this field directly instead of the empty Zod schema above.
      rawJsonSchema: mcpTool.inputSchema && Object.keys(mcpTool.inputSchema).length > 0
        ? mcpTool.inputSchema as Record<string, unknown>
        : { type: "object", properties: {} },
      execute: async (params: unknown): Promise<ToolResult> => {
        return this.callTool(mcpTool.name, (params as Record<string, unknown>) ?? {});
      },
    }));
  }

  /** Get tool names registered by this client (for cleanup on unregister). */
  getToolNames(): string[] {
    const safeName = sanitizeName(this.config.name);
    return this.tools.map((t) => `mcp_${safeName}_${sanitizeName(t.name)}`);
  }

  /** Get the raw MCP tools as discovered from the server (original names for REST API). */
  getRawTools(): MCPTool[] {
    return this.tools;
  }

  // ─── auth helpers ─────────────────────────────────────────

  /** Build authentication headers for HTTP/SSE requests */
  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const auth = this.config.auth;
    if (!auth) return headers;

    switch (auth.type) {
      case "bearer":
        if (auth.token) {
          headers["Authorization"] = `Bearer ${auth.token}`;
        }
        break;
      case "api-key":
        if (auth.apiKey) {
          const headerName = auth.headerName ?? "X-API-Key";
          headers[headerName] = auth.apiKey;
        }
        break;
      case "basic":
        if (auth.username) {
          const credentials = Buffer.from(`${auth.username}:${auth.password ?? ""}`).toString("base64");
          headers["Authorization"] = `Basic ${credentials}`;
        }
        break;
    }
    return headers;
  }

  // ─── stdio transport ───────────────────────────────────────

  private async connectStdio(): Promise<void> {
    if (!this.config.command) {
      throw new Error("stdio transport requires 'command'");
    }

    const env = { ...process.env, ...this.config.env };
    // Windows 上 npx/node/python 等是 .cmd 脚本，需要 shell 才能 spawn
    const isWin = process.platform === "win32";
    const command = isWin ? this.config.command : this.config.command;
    const args = this.config.args ?? [];
    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      // Windows: 使用 shell 以支持 .cmd 脚本，但不传 args 给 shell 以避免 DEP0190 警告
      ...(isWin ? { shell: true } : {}),
    });

    this.process.stdout!.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr!.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        logger.info({ name: this.config.name, stderr: text }, "MCP stderr");
      }
    });

    this.process.on("close", (code) => {
      // 不要用 disconnected 覆盖已有的 error 状态
      if (this._status !== "error") {
        this._status = "disconnected";
      }
      logger.info({ name: this.config.name, code }, "MCP process exited");
      // Auto-reconnect only if the process crashed unexpectedly
      // Skip if: intentional disconnect, already reconnecting, or clean exit
      if (code !== 0 && code !== null && !this.reconnecting && !this.intentionalDisconnect) {
        this.attemptReconnect();
      }
    });

    this.process.on("error", (err) => {
      this._status = "error";
      this._error = err.message;
    });

    // Initialize the MCP protocol
    // Use a longer timeout (60s) for initialize — npx may need to download packages first.
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "super-agent", version: "0.1.0" },
    }, 60000);

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});

    this._status = "connected";
    logger.info({ name: this.config.name, command: this.config.command }, "MCP stdio server connected");

    // Auto-discover tools
    await this.listTools();
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      // P0-A13: 修复双重 set—只在超时包装后 set 一次
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.process?.stdin?.write(message);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process?.stdin?.write(message);
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  // ─── auto-reconnect (stdio only) ─────────────────────────────

  /** Attempt to reconnect a crashed stdio process with exponential backoff. */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn(
        { name: this.config.name, attempts: this.reconnectAttempts },
        "MCP stdio server exceeded max reconnect attempts — giving up"
      );
      this._status = "error";
      this._error = "Process crashed and max reconnect attempts exceeded";
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * this.reconnectAttempts; // linear backoff
    logger.info(
      { name: this.config.name, attempt: this.reconnectAttempts, delayMs: delay },
      "Scheduling MCP stdio reconnect"
    );

    setTimeout(async () => {
      // Re-check: if user called disconnect() while we were waiting, abort
      if (this.intentionalDisconnect) {
        logger.info(
          { name: this.config.name },
          "Skipping MCP stdio reconnect — intentional disconnect during wait"
        );
        return;
      }

      try {
        this.reconnecting = true;
        // Clean up old state
        this.process = null;
        this.buffer = "";
        this.pendingRequests.clear();
        this.requestId = 0;

        await this.connectStdio();
        this.reconnectAttempts = 0; // reset on success
        logger.info({ name: this.config.name }, "MCP stdio server reconnected successfully");
      } catch (err) {
        logger.warn(
          { name: this.config.name, error: err instanceof Error ? err.message : String(err) },
          "MCP stdio reconnect attempt failed"
        );
        // The close event will trigger another attempt
      } finally {
        this.reconnecting = false;
      }
    }, delay);
  }
}
