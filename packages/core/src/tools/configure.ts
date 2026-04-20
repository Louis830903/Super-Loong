/**
 * configure_service — Agent 对话式配置工具。
 *
 * 让 Agent 在对话中帮用户配置外部服务的 API Key、端点或路径，
 * 无需用户手动编辑 .env 文件。
 */

import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { getConfigStore, SERVICE_CATALOG, maskSecret } from "./config-store.js";

const configureServiceTool: ToolDefinition = {
  name: "configure_service",
  description:
    "配置外部服务的 API Key、端点或路径。Agent 可在对话中调用此工具帮用户保存配置。" +
    "支持的服务：aliyun_voice（阿里云语音）、ark_seedream（火山方舟图片生成）、browser（浏览器自动化）、vision（视觉分析）。",
  parameters: z.object({
    action: z.enum(["list", "get", "set", "delete"]).describe(
      "list=列出可配置服务, get=查看服务配置状态, set=保存配置, delete=清除配置"
    ),
    service_id: z.string().optional().describe(
      "服务标识，如 aliyun_voice / ark_seedream / browser"
    ),
    config: z.record(z.string()).optional().describe(
      "set 时传入，如 { api_key: 'xxx', endpoint_id: 'yyy' }"
    ),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { action, service_id, config } = params as {
      action: "list" | "get" | "set" | "delete";
      service_id?: string;
      config?: Record<string, string>;
    };

    const store = getConfigStore();

    try {
      switch (action) {
        // ── list: 列出所有可配置服务 ──
        case "list": {
          const services = store.listServices();
          const lines = services.map((s, i) => {
            const status = s.configured ? "✅ 已配置" : "⚠️ 未配置";
            const keyDetails = s.keys
              .map(k => `  - ${k.label}: ${k.hasValue ? k.maskedValue : "未设置"}`)
              .join("\n");
            return `${i + 1}. ${s.name}（${s.id}）— ${status}\n${keyDetails}`;
          });
          return {
            success: true,
            output: `可配置服务列表：\n\n${lines.join("\n\n")}`,
            data: { services: services.map(s => ({ id: s.id, name: s.name, configured: s.configured })) },
          };
        }

        // ── get: 查看单个服务配置状态 ──
        case "get": {
          if (!service_id) {
            return { success: false, output: "请指定 service_id，如 aliyun_voice / ark_seedream / browser", error: "missing service_id" };
          }
          const catalog = SERVICE_CATALOG.find(s => s.id === service_id);
          if (!catalog) {
            return { success: false, output: `未知服务: ${service_id}。可用: ${SERVICE_CATALOG.map(s => s.id).join(", ")}`, error: "unknown service" };
          }
          const allConfig = store.getAll(service_id);
          const lines = catalog.keys.map(k => {
            const val = allConfig[k.key];
            const display = val ? (k.secret ? maskSecret(val) : val) : "未设置";
            return `- ${k.label}（${k.key}）: ${display}`;
          });
          const configured = catalog.keys.some(k => !!allConfig[k.key]);
          return {
            success: true,
            output: `${catalog.name} 配置状态：${configured ? "✅ 已配置" : "⚠️ 未配置"}\n${lines.join("\n")}` +
              (catalog.website ? `\n\n获取密钥：${catalog.website}` : ""),
            data: { service_id, configured },
          };
        }

        // ── set: 保存配置 ──
        case "set": {
          if (!service_id) {
            return { success: false, output: "请指定 service_id", error: "missing service_id" };
          }
          if (!config || Object.keys(config).length === 0) {
            return { success: false, output: "请提供 config 参数，如 { api_key: 'xxx' }", error: "missing config" };
          }
          const catalog = SERVICE_CATALOG.find(s => s.id === service_id);
          if (!catalog) {
            return { success: false, output: `未知服务: ${service_id}`, error: "unknown service" };
          }
          // 校验 key 是否在目录中
          const validKeys = catalog.keys.map(k => k.key);
          const invalidKeys = Object.keys(config).filter(k => !validKeys.includes(k));
          if (invalidKeys.length > 0) {
            return {
              success: false,
              output: `无效的配置键: ${invalidKeys.join(", ")}。有效键: ${validKeys.join(", ")}`,
              error: "invalid keys",
            };
          }
          // 保存每个配置项
          for (const [key, value] of Object.entries(config)) {
            store.set(service_id, key, value);
          }
          const savedKeys = Object.keys(config).join(", ");
          return {
            success: true,
            output: `✅ ${catalog.name} 配置已保存（${savedKeys}）`,
            data: { service_id, savedKeys: Object.keys(config) },
          };
        }

        // ── delete: 清除配置 ──
        case "delete": {
          if (!service_id) {
            return { success: false, output: "请指定 service_id", error: "missing service_id" };
          }
          const catalog = SERVICE_CATALOG.find(s => s.id === service_id);
          if (!catalog) {
            return { success: false, output: `未知服务: ${service_id}`, error: "unknown service" };
          }
          store.delete(service_id);
          return {
            success: true,
            output: `✅ ${catalog.name} 的配置已清除`,
            data: { service_id },
          };
        }

        default:
          return { success: false, output: `未知操作: ${action}`, error: "unknown action" };
      }
    } catch (err: any) {
      return { success: false, output: `配置操作失败: ${err.message}`, error: err.message };
    }
  },
};

export const configureTools: ToolDefinition[] = [configureServiceTool];
