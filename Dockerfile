# Super Agent — 多阶段 Docker 构建
#
# 阶段 1（builder）：安装依赖 + 编译 TypeScript → dist
# 阶段 2（runner） ：仅复制生产依赖 + dist，运行 API 服务
#
# 构建：
#   docker build -t super-agent:latest .
#
# 运行：
#   docker run -d -p 3100:3100 -v ./data:/app/data --name super-agent super-agent:latest
#
# 或使用 docker-compose：
#   docker compose up -d

# ─── Build Stage ─────────────────────────────────────────

FROM node:20-slim AS builder

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /build

# 复制 workspace 配置 + lockfile（利用 Docker 缓存层）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/

# 安装所有依赖（含 devDependencies，用于 tsup 编译）
RUN pnpm install --frozen-lockfile

# 复制源码
COPY packages/core/src packages/core/src/
COPY packages/core/tsconfig.json packages/core/
COPY packages/api/src packages/api/src/
COPY packages/api/tsconfig.json packages/api/

# 编译
RUN pnpm --filter @super-agent/core build
RUN pnpm --filter @super-agent/api build

# ─── Runner Stage ─────────────────────────────────────────

FROM node:20-slim AS runner

# 安装 pnpm（用于 pnpm install --prod）
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# 复制构建产物
COPY --from=builder /build/packages/core/dist ./core/
COPY --from=builder /build/packages/api/dist ./api/

# 创建精简 package.json（仅生产依赖）
COPY <<'PKGJSON' package.json
{
  "name": "super-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node api/index.js" },
  "dependencies": {
    "@fastify/cors": "^11.0.0",
    "@fastify/jwt": "^9.0.0",
    "@fastify/rate-limit": "^10.3.0",
    "@fastify/static": "^8.1.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^12.9.0",
    "chokidar": "^4.0.0",
    "cron-parser": "^5.5.0",
    "dotenv": "^16.4.0",
    "eventemitter3": "^5.0.1",
    "gray-matter": "^4.0.3",
    "json5": "^2.2.3",
    "openai": "^4.104.0",
    "p-limit": "^6.2.0",
    "pino": "^9.6.0",
    "uuid": "^11.1.0",
    "zod": "^3.24.0",
    "zod-to-json-schema": "^3.25.2"
  }
}
PKGJSON

# 安装生产依赖
RUN pnpm install --prod --no-frozen-lockfile

# 创建数据目录（挂载点）
RUN mkdir -p /app/data

# 环境变量（可在运行时覆盖）
ENV NODE_ENV=production
ENV SA_DB_PATH=/app/data/super-agent.db
ENV SUPER_AGENT_VERSION=0.1.0

# API 端口
EXPOSE 3100

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3100/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# 启动 API 服务
CMD ["node", "api/index.js"]
