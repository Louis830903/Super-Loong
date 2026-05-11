---
name: ecom-operator
description: 微信小店 + 抖音小店双平台电商运营自动化。用于：(1) 浏览器自动登录后台读取商品/订单/数据 (2) 商品批量上架/下架 (3) 订单发货处理 (4) 每日巡检日报 (5) 智能客服回复 (6) 选品与竞品监控。当用户提到电商运营、微信小店、抖音小店、抖店、商品管理、上下架、订单发货、日常巡检、选品时触发。
version: 1.0.0
platforms:
  - wechat-store
  - douyin-store
prerequisites:
  envVars:
    - WECHAT_STORE_URL
    - DOUYIN_STORE_URL
    - FEISHU_WEBHOOK_URL
  bins:
    - playwright
metadata:
  tags:
    - ecommerce
    - wechat-store
    - douyin-store
    - automation
    - operations
  category: ecommerce
security:
  requireApproval:
    - 批量下架
    - 修改价格
    - 批量发货
---

# 电商运营 Skill

通过浏览器自动化访问微信小店和抖音小店后台，实现日常运营自动化。

> ⚠️ **重要**：使用 super-agent 内置的 `browser_*` 系列工具（基于 Playwright），操作前必读 [browser-automation.md](references/browser-automation.md)

---

## 核心 URL 速查

### 微信小店

基础域: `https://store.weixin.qq.com`

| 功能 | 路径 |
|------|------|
| 商品管理 | `/shop/product/list` |
| 订单管理 | `/shop/order/list` |
| 售后管理 | `/shop/aftersale/list` |
| 数据罗盘 | `/shop/data/overview` |
| 营销中心 | `/shop/marketing/list` |

### 抖音小店（抖店）

基础域: `https://fxg.jinritemai.com`

| 功能 | 路径 |
|------|------|
| 商品管理（在售） | `/ffa/g/list?sov_draft_status=0&sov_goodsType=0` |
| 商品管理（审核驳回） | `/ffa/g/list?sov_draft_status=3` |
| 商品创建 | `/ffa/g/create` |
| 订单管理 | `/ffa/morder/order/list` |
| 发货中心 | `/ffa/morder/logistics/ewaybill-delivery` |
| 经营概览（罗盘） | `/ffa/mcompass/overview` |
| 商机中心 | `/ffa/bu/NewBusinessCenter` |
| 体验分 | `/ffa/eco/experience-score` |
| 售后工作台 | `/ffa/maftersale/aftersale/list` |

---

## 每日巡检流程

> 🕘 建议每天早上 9:00 自动执行

```
1. browser_navigate → 打开微信小店订单管理 → browser_screenshot
2. browser_navigate → 打开抖店订单管理 → browser_screenshot
3. browser_navigate → 打开抖店商品管理(审核驳回) → browser_screenshot
4. browser_vision → 分析截图，提取关键数据
5. 汇总生成日报，推送飞书
```

**日报格式：**

```
📊 电商运营日报
🗓️ YYYY-MM-DD

━━━ 微信小店 ━━━
📦 待发货订单：X单
🔔 售后待处理：X单

━━━ 抖音小店 ━━━
📦 今日订单：X单
📋 在售商品：X个
🚫 审核驳回：X个
⭐ 体验分：X.XX

━━━ 待办事项 ━━━
[需要店主确认的事项]
```

---

## 商品上架流程

### 微信小店

```
1. browser_navigate → store.weixin.qq.com/shop/product/list
2. browser_screenshot → 确认已登录状态
3. browser_click → text=新增商品
4. browser_wait → 等待表单加载
5. browser_type → 商品名称输入框
6. browser_type → 价格输入框
7. browser_type → 库存输入框
8. browser_select → 选择商品类目
9. browser_type → 商品描述（富文本）
10. browser_upload → 上传商品主图
11. browser_upload → 上传详情图
12. browser_click → text=提交审核
13. browser_screenshot → 确认提交成功
```

### 抖音小店

```
1. browser_navigate → fxg.jinritemai.com/ffa/g/create
2. browser_screenshot → 确认页面状态
3. browser_type → 商品标题
4. browser_select → 选择类目
5. browser_type → 售价
6. browser_type → 库存
7. browser_upload → 上传主图/详情图
8. browser_type → 商品描述
9. browser_click → text=提交审核
```

> ⚠️ **图片上传限制**：抖店的 React `<input type="file">` 可能被拦截。如 `browser_upload` 失败，提示用户手动上传图片，其余步骤自动化。

---

## 订单发货流程

