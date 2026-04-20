/**
 * MCP Module — Model Context Protocol integration.
 */

export { MCPClient } from "./client.js";
export type { MCPServerConfig, MCPTool, MCPServerStatus, MCPAuthConfig } from "./client.js";
export { MCPRegistry } from "./registry.js";
export type { MCPServerInfo } from "./registry.js";
export { MCPMarketplace } from "./marketplace.js";
export type { MCPMarketEntry, MCPInstallConfig, MCPRegistryPackage } from "./marketplace.js";

// MCP Server 模式
export { MCPServer } from "./server.js";
export type { MCPServerOptions, MCPServerState, PermissionRequest } from "./server.js";
export { EventBridge } from "./event-bridge.js";
export type { MCPEvent, MCPEventType, EventBridgeConfig } from "./event-bridge.js";
export { StdioTransport, createSSEHandlers, createTransport } from "./server-transport.js";
export type { MCPTransport, SSEHandlerConfig } from "./server-transport.js";
