/**
 * MCP Routes — Model Context Protocol server management.
 *
 * GET    /api/mcp/servers                  — List registered MCP servers
 * POST   /api/mcp/servers                  — Register a new MCP server
 * POST   /api/mcp/servers/:id/reconnect    — Reconnect a disconnected server
 * DELETE /api/mcp/servers/:id              — Remove an MCP server
 * GET    /api/mcp/tools                    — List all MCP tools
 * POST   /api/mcp/tools/call               — Call an MCP tool
 * GET    /api/mcp/marketplace/search        — Search MCP marketplace
 * POST   /api/mcp/marketplace/install       — Install from marketplace
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export async function mcpRoutes(app: FastifyInstance, ctx: AppContext) {
  if (!ctx.mcpRegistry) {
    app.log.warn("MCP Registry not available, MCP routes disabled");
    return;
  }

  const registry = ctx.mcpRegistry;

  // P0-A2: MCP 命令白名单（参考 OpenClaw isSafeExecutableValue 模式）
  // 只允许已知安全的执行器命令，防止注册任意可执行文件
  const MCP_COMMAND_WHITELIST = new Set([
    "node", "npx", "python", "python3", "pip", "uvx",
    "docker", "deno", "bun", "bunx",
  ]);

  /** 检查命令是否在白名单内（支持绝对路径） */
  function isSafeCommand(command: string): boolean {
    const basename = command.replace(/\\/g, "/").split("/").pop() ?? command;
    // 移除 .exe/.cmd/.bat 后缀后比对
    const normalized = basename.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    return MCP_COMMAND_WHITELIST.has(normalized);
  }

  /** List all registered MCP servers */
  app.get("/api/mcp/servers", async () => {
    return { servers: registry.getServerStatus() };
  });

  /** Register a new MCP server */
  app.post<{
    Body: {
      name: string;
      transport: "stdio" | "sse" | "streamable-http";
      command?: string;
      args?: string[];
      url?: string;
      env?: Record<string, string>;
    };
  }>("/api/mcp/servers", async (request, reply) => {
    const { name, transport, command, args, url, env } = request.body ?? {};
    if (!name || !transport) {
      return reply.status(400).send({ error: "name and transport are required" });
    }
    if (transport === "stdio" && !command) {
      return reply.status(400).send({ error: "command is required for stdio transport" });
    }
    // P0-A2: 命令白名单校验，阻止注册任意可执行文件
    if (transport === "stdio" && command && !isSafeCommand(command)) {
      return reply.status(400).send({
        error: `Command '${command}' is not in the allowed list. ` +
          `Allowed: ${[...MCP_COMMAND_WHITELIST].join(", ")}`,
      });
    }
    if ((transport === "sse" || transport === "streamable-http") && !url) {
      return reply.status(400).send({ error: "url is required for sse/http transport" });
    }

    try {
      const id = registry.registerServer({ name, transport, command, args, url, env });

      // Try to connect (non-blocking — server is still registered on failure)
      try {
        await registry.connectRegistered(id);
      } catch (connErr: any) {
        app.log.warn({ id, error: connErr.message }, "MCP server registered but failed to connect");
      }

      // Register MCP tools as global tools for agents
      const mcpTools = registry.getAllTools();
      for (const tool of mcpTools) {
        ctx.agentManager.registerGlobalTool(tool);
      }

      return reply.status(201).send({ id, name, status: "registered" });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  /** Reconnect a disconnected/error MCP server */
  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/reconnect", async (request, reply) => {
    try {
      await registry.reconnectServer(request.params.id);
      // 重连成功后重新注册全局工具
      const mcpTools = registry.getAllTools();
      for (const tool of mcpTools) {
        ctx.agentManager.registerGlobalTool(tool);
      }
      const server = registry.getServer(request.params.id);
      return { status: "connected", tools: server?.tools?.length ?? 0 };
    } catch (err: any) {
      // 返回 200 + error 字段（服务器仍然已注册，只是连接失败）
      const server = registry.getServer(request.params.id);
      return { status: server?.status ?? "error", error: err.message };
    }
  });

  /** Remove an MCP server */
  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id", async (request, reply) => {
    try {
      const removedToolNames = await registry.removeServer(request.params.id);
      // Clean up global tools that belonged to this server
      for (const toolName of removedToolNames) {
        ctx.agentManager.unregisterGlobalTool(toolName);
      }
      return { status: "removed", removedTools: removedToolNames.length };
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  /** List all tools from all MCP servers */
  app.get("/api/mcp/tools", async () => {
    return { tools: registry.getAllMCPTools() };
  });

  /** Call an MCP tool directly */
  app.post<{
    Body: { serverId: string; toolName: string; args?: Record<string, unknown> };
  }>("/api/mcp/tools/call", async (request, reply) => {
    const { serverId, toolName, args } = request.body ?? {};
    if (!serverId || !toolName) {
      return reply.status(400).send({ error: "serverId and toolName are required" });
    }
    try {
      const result = await registry.callTool(serverId, toolName, args ?? {});
      return { result };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ─── Marketplace Endpoints ─────────────────────────────────

  /** Search MCP marketplace (official MCP Registry) */
  app.get<{
    Querystring: { q?: string; limit?: string };
  }>("/api/mcp/marketplace/search", async (request, reply) => {
    const query = request.query.q;
    if (!query) {
      return reply.status(400).send({ error: "query parameter 'q' is required" });
    }
    const limit = Math.min(parseInt(request.query.limit ?? "20", 10) || 20, 50);

    try {
      const results = await ctx.mcpMarketplace.search(query, limit);
      return { servers: results, count: results.length };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  /** Install an MCP server from marketplace search result */
  app.post<{
    Body: {
      entry: {
        name: string;
        displayName: string;
        packages: Array<{
          registryType: string;
          identifier: string;
          version?: string;
          transport: { type: string };
          environmentVariables?: Array<{
            name: string;
            description?: string;
            isRequired?: boolean;
            isSecret?: boolean;
          }>;
        }>;
        envVars?: Array<{
          name: string;
          description?: string;
          isRequired?: boolean;
          isSecret?: boolean;
        }>;
      };
      env?: Record<string, string>;
    };
  }>("/api/mcp/marketplace/install", async (request, reply) => {
    const { entry, env } = request.body ?? {};
    if (!entry?.packages?.length) {
      return reply
        .status(400)
        .send({ error: "entry with packages is required" });
    }

    try {
      const config = ctx.mcpMarketplace.buildInstallConfig(entry as any);
      if (!config) {
        return reply
          .status(400)
          .send({ error: "No installable package found (need npm or docker package)" });
      }

      // Merge user-provided environment variables
      if (env) {
        config.env = { ...config.env, ...env };
      }

      // 重复检查：相同名称的服务器已存在时，直接返回提示
      const existing = registry.listServers().find(
        (s) => s.config.name === config.name
      );
      if (existing) {
        return reply.status(409).send({
          error: `服务器 "${config.name}" 已存在 (ID: ${existing.id})，请先删除后重试`,
          existingId: existing.id,
        });
      }

      const id = registry.registerServer({
        name: config.name,
        transport: config.transport,
        command: config.command,
        args: config.args,
        url: config.url,
        env: config.env,
      });

      // Try to connect (non-blocking)
      let connectError: string | undefined;
      try {
        await registry.connectRegistered(id);
        // Register newly discovered tools
        const mcpTools = registry.getAllTools();
        for (const tool of mcpTools) {
          ctx.agentManager.registerGlobalTool(tool);
        }
      } catch (connErr: any) {
        connectError = connErr.message;
        app.log.warn(
          { id, error: connErr.message },
          "MCP server installed but connection failed"
        );
      }

      return reply.status(201).send({
        id,
        name: config.name,
        transport: config.transport,
        command: config.command,
        args: config.args,
        status: connectError ? "registered" : "connected",
        connectError,
      });
    } catch (err: any) {
      app.log.error({ error: err.message }, "MCP marketplace install failed");
      return reply.status(500).send({ error: err.message });
    }
  });

  app.log.info("MCP routes registered (including marketplace)");

  // ═══════════════════════════════════════════════════════════════
  // MCP Server 模式路由（让 Super-Agent 能被外部 Agent/IDE 调用）
  // 现有 MCP Client 路由完全不变，以下为增量追加
  // ═══════════════════════════════════════════════════════════════

  // MCP Server 单例（懒初始化）
  let _mcpServer: any = null;

  const getMCPServer = async () => {
    if (_mcpServer) return _mcpServer;
    try {
      // 动态导入 MCPServer（避免构建前类型检查报错）
      const coreMod = await import("@super-agent/core") as any;
      const MCPServerClass = coreMod.MCPServer;
      if (!MCPServerClass) {
        throw new Error("MCPServer 未导出，请先构建 core 包");
      }
      _mcpServer = new MCPServerClass({
        name: "super-agent-server",
        version: "1.0.0",
        transport: "sse",
      });

      // 注入实际的业务处理器
      _mcpServer.setHandlers({
        listConversations: async () => {
          try {
            const core = await import("@super-agent/core") as any;
            const conversations = core.listConversations?.("default") ?? [];
            return conversations.map((c: any) => ({
              id: c.id,
              title: c.title,
              messageCount: c.message_count ?? 0,
              createdAt: c.created_at,
              updatedAt: c.updated_at,
            }));
          } catch { return []; }
        },
        listTools: async () => {
          try {
            const core = await import("@super-agent/core") as any;
            const tools = await core.getAllBuiltinTools();
            return (tools ?? []).map((t: any) => ({ name: t.name, description: t.description }));
          } catch { return []; }
        },
      });

      return _mcpServer;
    } catch (err: any) {
      app.log.error({ error: err.message }, "MCP Server 初始化失败");
      throw err;
    }
  };

  // POST /api/mcp/server/start — 启动 MCP Server
  app.post("/api/mcp/server/start", async (_request, reply) => {
    try {
      const server = await getMCPServer();
      await server.start();
      return reply.send({ status: "running", info: server.getInfo() });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/mcp/server/stop — 停止 MCP Server
  app.post("/api/mcp/server/stop", async (_request, reply) => {
    try {
      if (_mcpServer) {
        await _mcpServer.stop();
      }
      return reply.send({ status: "stopped" });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // GET /api/mcp/server/status — 查询 Server 状态
  app.get("/api/mcp/server/status", async (_request, reply) => {
    if (!_mcpServer) {
      return reply.send({ state: "stopped", info: null });
    }
    return reply.send({
      state: _mcpServer.getState(),
      info: _mcpServer.getInfo(),
      events: _mcpServer.getEventBridge().getStats(),
    });
  });

  // GET /api/mcp/server/tools — 列出 Server 暴露的工具
  app.get("/api/mcp/server/tools", async (_request, reply) => {
    try {
      const server = await getMCPServer();
      return reply.send({ tools: server.getToolDefinitions() });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/mcp/server/call — 调用 Server 工具
  app.post("/api/mcp/server/call", async (request, reply) => {
    const { toolName, arguments: args } = request.body as {
      toolName: string;
      arguments?: Record<string, unknown>;
    };
    try {
      const server = await getMCPServer();
      const result = await server.handleToolCall(toolName, args ?? {});
      return reply.send(result);
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  app.log.info("MCP Server routes registered");
}
