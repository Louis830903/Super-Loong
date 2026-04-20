import type { NextConfig } from "next";

const API_SERVER = process.env.API_SERVER_URL || "http://localhost:3001";

const nextConfig: NextConfig = {
  // 增加代理超时至 5 分钟，避免 SSE 流式 LLM 响应被 Next.js 默认 30s 代理超时截断
  experimental: {
    proxyTimeout: 300_000,
  },
  // Proxy /api requests to the backend API server
  // so the browser never makes cross-origin requests
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_SERVER}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
