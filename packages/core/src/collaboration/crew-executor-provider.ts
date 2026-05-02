/**
 * crew-executor-provider.ts — 视频 Crew 执行时的 per-Agent 模型覆盖辅助。
 *
 * applyPerAgentProvider() 将 AgentProviderOverride（来自模板/用户配置）
 * 与 ProviderStore 中的实际密钥/端点合并，生成完整的 LLMProviderConfig。
 *
 * 覆盖优先级（从高到低）：
 *   1. override 直接传入的 apiKey / baseUrl（用户显式指定）
 *   2. ProviderStore 中按 providerId 查到的 apiKey / baseUrl
 *   3. 模型目录中提供商的默认 baseUrl
 *
 * @see video-crew-provider-presets.ts 预设定义
 * @see routes/video.ts POST /api/video/jobs 消费端
 */

import type { AgentConfig, LLMProviderConfig, LLMProviderType } from "../types/index.js";
import type { AgentProviderOverride } from "./video-crew-provider-presets.js";
import { getProviderById, getModelById } from "../llm/model-catalog.js";
import type { ProviderStore } from "../llm/provider-store.js";

/**
 * 将 per-Agent 的模型覆盖配置应用到 AgentConfig 上，
 * 自动从 ProviderStore 和模型目录补全 apiKey / baseUrl / 能力标记。
 *
 * @param agent      待覆盖的 AgentConfig（会被原地修改 llmProvider）
 * @param override   用户/模板指定的覆盖配置
 * @param store      ProviderStore 实例（用于查询已保存的 apiKey / baseUrl）
 * @returns          修改后的 agent（方便链式调用）
 */
export function applyPerAgentProvider(
  agent: AgentConfig,
  override: AgentProviderOverride,
  store: ProviderStore,
): AgentConfig {
  // 1. 从 ProviderStore 读取已保存的密钥与端点
  const storedProvider = store.get(override.providerId);

  // 2. 从模型目录读取默认 baseUrl 和模型能力
  const catalogProvider = getProviderById(override.providerId);
  const catalogModel = getModelById(override.providerId, override.model);

  // 3. 推断 LLM 类型：Ollama 特殊处理，其他走 OpenAI 兼容
  let llmType: LLMProviderType = "openai";
  if (override.providerId === "ollama") {
    llmType = "ollama";
  }

  // 4. 合并优先级：override 显式值 > ProviderStore > 模型目录默认
  const resolvedApiKey =
    override.apiKey ||
    storedProvider?.apiKey ||
    "";

  const resolvedBaseUrl =
    override.baseUrl ||
    storedProvider?.baseUrl ||
    catalogProvider?.baseUrl ||
    "";

  // 5. 构建完整的 LLMProviderConfig
  const config: LLMProviderConfig = {
    type: llmType,
    model: override.model,
    apiKey: resolvedApiKey || undefined,
    baseUrl: resolvedBaseUrl || undefined,
    providerId: override.providerId,
    supportsReasoning: catalogModel?.supportsReasoning ?? false,
    supportsVision: catalogModel?.supportsVision ?? false,
  };

  agent.llmProvider = config;
  return agent;
}

/**
 * 批量将 agent_providers 映射应用到 Agent 数组。
 *
 * @param agents      Agent 配置数组
 * @param providers   Record<agentId, AgentProviderOverride>
 * @param store       ProviderStore 实例
 * @returns           修改后的 agents 数组
 */
export function applyAllAgentProviders(
  agents: AgentConfig[],
  providers: Record<string, AgentProviderOverride>,
  store: ProviderStore,
): AgentConfig[] {
  for (const agent of agents) {
    const override = providers[agent.id];
    if (override) {
      applyPerAgentProvider(agent, override, store);
    }
  }
  return agents;
}
