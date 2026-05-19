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
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
