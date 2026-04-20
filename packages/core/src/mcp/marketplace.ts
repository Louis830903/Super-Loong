/**
 * MCP Marketplace — search and install MCP servers from the official MCP Registry.
 *
 * Data source: https://registry.modelcontextprotocol.io (Official MCP Registry v0.1)
 * API docs: https://github.com/modelcontextprotocol/registry
 */

import pino from "pino";
import { v4 as uuid } from "uuid";
import type { MCPServerConfig } from "./client.js";

const logger = pino({ name: "mcp-marketplace" });

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";

// ─── Types ──────────────────────────────────────────────────

export interface MCPRegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  transport: { type: string };
  environmentVariables?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    format?: string;
  }>;
}

export interface MCPRegistryServer {
  name: string;
  description?: string;
  version?: string;
  repository?: { url?: string; source?: string };
  packages?: MCPRegistryPackage[];
}

export interface MCPRegistryMeta {
  "io.modelcontextprotocol.registry/official"?: {
    status?: string;
    publishedAt?: string;
    updatedAt?: string;
    isLatest?: boolean;
  };
}

/** Normalized marketplace entry for frontend display */
export interface MCPMarketEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  repository?: string;
  isOfficial: boolean;
  publishedAt?: string;
  updatedAt?: string;
  packages: MCPRegistryPackage[];
  npmPackage?: string;
  dockerImage?: string;
  transportType: string;
  envVars: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

/** Config object ready to be passed to MCPRegistry.registerServer() */
export interface MCPInstallConfig {
  name: string;
  transport: MCPServerConfig["transport"];
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// ─── MCPMarketplace Class ───────────────────────────────────

export class MCPMarketplace {
  private baseUrl: string;

  constructor(baseUrl = REGISTRY_BASE) {
    this.baseUrl = baseUrl;
  }

  /**
   * Search the official MCP Registry for servers matching the query.
   * Uses substring match on server names.
   */
  async search(query: string, limit = 20): Promise<MCPMarketEntry[]> {
    try {
      const url = `${this.baseUrl}/servers?search=${encodeURIComponent(query)}&limit=${limit}&version=latest`;
      logger.info({ url, query }, "Searching MCP Registry");

      const response = await fetch(url, {
        headers: { "User-Agent": "SuperAgent/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, "MCP Registry search failed");
        return [];
      }

      const data = (await response.json()) as {
        servers?: Array<{
          server: MCPRegistryServer;
          _meta?: MCPRegistryMeta;
        }>;
        metadata?: { nextCursor?: string; count?: number };
      };

      return (data.servers ?? []).map((item) =>
        this.toMarketEntry(item.server, item._meta)
      );
    } catch (err: any) {
      logger.error({ error: err.message }, "MCP Registry search error");
      return [];
    }
  }

  /**
   * Get detailed info for a specific server by its qualified name.
   * e.g. "io.github.user/server-name"
   */
  async getServerDetail(serverName: string): Promise<MCPMarketEntry | null> {
    try {
      const encoded = encodeURIComponent(serverName);
      const url = `${this.baseUrl}/servers/${encoded}/versions/latest`;
      const response = await fetch(url, {
        headers: { "User-Agent": "SuperAgent/1.0" },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as {
        server: MCPRegistryServer;
        _meta?: MCPRegistryMeta;
      };
      return this.toMarketEntry(data.server, data._meta);
    } catch (err: any) {
      logger.error(
        { serverName, error: err.message },
        "Failed to get server detail"
      );
      return null;
    }
  }

  /**
   * Build an MCPServerConfig from a marketplace entry.
   * Prefers npm (npx) over docker.
   * Returns null if no installable package found.
   */
  buildInstallConfig(entry: MCPMarketEntry): MCPInstallConfig | null {
    const npmPkg = entry.packages.find((p) => p.registryType === "npm");
    const dockerPkg = entry.packages.find((p) => p.registryType === "oci");

    if (npmPkg) {
      const transportType = npmPkg.transport?.type ?? "stdio";

      if (transportType === "stdio") {
        return {
          name: entry.displayName || this.extractShortName(entry.name),
          transport: "stdio",
          command: "npx",
          args: ["-y", npmPkg.identifier],
          env: {},
        };
      } else {
        // SSE or HTTP transport — user must provide URL after install
        return {
          name: entry.displayName || this.extractShortName(entry.name),
          transport:
            transportType === "sse" ? "sse" : "streamable-http",
          url: "", // Placeholder — user needs to set
          env: {},
        };
      }
    }

    if (dockerPkg) {
      return {
        name: entry.displayName || this.extractShortName(entry.name),
        transport: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", dockerPkg.identifier],
        env: {},
      };
    }

    return null;
  }

  // ─── Private helpers ────────────────────────────────────────

  private toMarketEntry(
    server: MCPRegistryServer,
    meta?: MCPRegistryMeta
  ): MCPMarketEntry {
    const official =
      meta?.["io.modelcontextprotocol.registry/official"];
    const packages = server.packages ?? [];
    const npmPkg = packages.find((p) => p.registryType === "npm");
    const dockerPkg = packages.find((p) => p.registryType === "oci");
    const primaryPkg = npmPkg ?? dockerPkg ?? packages[0];

    // Deduplicate environment variables across all packages
    const allEnvVars: MCPMarketEntry["envVars"] = [];
    for (const pkg of packages) {
      for (const ev of pkg.environmentVariables ?? []) {
        if (!allEnvVars.some((e) => e.name === ev.name)) {
          allEnvVars.push({
            name: ev.name,
            description: ev.description,
            isRequired: ev.isRequired,
            isSecret: ev.isSecret,
          });
        }
      }
    }

    return {
      id: `mcp_${server.name?.replace(/[^a-zA-Z0-9]/g, "_") ?? uuid().slice(0, 8)}`,
      name: server.name ?? "",
      displayName: this.extractShortName(server.name ?? ""),
      description: server.description ?? "",
      version: server.version ?? "unknown",
      repository: server.repository?.url,
      isOfficial: official?.status === "active",
      publishedAt: official?.publishedAt,
      updatedAt: official?.updatedAt,
      packages,
      npmPackage: npmPkg?.identifier,
      dockerImage: dockerPkg?.identifier,
      transportType: primaryPkg?.transport?.type ?? "stdio",
      envVars: allEnvVars,
    };
  }

  /** Extract short name from qualified name (e.g. "io.github.user/my-server" → "my-server") */
  private extractShortName(fullName: string): string {
    const parts = fullName.split("/");
    return parts[parts.length - 1] ?? fullName;
  }
}
