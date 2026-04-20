/**
 * MCP Protocol — Tests.
 *
 * Covers: MCPRegistry structure, MCPClient interface.
 * Note: Actual MCP server connections require external processes, so we test structure only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { MCPRegistry, MCPClient, type MCPServerConfig, type MCPTool } from "../mcp/index.js";
import { initDatabase, closeDatabase } from "../persistence/sqlite.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test-mcp.db");

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  await initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe("MCPRegistry", () => {
  it("should create registry instance", () => {
    const registry = new MCPRegistry();
    expect(registry).toBeDefined();
  });

  it("should register a server config", () => {
    const registry = new MCPRegistry();
    const config: MCPServerConfig = {
      id: "test-server",
      name: "Test Server",
      transport: "stdio",
      command: "echo",
      args: ["hello"],
      enabled: true,
    };

    registry.registerServer(config);
    const servers = registry.listServers();
    expect(servers.length).toBe(1);
    expect(servers[0].config.name).toBe("Test Server");
  });

  it("should unregister a server", () => {
    const registry = new MCPRegistry();
    registry.registerServer({
      id: "to-remove",
      name: "Remove Me",
      transport: "stdio",
      command: "test",
      enabled: true,
    });

    const removed = registry.unregisterServer("to-remove");
    expect(Array.isArray(removed)).toBe(true);
    expect(registry.listServers().length).toBe(0);
    const removedAgain = registry.unregisterServer("no-such");
    expect(removedAgain).toEqual([]);
  });

  it("should get server by id", () => {
    const registry = new MCPRegistry();
    registry.registerServer({
      id: "lookup",
      name: "Lookup Server",
      transport: "stdio",
      command: "cmd",
      enabled: true,
    });

    const info = registry.getServer("lookup");
    expect(info).toBeDefined();
    expect(info!.config.name).toBe("Lookup Server");
  });

  it("should handle multiple servers", () => {
    const registry = new MCPRegistry();
    for (let i = 0; i < 5; i++) {
      registry.registerServer({
        id: `srv-${i}`,
        name: `Server ${i}`,
        transport: "stdio",
        command: "cmd",
        enabled: i % 2 === 0,
      });
    }
    expect(registry.listServers().length).toBe(5);
  });
});

describe("MCPClient", () => {
  it("should create client instance", () => {
    const client = new MCPClient({
      id: "test",
      name: "Test Client",
      transport: "stdio",
      command: "echo",
      enabled: true,
    });
    expect(client).toBeDefined();
  });

  it("should have connect/disconnect/callTool/getTools methods", () => {
    const client = new MCPClient({
      id: "test",
      name: "Test",
      transport: "stdio",
      command: "echo",
      enabled: true,
    });
    expect(typeof client.connect).toBe("function");
    expect(typeof client.disconnect).toBe("function");
    expect(typeof client.callTool).toBe("function");
    expect(typeof client.getTools).toBe("function");
  });
});