```
1. browser_navigate → 打开订单管理页
2. browser_wait → 等待订单列表加载
3. browser_snapshot → 获取待发货订单列表
4. 逐个处理：
   a. browser_click → 点击"发货"按钮
   b. browser_select → 选择快递公司
   c. browser_type → 输入快递单号
   d. browser_click → text=确认发货
   e. browser_screenshot → 确认发货成功
```

---

## 批量下架流程（抖店）

```
1. browser_navigate → 商品管理页
2. browser_type → 搜索框输入逗号分隔的商品ID
3. browser_click → text=查询
4. browser_wait → 等待搜索结果
5. browser_click → 全选复选框
6. browser_click → text=批量下架
7. browser_wait → 等待确认弹窗
8. browser_evaluate → 点击"仍要下架"按钮
   JS: [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '仍要下架')?.click()
```

> ⚠️ **安全规则**：批量下架操作需要用户确认后才能执行。

---

## 浏览器操作铁律

1. **永远先 `browser_screenshot` 确认页面状态**，不要盲操作
2. **React 页面输入**：使用 `browser_type` 工具（它内部处理了 React 合成事件）
3. **虚拟滚动列表**：抖店商品列表使用虚拟滚动，需要滚动+分段采集
4. **弹窗确认**：用 JS evaluate 精确匹配按钮文本，避免 CSS 选择器失效
5. **页面加载等待**：`browser_navigate` 后默认等 3 秒，再操作
6. **登录态保持**：使用同一个 browser context，保持 Cookie 不过期

### 虚拟滚动商品采集（抖店专用）

```javascript
// 初始化全局缓存
window._all = {};

// 滚动采集函数
const extract = () => {
  document.querySelectorAll('table tbody tr').forEach(r => {
    const t = r.innerText;
    const id = t.match(/ID:(\d{15,})/);
    const dt = t.match(/202\d\/\d{2}\/\d{2}/);
    if (id && dt) window._all[id[1]] = dt[0];
  });
};

// 滚动 + 分段采集
const scrollEl = document.scrollingElement;
scrollEl.scrollTop = 0;
for (let i = 0; i < 15; i++) {
  extract();
  scrollEl.scrollTop += 500;
  await new Promise(r => setTimeout(r, 150));
}

// 导出结果
Object.entries(window._all).sort((a,b) => a[1] < b[1] ? 1 : -1)
```

---

## 智能客服回复

当用户询问"帮我回复客户消息"时：

```
1. browser_navigate → 打开客服消息页面
2. browser_snapshot → 获取未回复消息列表
3. 逐条分析客户问题，生成回复建议
4. 展示给用户确认
5. browser_type → 输入回复内容
6. browser_click → 发送按钮
```

**自动回复规则：**
- 物流查询 → 自动查订单号 + 返回物流状态
- 退换货 → 引导至售后流程
- 商品咨询 → 查知识库返回商品信息
- 差评投诉 → 标记优先处理，通知店主

---

## 支持的 super-agent 工具

| 工具 | 用途 |
|------|------|
| `browser_navigate` | 打开电商后台页面 |
| `browser_screenshot` | 截图确认页面状态 |
| `browser_snapshot` | 获取页面无障碍树（理解结构） |
| `browser_click` | 点击按钮/链接 |
| `browser_type` | 输入文字（自动处理 React 事件） |
| `browser_select` | 下拉选择 |
| `browser_upload` | 上传文件（商品图片） |
| `browser_wait` | 等待元素出现 |
| `browser_press` | 键盘按键 |
| `browser_vision` | 截图+LLM视觉分析 |
| `browser_evaluate` | 执行 JS 代码 |
| `browser_console` | 查看控制台日志 |
| `browser_back` | 返回上一页 |
| `screen_capture` | 桌面截图 |
| `screen_ocr` | 屏幕文字识别 |

---

## 铁律

1. **定价/下架操作必须店主确认**，不能自动改价格
2. **不能刷单、不违规操作**
3. **虚拟滚动**：抖店商品列表需要滚动JS采集
4. **图片上传**：抖店商品图上传可能受限，需手动介入
5. **登录态**：出现登录过期需通知人工扫码登录
6. **批量操作**：批量发货/下架前截图确认，执行后截图验证

---

## 参考文档

- [browser-automation.md](references/browser-automation.md) — ⭐ **浏览器自动化踩坑录**（必读）
- [wechat-store.md](references/wechat-store.md) — 微信小店运营手册
- [douyin-store.md](references/douyin-store.md) — 抖音小店运营手册
