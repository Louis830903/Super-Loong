/**
 * MCP Registry — manages multiple MCP server connections.
 *
 * Provides:
 * - Server registration and lifecycle management
 * - Unified tool discovery across all connected servers
 * - Conversion of MCP tools to Super Agent ToolDefinition format
 * - Persistence via sqlite persistence layer
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { MCPClient } from "./client.js";
import type { MCPServerConfig, MCPTool, MCPServerStatus } from "./client.js";
import type { ToolDefinition } from "../types/index.js";
import { saveMCPServer, loadMCPServers, deleteMCPServer as deleteMCPServerDB } from "../persistence/sqlite.js";

const logger = pino({ name: "mcp-registry" });

export interface MCPServerInfo {
  id: string;
  config: MCPServerConfig;
  status: MCPServerStatus;
  tools: MCPTool[];
  error?: string;
  connectedAt?: Date;
}

export class MCPRegistry {
  private clients = new Map<string, MCPClient>();
  private configs = new Map<string, MCPServerConfig>();
  private connectedAt = new Map<string, Date>();

  /** Load persisted server configs and connect enabled ones (parallel, with timeout). */
  async loadFromDB(): Promise<void> {
    try {
      const servers = loadMCPServers();
      const connectPromises: Promise<void>[] = [];

      for (const server of servers) {
        const config: MCPServerConfig = {
          id: server.id as string,
          name: server.name as string,
          transport: server.transport as MCPServerConfig["transport"],
          command: server.command as string | undefined,
          args: server.args as string[] | undefined,
          url: server.url as string | undefined,
          env: server.env as Record<string, string> | undefined,
          enabled: server.enabled as boolean,
          // B-5: 恢复持久化的 auth 配置
          auth: server.auth as MCPServerConfig["auth"] | undefined,
        };
        this.configs.set(config.id!, config);
        if (config.enabled !== false) {
          // Connect in parallel with a per-server timeout (20s)
          const connectWithTimeout = Promise.race([
            this.connectServer(config.id!),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Connection timeout (20s)")), 20000)
            ),
          ]).catch((err) => {
            logger.warn({ id: config.id, name: config.name, error: err.message }, "Failed to auto-connect MCP server");
          });
          connectPromises.push(connectWithTimeout);
        }
      }

      // Wait for all connections to settle (none will reject thanks to .catch above)
      await Promise.allSettled(connectPromises);
      logger.info({ count: servers.length }, "MCP servers loaded from database (parallel)");
    } catch (err) {
      logger.warn("Failed to load MCP servers from database (might be first run)");
    }
  }

  /** Register a new MCP server (synchronous — registers config only, does NOT auto-connect) */
  registerServer(config: MCPServerConfig): string {
    const id = config.id ?? uuid();
    const fullConfig = { ...config, id, enabled: config.enabled ?? true };
    this.configs.set(id, fullConfig);

    // Persist to database (sql.js is synchronous)
    try {
      saveMCPServer({
        id,
        name: config.name,
        transport: config.transport,
        command: config.command,
        args: config.args ?? [],
        url: config.url,
        env: config.env ?? {},
        enabled: fullConfig.enabled,
        auth: config.auth,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // DB might not be initialized in tests
    }

    logger.info({ id, name: config.name }, "MCP server registered");
    return id;
  }

  /** Connect to a registered MCP server (async — call separately after registerServer) */
  async connectRegistered(id: string): Promise<void> {
    return this.connectServer(id);
  }

  /** Connect to a registered MCP server */
  private async connectServer(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) throw new Error(`MCP server ${id} not found`);

    const client = new MCPClient(config);
    // 先存入 map，即使连接失败也能暴露 error 信息给前端
    this.clients.set(id, client);
    try {
      await client.connect();
      this.connectedAt.set(id, new Date());
    } catch (err) {
      // client 内部已设置 status='error' 和 _error，保留在 map 中
      // 不删除 client，让 listServers() 能读取到错误详情
      throw err;
    }
  }

  /** Reconnect a disconnected/error server */
  async reconnectServer(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) throw new Error(`MCP server ${id} not found`);
    // 先断开旧连接（如有）
    const oldClient = this.clients.get(id);
    if (oldClient) {
      await oldClient.disconnect().catch(() => {});
      this.clients.delete(id);
    }
    // 重新连接
    return this.connectServer(id);
  }

  /** List all registered servers with status info */
  listServers(): MCPServerInfo[] {
    const result: MCPServerInfo[] = [];
    for (const [id, config] of this.configs) {
      const client = this.clients.get(id);
      result.push({
        id,
        config,
        status: client?.status ?? "disconnected",
        tools: client?.getRawTools() ?? [],
        error: client?.error ?? undefined,
        connectedAt: this.connectedAt.get(id),
      });
    }
    return result;
  }

  /** Get a single server by ID */
  getServer(id: string): MCPServerInfo | undefined {
    const config = this.configs.get(id);
    if (!config) return undefined;
    const client = this.clients.get(id);
    return {
      id,
      config,
      status: client?.status ?? "disconnected",
      tools: client?.getRawTools() ?? [],
      error: client?.error ?? undefined,
      connectedAt: this.connectedAt.get(id),
    };
  }

  /** Unregister a server (synchronous). Returns the list of tool names that were removed. */
  unregisterServer(id: string): string[] {
    if (!this.configs.has(id)) return [];
    const client = this.clients.get(id);
    const removedToolNames: string[] = client ? client.getToolNames() : [];
    if (client) {
      client.disconnect().catch(() => {});
      this.clients.delete(id);
    }
    this.configs.delete(id);
    this.connectedAt.delete(id);
    try { deleteMCPServerDB(id); } catch {}
    logger.info({ id, removedTools: removedToolNames.length }, "MCP server unregistered");
    return removedToolNames;
  }

  /** Remove an MCP server (async — disconnects first). @deprecated Use unregisterServer */
  async removeServer(id: string): Promise<string[]> {
    return this.unregisterServer(id);
  }

  /** Get all tools from all connected MCP servers as unified ToolDefinition */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const client of this.clients.values()) {
      tools.push(...client.toToolDefinitions());
    }
    return tools;
  }

  /** Get all MCP tools (raw format — original MCP names for REST API use) */
  getAllMCPTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const [id, client] of this.clients) {
      const serverName = this.configs.get(id)?.name ?? id;
      for (const t of client.getRawTools()) {
        tools.push({
          ...t,
          serverName,
          serverId: id,
        });
      }
    }
    return tools;
  }

  /** Call a tool on a specific MCP server */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<any> {
    const client = this.clients.get(serverId);
    if (!client) throw new Error(`MCP server ${serverId} not connected`);
    return client.callTool(toolName, args);
  }

  /** Get status of all registered servers. @deprecated Use listServers */
  getServerStatus(): MCPServerInfo[] {
    return this.listServers();
  }

  /** Disconnect all servers */
  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect().catch(() => {});
    }
    this.clients.clear();
    this.connectedAt.clear();
  }
}
