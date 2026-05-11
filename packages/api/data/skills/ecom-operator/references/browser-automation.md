# 浏览器自动化踩坑录

在微信小店和抖音小店后台使用浏览器自动化时积累的经验和教训。

---

## 🧭 抖店后台的坑

### 1. 登录态极其脆弱

- **现象**：抖店后台 session 约 2-4 小时过期，过期后页面自动跳转登录页
- **检测方式**：`browser_snapshot` 后检查是否出现「请登录」/「扫码登录」文字
- **处理**：暂停自动化，通过 `desktop_notify` 通知用户扫码，等待用户确认后继续
- **最佳实践**：每次任务开始先 `browser_navigate` 到抖店首页，做登录态检查

### 2. 页面加载极慢

- **现象**：抖店后台是 SPA，部分页面（如商品列表、订单列表）首次加载需 5-15 秒
- **解决**：
  ```
  browser_navigate(url)
  browser_wait(text="商品管理")  // 等待页面特征文字出现
  browser_wait(time=2000)        // 再加 2 秒确保异步渲染完成
  browser_snapshot()             // 然后再 snapshot
  ```
- **不要**：直接 `browser_snapshot` 刚导航完的页面，可能拿到加载中的骨架屏

### 3. 弹窗地狱

- **现象**：登录后常弹出「活动通知」「规则更新」「功能推荐」等弹窗
- **解决**：
  ```
  // 先 snapshot 看有没有弹窗
  browser_snapshot()
  // 有弹窗 → 找关闭按钮（通常是 × 或「知道了」）
  browser_click(ref="弹窗关闭按钮的ref")
  browser_wait(time=1000)
  // 再次 snapshot 确认弹窗消失
  browser_snapshot()
  ```

### 4. 表格分页与懒加载

- **现象**：商品列表/订单列表默认只显示前 20 条，滚动加载更多
- **解决**：
  ```
  // 方法1：修改 URL 参数 page_size=100
  browser_navigate("https://fxg.jinritemai.com/ffa/m/product/list?page_size=100")
  // 方法2：滚动到底部
  browser_snapshot()
  // 找到表格区域，browser_scroll 到底部
  ```

### 5. 下拉菜单需要 hover

- **现象**：导航栏的「商品」「订单」等菜单需要 hover 才展开子菜单
- **解决**：
  ```
  browser_snapshot()  // 找到导航项的 ref
  browser_hover(ref="导航的ref")
  browser_wait(time=500)
  browser_snapshot()  // 子菜单出现后再 click
  browser_click(ref="子菜单项的ref")
  ```

### 6. 文件上传控件

- **现象**：商品主图/详情图上传用的是自定义上传组件
- **解决**：使用 `browser_upload` 工具直接传文件路径
  ```
  browser_click(ref="上传按钮ref")
  browser_upload(paths=["/path/to/image1.png", "/path/to/image2.png"])
  browser_wait(time=3000)  // 等待上传完成
  browser_snapshot()       // 确认上传成功
  ```

---

## 💚 微信小店后台的坑

### 1. 爱开新标签页

- **现象**：点击某些链接会打开新标签页，自动化在旧标签页上继续操作
- **解决**：
  ```
  browser_click(ref="链接ref")
  browser_wait(time=2000)
  browser_tabs()  // 列出所有标签页
  // 切换到最新标签页
  browser_tabs(action="select", index=-1)
  ```

### 2. 微信扫码登录

- **现象**：微信小店后台只能用微信扫码登录，不支持账密
- **处理流程**：
  1. `browser_navigate("https://store.weixin.qq.com/shop/manage")`
  2. `browser_snapshot()` → 检测到登录页
  3. `browser_take_screenshot()` → 截取二维码
  4. 告知用户：「请用微信扫描截图中的二维码登录」
  5. 等待用户确认后继续

### 3. 表单校验提示不显眼

- **现象**：商品发布表单的校验错误提示文字很小，容易被忽略
- **解决**：提交表单后务必 `browser_snapshot`，检查是否有「请输入」「不能为空」「格式错误」等关键词

---

## 🛡️ 通用反爬对抗

### 频率控制
```
操作间隔规则：
- 页面导航间：≥ 3 秒
- 点击操作间：≥ 1 秒
- 表单输入间：≥ 500ms
- 同一页面不要连续操作超过 50 次
```

### 随机化
```
browser_type 时可以加随机延迟：
- 每个字符间延迟 50-150ms（模拟真人打字）
- 下拉选择时不要总选第一个
- 滚动时不要总滚到底部
```

### 异常检测
```
遇到以下情况立即停止：
- 验证码页面
- 「操作频繁，请稍后再试」
- 「账号存在安全风险」
- 页面跳转到登录页
→ 记录日志，通知用户，等待人工处理
```

---

## 🖼️ Vision 辅助识别

当 DOM 结构复杂或元素无法用 ref 定位时，使用 vision：

```
browser_take_screenshot()
browser_vision(question="这个页面上有没有'审核失败'的状态标签？")
```

适用场景：
- 审核状态识别（通过/失败/审核中）
- 弹窗内容确认
- 表格数据提取（当 DOM 结构过于复杂时）
- 图片验证码识别（配合 OCR）

---

## 📐 推荐的操作模板

### 标准操作序列
```
1. browser_navigate(url)
2. browser_wait(text="关键特征文字", timeout=15000)
3. browser_wait(time=2000)  // 等待异步渲染
4. browser_snapshot()
5. [分析页面，执行操作]
6. browser_take_screenshot()  // 记录操作结果
```

### 标准任务包装
```
1. 检查登录态 → 未登录则引导扫码
2. 关闭弹窗
3. 执行核心操作
4. 截图验证结果
5. 汇总报告
```
