/**
 * Preload Script — Electron 安全桥接
 *
 * 为渲染进程暴露有限的 API，避免直接访问 Node.js
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("monitorAPI", {
  /** 获取配置信息 */
  getConfig: () => ({
    monitorPort: process.env.MONITOR_PORT || 3002,
    apiPort: process.env.API_PORT || 3001,
    monitorUrl: `http://localhost:${process.env.MONITOR_PORT || 3002}`,
    apiUrl: `http://localhost:${process.env.API_PORT || 3001}`,
  }),
});
