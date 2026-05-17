/**
 * mcp.test.ts — MCP 工具链路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/mcp/servers                  — 列出已注册 MCP 服务器
 *   POST   /api/mcp/servers                  — 注册新 MCP 服务器
 *   POST   /api/mcp/servers/:id/reconnect    — 重连断开服务器
 *   DELETE /api/mcp/servers/:id              — 移除 MCP 服务器
 *   GET    /api/mcp/tools                    — 列出所有 MCP 工具
 *   POST   /api/mcp/tools/call               — 调用 MCP 工具
 *   GET    /api/mcp/marketplace/search        — 搜索 MCP 商城
 *   POST   /api/mcp/marketplace/install       — 从商城安装
 *
 * Mock 策略:
 *   - ctx.mcpRegistry: MockMCPRegistry（getServerStatus/registerServer/removeServer 等）
 *   - ctx.mcpMarketplace: MockMCPMarketplace（search/buildInstallConfig）
 *   - ctx.agentManager: registerGlobalTool / unregisterGlobalTool
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mcpRoutes } from "../routes/mcp.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// ─── Mock MCP Registry ──────────────────────────────────────

class MockMCPRegistry {
  private servers = new Map<string, any>();
  private nextId = 1;

  getServerStatus() {
    return Array.from(this.servers.values()).map((s) => ({
      id: s.id,
      name: s.config.name,
      transport: s.config.transport,
      status: s.status,
      toolCount: s.tools?.length ?? 0,
    }));
  }

  registerServer(config: any) {
    const id = `mcp-${this.nextId++}`;
    const server = {
      id,
      config: { ...config, name: config.name || `server-${id}` },
      status: "registered",
      tools: [],
    };
    this.servers.set(id, server);
    return id;
  }

  async connectRegistered(_id: string) {
    const s = this.servers.get(_id);
    if (s) {
      s.status = "connected";
      s.tools = [{ name: "mock_tool", description: "A mock tool" }];
    }
  }

  async reconnectServer(id: string) {
    const s = this.servers.get(id);
    if (!s) throw new Error("Server not found");
    s.status = "connected";
  }

  getServer(id: string) {
    return this.servers.get(id);
  }

  async removeServer(id: string) {
    const s = this.servers.get(id);
    if (!s) throw new Error("Server not found");
    const names = (s.tools ?? []).map((t: any) => t.name);
    this.servers.delete(id);
    return names;
  }

  getAllTools() {
    const tools: any[] = [];
    for (const s of this.servers.values()) {
      if (s.tools) tools.push(...s.tools);
    }
    return tools;
  }

  getAllMCPTools() {
    return this.getAllTools().map((t: any) => ({
      ...t,
      serverId: Array.from(this.servers.values()).find((s) =>
        s.tools?.some((st: any) => st.name === t.name),
      )?.id ?? "unknown",
    }));
  }

  async callTool(serverId: string, toolName: string, _args: any) {
    const s = this.servers.get(serverId);
    if (!s) throw new Error("Server not found");
    return { serverId, toolName, output: "mock output" };
  }

  listServers() {
    return Array.from(this.servers.values());
  }
}

// ─── Mock MCP Marketplace ───────────────────────────────────

class MockMCPMarketplace {
  async search(query: string, _limit: number) {
    return [
      {
        name: `${query}-server`,
        displayName: `${query} MCP Server`,
        description: `A mock server for ${query}`,
        packages: [
          { registryType: "npm", identifier: `@scope/${query}-server` },
        ],
      },
    ];
  }

  buildInstallConfig(entry: any) {
    return {
      name: entry.name || entry.displayName,
      transport: "stdio" as const,
      command: "npx",
      args: ["-y", entry.packages?.[0]?.identifier ?? "mock-server"],
      env: {},
    };
  }
}

// ─── 测试套件 ────────────────────────────────────────────────

describe("MCP 工具链路由", () => {
  let registry: MockMCPRegistry;
  let marketplace: MockMCPMarketplace;
  let agentManager: { registerGlobalTool: any; unregisterGlobalTool: any };
  let ctx: AppContext;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new MockMCPRegistry();
    marketplace = new MockMCPMarketplace();
    agentManager = {
      registerGlobalTool: vi.fn(),
      unregisterGlobalTool: vi.fn(),
    };
    ctx = {
      mcpRegistry: registry as any,
      mcpMarketplace: marketplace as any,
      agentManager: agentManager as any,
    } as unknown as AppContext;
  });

  // ── GET /api/mcp/servers ─────────────────────────────────

  it("GET /api/mcp/servers 空列表", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.servers).toEqual([]);
  });

  it("GET /api/mcp/servers 注册后返回服务器列表", async () => {
    registry.registerServer({ name: "test-server", transport: "stdio", command: "node" });
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.servers).toHaveLength(1);
    expect(body.data.servers[0].name).toBe("test-server");
  });

  // ── POST /api/mcp/servers ───────────────────────────────

  it("POST /api/mcp/servers 注册 stdio 服务器成功", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "my-server", transport: "stdio", command: "node", args: ["server.js"] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("my-server");
    expect(body.data.status).toBe("registered");
  });

  it("POST /api/mcp/servers 缺 name 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { transport: "stdio", command: "node" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/mcp/servers 缺 transport 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "my-server", command: "node" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/mcp/servers stdio 缺 command 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "my-server", transport: "stdio" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/mcp/servers 非白名单命令返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "bad-server", transport: "stdio", command: "rm" },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("not in the allowed list");
  });

  it("POST /api/mcp/servers SSE 传输缺 url 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "sse-server", transport: "sse" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── POST /api/mcp/servers/:id/reconnect ─────────────────

  it("POST /api/mcp/servers/:id/reconnect 重连成功", async () => {
    const id = registry.registerServer({ name: "to-reconnect", transport: "stdio", command: "npx" });
    // 先标记为 error 状态
    const s = registry.getServer(id);
    s.status = "error";

    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/reconnect`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("connected");
  });

  it("POST /api/mcp/servers/:id/reconnect 不存在的服务器返回 200（含 error）", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/servers/nonexistent/reconnect",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 连接失败但仍返回 200 + error 字段（不阻塞）
    expect(body.data.status).toBe("error");
  });

  // ── DELETE /api/mcp/servers/:id ─────────────────────────

  it("DELETE /api/mcp/servers/:id 删除成功并清理工具", async () => {
    const id = registry.registerServer({ name: "to-delete", transport: "stdio", command: "npx" });
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({ method: "DELETE", url: `/api/mcp/servers/${id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("removed");
    // 确认服务器已从注册表移除
    expect(registry.listServers()).toHaveLength(0);
  });

  it("DELETE /api/mcp/servers/:id 不存在返回 404", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({ method: "DELETE", url: "/api/mcp/servers/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /api/mcp/tools ──────────────────────────────────

  it("GET /api/mcp/tools 空工具列表", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/mcp/tools" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tools).toEqual([]);
  });

  it("GET /api/mcp/tools 注册服务器后返回工具", async () => {
    const id = registry.registerServer({ name: "tooled", transport: "stdio", command: "npx" });
    await registry.connectRegistered(id);
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/mcp/tools" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tools).toHaveLength(1);
    expect(body.data.tools[0].name).toBe("mock_tool");
  });

  // ── POST /api/mcp/tools/call ────────────────────────────

  it("POST /api/mcp/tools/call 调用工具成功", async () => {
    const id = registry.registerServer({ name: "callee", transport: "stdio", command: "node" });
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/call",
      payload: { serverId: id, toolName: "mock_tool", args: { key: "value" } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.result.output).toBe("mock output");
  });

  it("POST /api/mcp/tools/call 缺 serverId 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/call",
      payload: { toolName: "some_tool" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/mcp/tools/call 缺 toolName 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/call",
      payload: { serverId: "mcp-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/mcp/tools/call 不存在服务器返回 500", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/call",
      payload: { serverId: "nonexistent", toolName: "fake_tool" },
    });
    expect(res.statusCode).toBe(500);
  });

  // ── GET /api/mcp/marketplace/search ────────────────────

  it("GET /api/mcp/marketplace/search 返回搜索结果", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/marketplace/search?q=filesystem",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.servers).toHaveLength(1);
    expect(body.data.servers[0].name).toBe("filesystem-server");
  });

  it("GET /api/mcp/marketplace/search 缺 q 参数返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/marketplace/search",
    });
    expect(res.statusCode).toBe(400);
  });

  // ── POST /api/mcp/marketplace/install ──────────────────

  it("POST /api/mcp/marketplace/install 安装成功返回 201", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/marketplace/install",
      payload: {
        entry: {
          name: "filesystem",
          displayName: "Filesystem MCP",
          packages: [{ registryType: "npm", identifier: "@modelcontextprotocol/server-filesystem" }],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.name).toBe("filesystem");
    expect(body.data.status).toBe("connected");
  });

  it("POST /api/mcp/marketplace/install 缺 entry.packages 返回 400", async () => {
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/marketplace/install",
      payload: { entry: { name: "no-packages" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/mcp/marketplace/install 重复安装返回 409", async () => {
    // 先注册同名服务器
    registry.registerServer({ name: "filesystem", transport: "stdio", command: "npx" });
    const app = await buildApp(mcpRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp/marketplace/install",
      payload: {
        entry: {
          name: "filesystem",
          displayName: "Filesystem MCP",
          packages: [{ registryType: "npm", identifier: "@modelcontextprotocol/server-filesystem" }],
        },
      },
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain("已存在");
  });
});
