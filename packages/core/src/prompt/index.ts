/**
 * Prompt module — public exports for the system prompt engine.
 */

// Core engine
export { PromptEngine } from "./engine.js";
export type { PromptEngineConfig } from "./engine.js";

// Guidance constants
export {
  TOOL_USE_ENFORCEMENT,
  MEMORY_GUIDANCE,
  SKILLS_GUIDANCE_HEADER,
  SAFETY_GUARDRAILS,
} from "./guidance.js";

// Model adapters
export { MODEL_ADAPTERS, resolveModelGuidance, resolveToolEnforcement } from "./model-adapters.js";
export type { ModelAdapter } from "./model-adapters.js";

// Platform hints
export { PLATFORM_HINTS, resolvePlatformHint } from "./platform-hints.js";

// Context file discovery
export { discoverContextFiles } from "./context-files.js";

// Injection guard
export { scanForInjection, scanMemoryContent, scanCronPrompt, sanitizeMemoryContent } from "./injection-guard.js";
export type { ThreatCategory, ThreatSeverity, ThreatFinding } from "./injection-guard.js";
