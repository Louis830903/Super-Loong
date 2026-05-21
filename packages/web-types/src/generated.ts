/* eslint-disable */
/* prettier-ignore */
/**
 * 此文件由 packages/api/scripts/gen-types.ts 自动生成 — 请勿手工修改。
 *
 * 数据源：packages/api/src/schemas/* (zod) → openapi.json → 此文件
 * 重新生成：pnpm gen:types
 * 漂移检测：pnpm gen:types:check（CI 强制闸门）
 */

export interface paths {
    "/api/channels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出所有 IM 渠道 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 渠道列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChannelListEnvelope"];
                    };
                };
            };
        };
        put?: never;
        /** 新建 IM 渠道 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["ChannelConfig"];
                };
            };
            responses: {
                /** @description 渠道创建成功 */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChannelCreatedEnvelope"];
                    };
                };
                /** @description 渠道配置不合法 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiErrorEnvelope"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/channels/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取单个 IM 渠道详情 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 渠道详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChannelDetailEnvelope"];
                    };
                };
                /** @description 渠道不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiErrorEnvelope"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** 删除 IM 渠道 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ChannelDeletedEnvelope"];
                    };
                };
                /** @description 渠道不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiErrorEnvelope"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/gateway/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * IM 网关聚合健康
         * @description 透传 Python 网关 /health；网关不可达时返回 status=offline 兜底
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 网关健康详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GatewayHealthEnvelope"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/gateway/channels/schemas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出所有渠道的配置 Schema
         * @description 前端据此自动渲染配置表单；透传 Python 网关响应
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 渠道 schema 列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GatewayChannelSchemasEnvelope"];
                    };
                };
                /** @description 网关不可达（走 sendError badGateway） */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiErrorEnvelope"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/gateway/channels/list": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * 列出所有渠道及连接状态
         * @description 透传 Python 网关 /api/gateway/channels；返回每渠道连接 / 能力详情
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 渠道状态列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["GatewayChannelListEnvelope"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/models/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取内置模型目录 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 模型目录 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/models/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取已配置 Provider 列表 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Provider 列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                providers: {
                                    id: string;
                                    name: string;
                                    website?: string;
                                    baseUrl: string;
                                    defaultBaseUrl: string;
                                    isEnabled: boolean;
                                    selectedModel: string;
                                    /** @enum {string} */
                                    keyStatus: "configured" | "missing";
                                    maskedKey: string;
                                    models: {
                                        id: string;
                                        name: string;
                                        contextWindow?: number;
                                        supportsReasoning?: boolean;
                                        supportsVision?: boolean;
                                        fixedTemperature?: number;
                                        deprecated?: boolean;
                                        deprecationDate?: string;
                                        free?: boolean;
                                    }[];
                                }[];
                            };
                            traceId?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/models/providers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** 更新 Provider 配置 */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        apiKey?: string;
                        baseUrl?: string;
                        isEnabled?: boolean;
                        selectedModel?: string;
                    };
                };
            };
            responses: {
                /** @description 更新成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                provider: {
                                    id: string;
                                    isEnabled: boolean;
                                    selectedModel: string;
                                    /** @enum {string} */
                                    keyStatus: "configured" | "missing";
                                    maskedKey: string;
                                    baseUrl: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description Provider 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/models/providers/{id}/key": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** 清空 Provider API Key */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 清空成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                success: boolean;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description Provider 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/models/providers/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 测试 Provider 连接 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        model?: string;
                        apiKey?: string;
                        baseUrl?: string;
                    };
                };
            };
            responses: {
                /** @description 测试成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                success: boolean;
                                model: string;
                                response: string;
                                usage?: {
                                    [key: string]: unknown;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 连接失败 */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出所有 Agent（支持 type/department/分页） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent 列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                agents: {
                                    id: string;
                                    name: string;
                                    description?: string;
                                    systemPrompt?: string;
                                    llmProvider?: {
                                        type: string;
                                        model?: string;
                                        apiKey?: string;
                                        baseUrl?: string;
                                        providerId?: string;
                                        supportsReasoning?: boolean;
                                        temperature?: number;
                                        maxTokens?: number;
                                    };
                                    tools?: string[];
                                    skills?: string[];
                                    channels?: string[];
                                    memoryEnabled?: boolean;
                                    maxToolIterations?: number;
                                    metadata?: {
                                        isBuiltin?: boolean;
                                        department?: string;
                                        forkedFrom?: string;
                                        icon?: string;
                                        color?: string;
                                    };
                                    status?: string;
                                    createdAt?: string;
                                }[];
                                total: number;
                                limit?: number;
                                offset?: number;
                            };
                            traceId?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        /** 创建新 Agent */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 创建成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                agent: {
                                    id: string;
                                    name: string;
                                    description?: string;
                                    systemPrompt?: string;
                                    llmProvider?: {
                                        type: string;
                                        model?: string;
                                        apiKey?: string;
                                        baseUrl?: string;
                                        providerId?: string;
                                        supportsReasoning?: boolean;
                                        temperature?: number;
                                        maxTokens?: number;
                                    };
                                    tools?: string[];
                                    skills?: string[];
                                    channels?: string[];
                                    memoryEnabled?: boolean;
                                    maxToolIterations?: number;
                                    metadata?: {
                                        isBuiltin?: boolean;
                                        department?: string;
                                        forkedFrom?: string;
                                        icon?: string;
                                        color?: string;
                                    };
                                    status?: string;
                                    createdAt?: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 配置校验失败 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取 Agent 详情 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent 详情 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                agent: {
                                    id: string;
                                    name: string;
                                    description?: string;
                                    systemPrompt?: string;
                                    llmProvider?: {
                                        type: string;
                                        model?: string;
                                        apiKey?: string;
                                        baseUrl?: string;
                                        providerId?: string;
                                        supportsReasoning?: boolean;
                                        temperature?: number;
                                        maxTokens?: number;
                                    };
                                    tools?: string[];
                                    skills?: string[];
                                    channels?: string[];
                                    memoryEnabled?: boolean;
                                    maxToolIterations?: number;
                                    metadata?: {
                                        isBuiltin?: boolean;
                                        department?: string;
                                        forkedFrom?: string;
                                        icon?: string;
                                        color?: string;
                                    };
                                    status?: string;
                                    createdAt?: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description Agent 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        /** 更新 Agent */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 更新成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                agent: {
                                    id: string;
                                    name: string;
                                    description?: string;
                                    systemPrompt?: string;
                                    llmProvider?: {
                                        type: string;
                                        model?: string;
                                        apiKey?: string;
                                        baseUrl?: string;
                                        providerId?: string;
                                        supportsReasoning?: boolean;
                                        temperature?: number;
                                        maxTokens?: number;
                                    };
                                    tools?: string[];
                                    skills?: string[];
                                    channels?: string[];
                                    memoryEnabled?: boolean;
                                    maxToolIterations?: number;
                                    metadata?: {
                                        isBuiltin?: boolean;
                                        department?: string;
                                        forkedFrom?: string;
                                        icon?: string;
                                        color?: string;
                                    };
                                    status?: string;
                                    createdAt?: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 内置 Agent 不可修改 */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Agent 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        /** 删除 Agent */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                success: boolean;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 内置 Agent 不可删除 */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Agent 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/fork": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Fork 内置 Agent 为自定义副本 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Fork 成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                agent: {
                                    id: string;
                                    name: string;
                                    description?: string;
                                    systemPrompt?: string;
                                    llmProvider?: {
                                        type: string;
                                        model?: string;
                                        apiKey?: string;
                                        baseUrl?: string;
                                        providerId?: string;
                                        supportsReasoning?: boolean;
                                        temperature?: number;
                                        maxTokens?: number;
                                    };
                                    tools?: string[];
                                    skills?: string[];
                                    channels?: string[];
                                    memoryEnabled?: boolean;
                                    maxToolIterations?: number;
                                    metadata?: {
                                        isBuiltin?: boolean;
                                        department?: string;
                                        forkedFrom?: string;
                                        icon?: string;
                                        color?: string;
                                    };
                                    status?: string;
                                    createdAt?: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 源 Agent 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/forks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 查询 Agent 的 Fork 列表 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Fork 列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                forks: {
                                    id: string;
                                    name: string;
                                    description?: string;
                                    systemPrompt?: string;
                                    llmProvider?: {
                                        type: string;
                                        model?: string;
                                        apiKey?: string;
                                        baseUrl?: string;
                                        providerId?: string;
                                        supportsReasoning?: boolean;
                                        temperature?: number;
                                        maxTokens?: number;
                                    };
                                    tools?: string[];
                                    skills?: string[];
                                    channels?: string[];
                                    memoryEnabled?: boolean;
                                    maxToolIterations?: number;
                                    metadata?: {
                                        isBuiltin?: boolean;
                                        department?: string;
                                        forkedFrom?: string;
                                        icon?: string;
                                        color?: string;
                                    };
                                    status?: string;
                                    createdAt?: string;
                                }[];
                                count: number;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description Agent 不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/voice/transcribe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 语音转文字（多 Provider 自动降级） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description base64 encoded audio data */
                        audio: string;
                        /** @default zh */
                        language?: string;
                        /** @default webm */
                        format?: string;
                        /** @description 前端 AudioContext RMS 峰值，用于幻觉过滤 */
                        rmsPeak?: number;
                    };
                };
            };
            responses: {
                /** @description 转写结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                text: string;
                                /** @description true = Whisper 幻觉已过滤 */
                                filtered?: boolean;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 所有 STT 服务不可用 */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/voice/synthesize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 文字转语音（返回 audio/mpeg 二进制） */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        text: string;
                        voice?: string;
                        speed?: number;
                        volume?: number;
                        format?: string;
                    };
                };
            };
            responses: {
                /** @description 音频二进制流 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "audio/mpeg": unknown;
                    };
                };
                /** @description text 字段缺失 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/voice/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取可用 STT Provider 列表 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Provider 列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                providers: ("stt-custom" | "aliyun-nls" | "llm-whisper" | "groq")[];
                            };
                            traceId?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cron/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 列出所有定时任务 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 任务列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                jobs: {
                                    id: string;
                                    name: string;
                                    expression?: string;
                                    naturalLanguage?: string;
                                    agentId: string;
                                    message: string;
                                    deliveryChannel?: string;
                                    deliveryChatId?: string;
                                    timezone?: string;
                                    maxRetries?: number;
                                    /** @enum {string} */
                                    scheduleType?: "cron" | "once" | "interval";
                                    runAt?: string;
                                    intervalMs?: number;
                                    timeoutSeconds?: number;
                                    enabled?: boolean;
                                    lastRun?: string;
                                    nextRun?: string;
                                    status?: string;
                                }[];
                            };
                            traceId?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        /** 创建定时任务 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        expression?: string;
                        naturalLanguage?: string;
                        agentId: string;
                        message: string;
                        deliveryChannel?: string;
                        deliveryChatId?: string;
                        timezone?: string;
                        maxRetries?: number;
                        /** @enum {string} */
                        scheduleType?: "cron" | "once" | "interval";
                        runAt?: string;
                        intervalMs?: number;
                        timeoutSeconds?: number;
                    };
                };
            };
            responses: {
                /** @description 创建成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                job: {
                                    id: string;
                                    name: string;
                                    expression?: string;
                                    naturalLanguage?: string;
                                    agentId: string;
                                    message: string;
                                    deliveryChannel?: string;
                                    deliveryChatId?: string;
                                    timezone?: string;
                                    maxRetries?: number;
                                    /** @enum {string} */
                                    scheduleType?: "cron" | "once" | "interval";
                                    runAt?: string;
                                    intervalMs?: number;
                                    timeoutSeconds?: number;
                                    enabled?: boolean;
                                    lastRun?: string;
                                    nextRun?: string;
                                    status?: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 参数校验失败 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cron/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** 更新定时任务 */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        expression?: string;
                        naturalLanguage?: string;
                        agentId?: string;
                        message?: string;
                        deliveryChannel?: string;
                        deliveryChatId?: string;
                        timezone?: string;
                        maxRetries?: number;
                        /** @enum {string} */
                        scheduleType?: "cron" | "once" | "interval";
                        runAt?: string;
                        intervalMs?: number;
                        timeoutSeconds?: number;
                    };
                };
            };
            responses: {
                /** @description 更新成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                job: {
                                    id: string;
                                    name: string;
                                    expression?: string;
                                    naturalLanguage?: string;
                                    agentId: string;
                                    message: string;
                                    deliveryChannel?: string;
                                    deliveryChatId?: string;
                                    timezone?: string;
                                    maxRetries?: number;
                                    /** @enum {string} */
                                    scheduleType?: "cron" | "once" | "interval";
                                    runAt?: string;
                                    intervalMs?: number;
                                    timeoutSeconds?: number;
                                    enabled?: boolean;
                                    lastRun?: string;
                                    nextRun?: string;
                                    status?: string;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 任务不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        /** 删除定时任务 */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                success: boolean;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 任务不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cron/jobs/{id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 立即执行定时任务 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 触发成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                triggered: boolean;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 任务不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cron/jobs/{id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取执行历史 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 执行历史 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                history: {
                                    id: string;
                                    jobId: string;
                                    startedAt: string;
                                    finishedAt?: string;
                                    /** @enum {string} */
                                    status: "success" | "failed" | "timeout" | "running";
                                    error?: string;
                                    retryCount?: number;
                                }[];
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 任务不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/cron/parse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 自然语言解析为 cron 表达式 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description 自然语言描述，如 '每天早上9点' */
                        text: string;
                        timezone?: string;
                    };
                };
            };
            responses: {
                /** @description 解析结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                expression: string;
                                description: string;
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 无法解析 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/files/parse": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** 解析文件，提取文本内容 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description 文件名（含扩展名），如 report.pdf */
                        filename: string;
                        /** @description base64 编码的文件内容 */
                        data: string;
                    };
                };
            };
            responses: {
                /** @description 解析结果 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                text: string;
                                filename: string;
                                type: string;
                                truncated: boolean;
                                originalLength?: number;
                                meta?: {
                                    [key: string]: unknown;
                                };
                            };
                            traceId?: string;
                        };
                    };
                };
                /** @description 不支持的文件类型或无效数据 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/files/supported": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 获取支持的文件类型和限制 */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 支持信息 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiSuccessEnvelope"] & {
                            /** @enum {boolean} */
                            success?: true;
                            data?: {
                                types: {
                                    extension: string;
                                    type: string;
                                }[];
                                /** @description 最大文件大小（字节） */
                                maxSize: number;
                                /** @description 文本截断阈值（字符） */
                                maxTextLength: number;
                            };
                            traceId?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ApiErrorBody: {
            /** @example NOT_FOUND */
            code: string;
            message: string;
            details?: unknown;
        };
        /** @description 标准化错误响应壳 */
        ApiErrorEnvelope: {
            /** @enum {boolean} */
            success: false;
            /** @description 标准化错误体 */
            error: {
                /**
                 * @description 标准化错误码
                 * @example NOT_FOUND
                 */
                code: string;
                message: string;
                details?: unknown;
            };
            traceId?: string;
        };
        /** @description IM 渠道配置（凭据 + 业务设置） */
        ChannelConfig: {
            /** @example feishu */
            platform: string;
            /** @default true */
            enabled: boolean;
            displayName?: string;
            /** @default {} */
            credentials: {
                [key: string]: string;
            };
            /** @default {} */
            settings: {
                [key: string]: unknown;
            };
        };
        /** @description IM 渠道实体（含运行状态） */
        ChannelEntity: {
            /** @example ch_a1b2c3d4 */
            id: string;
            config: components["schemas"]["ChannelConfig"];
            /**
             * @description 渠道运行状态
             * @example configuring
             */
            status: string;
        };
        /** @description Schema 驱动表单字段定义（前端据此自动渲染表单） */
        GatewayChannelField: {
            key: string;
            label: string;
            /** @enum {string} */
            type: "string" | "secret" | "number" | "boolean" | "select" | "url";
            required: boolean;
            default?: unknown;
            placeholder: string;
            help_text: string;
            options: {
                value: string;
                label: string;
            }[];
            group: string;
            order: number;
        };
        /** @description 单个 IM 渠道的 schema 描述（用于前端表单自动生成） */
        GatewayChannelSchema: {
            /** @example feishu */
            channel_id: string;
            /** @example 飞书 */
            channel_label: string;
            docs_url: string;
            setup_guide: string;
            fields: components["schemas"]["GatewayChannelField"][];
        };
        /** @description 单个渠道的连接状态与能力描述 */
        GatewayChannelStatus: {
            id: string;
            label: string;
            connected: boolean;
            last_error: string | null;
            has_qr_login: boolean;
            has_doctor: boolean;
            has_setup: boolean;
            capabilities: {
                media: boolean;
                threads: boolean;
                block_streaming: boolean;
            };
        };
        GatewayHealthEntry: {
            status: string;
            severity: number;
            needs_restart: boolean;
            cooldown_remaining: number;
        };
        /** @description IM 网关聚合健康（含每渠道 connect 状态 + 健康分级 + 重连指标） */
        GatewayHealth: {
            /** @example ok */
            status: string;
            version?: string;
            api_connection?: string;
            channels?: {
                [key: string]: {
                    connected: boolean;
                    last_error: string | null;
                };
            };
            channel_count?: number;
            active_sessions?: number;
            health?: {
                [key: string]: components["schemas"]["GatewayHealthEntry"];
            };
            reconnect?: {
                [key: string]: unknown;
            };
            error?: string;
        };
        ModelDef: {
            id: string;
            name: string;
            contextWindow?: number;
            supportsReasoning?: boolean;
            supportsVision?: boolean;
            fixedTemperature?: number;
            deprecated?: boolean;
            deprecationDate?: string;
            free?: boolean;
        };
        ProviderCatalog: {
            id: string;
            name: string;
            /** Format: uri */
            website?: string;
            baseUrl: string;
            models: {
                id: string;
                name: string;
                contextWindow?: number;
                supportsReasoning?: boolean;
                supportsVision?: boolean;
                fixedTemperature?: number;
                deprecated?: boolean;
                deprecationDate?: string;
                free?: boolean;
            }[];
        };
        ProviderConfig: {
            id: string;
            name: string;
            website?: string;
            baseUrl: string;
            defaultBaseUrl: string;
            isEnabled: boolean;
            selectedModel: string;
            /** @enum {string} */
            keyStatus: "configured" | "missing";
            maskedKey: string;
            models: {
                id: string;
                name: string;
                contextWindow?: number;
                supportsReasoning?: boolean;
                supportsVision?: boolean;
                fixedTemperature?: number;
                deprecated?: boolean;
                deprecationDate?: string;
                free?: boolean;
            }[];
        };
        UpdateProviderBody: {
            apiKey?: string;
            baseUrl?: string;
            isEnabled?: boolean;
            selectedModel?: string;
        };
        TestProviderBody: {
            model?: string;
            apiKey?: string;
            baseUrl?: string;
        };
        AgentMetadata: {
            isBuiltin?: boolean;
            department?: string;
            forkedFrom?: string;
            icon?: string;
            color?: string;
        };
        AgentLLMProvider: {
            type: string;
            model?: string;
            apiKey?: string;
            baseUrl?: string;
            providerId?: string;
            supportsReasoning?: boolean;
            temperature?: number;
            maxTokens?: number;
        };
        AgentState: {
            id: string;
            name: string;
            description?: string;
            systemPrompt?: string;
            llmProvider?: {
                type: string;
                model?: string;
                apiKey?: string;
                baseUrl?: string;
                providerId?: string;
                supportsReasoning?: boolean;
                temperature?: number;
                maxTokens?: number;
            };
            tools?: string[];
            skills?: string[];
            channels?: string[];
            memoryEnabled?: boolean;
            maxToolIterations?: number;
            metadata?: {
                isBuiltin?: boolean;
                department?: string;
                forkedFrom?: string;
                icon?: string;
                color?: string;
            };
            status?: string;
            createdAt?: string;
        };
        TranscribeBody: {
            /** @description base64 encoded audio data */
            audio: string;
            /** @default zh */
            language: string;
            /** @default webm */
            format: string;
            /** @description 前端 AudioContext RMS 峰值，用于幻觉过滤 */
            rmsPeak?: number;
        };
        SynthesizeBody: {
            text: string;
            voice?: string;
            speed?: number;
            volume?: number;
            format?: string;
        };
        CronJob: {
            id: string;
            name: string;
            expression?: string;
            naturalLanguage?: string;
            agentId: string;
            message: string;
            deliveryChannel?: string;
            deliveryChatId?: string;
            timezone?: string;
            maxRetries?: number;
            /** @enum {string} */
            scheduleType?: "cron" | "once" | "interval";
            runAt?: string;
            intervalMs?: number;
            timeoutSeconds?: number;
            enabled?: boolean;
            lastRun?: string;
            nextRun?: string;
            status?: string;
        };
        CreateCronJobBody: {
            name: string;
            expression?: string;
            naturalLanguage?: string;
            agentId: string;
            message: string;
            deliveryChannel?: string;
            deliveryChatId?: string;
            timezone?: string;
            maxRetries?: number;
            /** @enum {string} */
            scheduleType?: "cron" | "once" | "interval";
            runAt?: string;
            intervalMs?: number;
            timeoutSeconds?: number;
        };
        ParseCronBody: {
            /** @description 自然语言描述，如 '每天早上9点' */
            text: string;
            timezone?: string;
        };
        FileParseBody: {
            /** @description 文件名（含扩展名），如 report.pdf */
            filename: string;
            /** @description base64 编码的文件内容 */
            data: string;
        };
        /** @description 标准化成功响应壳 */
        ChannelListEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: {
                channels: components["schemas"]["ChannelEntity"][];
            };
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        ChannelDetailEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: {
                channel: components["schemas"]["ChannelEntity"];
            };
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        ChannelCreatedEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: {
                channel: components["schemas"]["ChannelEntity"];
            };
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        ChannelDeletedEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: {
                /** @enum {boolean} */
                success: true;
            };
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        GatewayHealthEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: components["schemas"]["GatewayHealth"];
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        GatewayChannelSchemasEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: components["schemas"]["GatewayChannelSchema"][];
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        GatewayChannelListEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: {
                channels: components["schemas"]["GatewayChannelStatus"][];
            };
            traceId?: string;
        };
        /** @description 标准化成功响应壳 */
        ApiSuccessEnvelope: {
            /** @enum {boolean} */
            success: true;
            data: {
                providers: {
                    id: string;
                    name: string;
                    /** Format: uri */
                    website?: string;
                    baseUrl: string;
                    models: {
                        id: string;
                        name: string;
                        contextWindow?: number;
                        supportsReasoning?: boolean;
                        supportsVision?: boolean;
                        fixedTemperature?: number;
                        deprecated?: boolean;
                        deprecationDate?: string;
                        free?: boolean;
                    }[];
                }[];
            };
            traceId?: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
