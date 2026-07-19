import type { NextConfig } from "next";

// @why 用 127.0.0.1 而非 localhost：Windows 上 localhost 可能优先解析为 IPv6 ::1，
// 而 API 监听 0.0.0.0(IPv4)，且 video-intro(Remotion) 会占用 [::1]:3001，
// 导致 /api 代理误命中 Remotion。强制 IPv4 可确定性命中真正的 API。
const API_SERVER = process.env.API_SERVER_URL || "http://127.0.0.1:3001";

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
      // 注: WebSocket 连接由前端直连后端（Next.js rewrites 不支持 WS 协议升级）
      // WS_BASE 在 utils.ts 中配置为直连后端端口
    ];
  },
};

export default nextConfig;
