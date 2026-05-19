/**
 * Config module — central path resolution, env access, and configuration.
 */
export { resolveHome, resetResolvedHome, paths, ensureDirectories } from "./paths.js";
export { Env } from "./env.js";
export { FeatureFlags } from "./feature-flags.js";
