/**
 * Super Agent Monitor — Electron 主进程
 *
 * 独立桌面监控窗口，随程序启动自动运行。
 * 连接到 log-monitor SSE 端点获取实时日志和 Trace 数据。
 *
 * 功能:
 * - 左栏: 实时日志流（支持级别过滤）
 * - 右栏: Trace 瀑布图（全链路可视化）
 * - 顶栏: 系统状态摘要
 * - 底栏: 搜索 + 时间范围
 */

const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");

// 禁用硬件加速（避免某些 Windows 环境下的渲染问题）
app.disableHardwareAcceleration();

/** 监控面板端口 */
const MONITOR_PORT = process.env.MONITOR_PORT || 3002;
/** API 端口（用于 Trace SSE） */
const API_PORT = process.env.API_PORT || 3001;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Super Agent Monitor",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#0d1117",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    // 默认不置顶，用户可通过菜单切换
    alwaysOnTop: false,
  });

  // 加载内置的监控 UI
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 构建菜单
  const menu = Menu.buildFromTemplate([
    {
      label: "Monitor",
      submenu: [
        {
          label: "Always on Top",
          type: "checkbox",
          checked: false,
          click: (item) => {
            mainWindow.setAlwaysOnTop(item.checked);
          },
        },
        { type: "separator" },
        {
          label: "Open DevTools",
          accelerator: "F12",
          click: () => mainWindow.webContents.openDevTools(),
        },
        { type: "separator" },
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow.reload(),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Electron 就绪后创建窗口
app.whenReady().then(createWindow);

// macOS: 点击 dock 图标时重建窗口
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// 所有窗口关闭时退出（Windows/Linux）
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
