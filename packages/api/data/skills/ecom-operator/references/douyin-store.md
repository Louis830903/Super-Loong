# 抖店运营手册

抖音小店 API 对小商家门槛较高（需要软著等），因此**主要靠浏览器自动化**操作后台。

---

## ⚠️ 重要前置条件

### API 不可用时的替代方案

抖店开放平台自研应用需要：
- 软件著作权证书（且著作权人必须和开发者账号主体一致）
- 系统功能说明书
- 源代码片段
- 系统架构说明

**小商家通常难以满足上述条件**，因此以浏览器自动化为主要手段。

### 登录流程

```
1. browser_navigate("https://fxg.jinritemai.com/")
2. browser_snapshot()
3. 检测登录方式：
   - 已登录 → 直接进入后台
   - 扫码登录页 → 截图 → 用户扫码
   - 账密登录页 → 可尝试自动填写（如果有账密）
4. 登录成功后关闭弹窗
```

---

## 📦 商品管理

### 发布商品

#### 步骤 1：进入发布页
```
browser_navigate("https://fxg.jinritemai.com/ffa/m/product/list")
browser_wait(text="发布商品", timeout=10000)
browser_click(ref="发布商品按钮ref")
browser_wait(time=3000)
```

#### 步骤 2：填写商品信息
```
browser_snapshot()  // 获取表单结构

// 选择类目
browser_click(ref="类目选择器ref")
browser_wait(time=1000)
browser_snapshot()  // 获取类目列表
browser_click(ref="目标类目ref")

// 填写标题
browser_type(ref="标题输入框ref", text="商品标题(30字以内)")

// 上传主图（5张）
browser_click(ref="主图上传区域ref")
browser_upload(paths=["/path/to/img1.png", ..., "/path/to/img5.png"])
browser_wait(time=5000)

// 上传详情图
browser_click(ref="详情图上传区域ref")
browser_upload(paths=["/path/to/detail1.png", ...])

// 填写价格
browser_type(ref="价格输入框ref", text="29.90")

// 填写库存
browser_type(ref="库存输入框ref", text="100")

// 选择运费模板
browser_click(ref="运费模板下拉ref")
browser_click(ref="包邮ref")  // 或选择对应模板
```

#### 步骤 3：提交审核
```
browser_click(ref="提交按钮ref")
browser_wait(time=5000)
browser_snapshot()

// 检查提交结果
// 成功 → 截图记录
// 失败 → 检查校验错误提示，修正后重试
```

### 商品上下架

#### 批量下架
```
browser_navigate("https://fxg.jinritemai.com/ffa/m/product/list")
browser_wait(text="商品管理", timeout=10000)

// 关闭弹窗
browser_snapshot()
// 如有弹窗，先关闭

// 勾选需要下架的商品
browser_click(ref="商品1复选框ref")
browser_click(ref="商品2复选框ref")

// 点击批量下架
browser_click(ref="批量下架按钮ref")
browser_wait(time=2000)

// 确认弹窗
browser_snapshot()
browser_click(ref="确认按钮ref")
browser_wait(time=3000)

// 验证结果
browser_snapshot()
browser_take_screenshot()
```

### 修改价格
```
browser_navigate("https://fxg.jinritemai.com/ffa/m/product/list")
// 找到目标商品
// 点击「编辑」或直接点击价格区域
browser_click(ref="商品编辑按钮ref")
browser_wait(time=3000)

// 修改价格
browser_snapshot()
browser_type(ref="价格输入框ref", text="新价格")

// 保存
browser_click(ref="保存按钮ref")
browser_wait(time=3000)
browser_snapshot()  // 验证
```

---

## 📋 订单管理

### 查看待发货订单
```
browser_navigate("https://fxg.jinritemai.com/ffa/m/order/list")
browser_wait(text="订单管理", timeout=10000)
browser_snapshot()

// 筛选待发货
browser_click(ref="订单状态筛选ref")
browser_click(ref="待发货ref")
browser_wait(time=3000)
browser_snapshot()

// 提取订单信息：
// - 订单号
// - 商品名称 & SKU
// - 收货人、地址、电话
// - 下单时间
```

### 发货操作
```
// 方法1：单个发货
browser_click(ref="发货按钮ref")
browser_wait(time=2000)
browser_snapshot()
browser_type(ref="快递单号输入框ref", text="YT1234567890")
browser_click(ref="确认发货ref")

// 方法2：使用电子面单
// 需配合快递公司的电子面单系统
// 一般是：选择快递公司 → 自动获取单号 → 打印面单 → 确认发货
```

### 批量导出订单
```
// 用于数据分析或对接第三方物流
browser_click(ref="导出按钮ref")
browser_wait(time=5000)
// 导出文件在浏览器下载目录
```

---

## 🔧 售后管理

### 查看售后单
```
browser_navigate("https://fxg.jinritemai.com/ffa/m/aftersale/list")
browser_wait(text="售后管理", timeout=10000)
browser_snapshot()

// 常见的售后类型：
// - 仅退款（未发货）
// - 退货退款（已发货）
// - 换货
// - 补发
```

### 处理退款
```
// 根据售后类型处理：
// 仅退款 → 先检查是否已发货
//   未发货 → 同意退款
//   已发货 → 联系买家确认拦截
// 退货退款 → 同意退货 → 等待买家寄回 → 确认收货 → 退款

browser_click(ref="处理按钮ref")
browser_wait(time=2000)
browser_snapshot()

// 同意退款
browser_click(ref="同意退款ref")

// 或拒绝
browser_click(ref="拒绝ref")
browser_type(ref="拒绝原因ref", text="拒绝原因说明")
browser_click(ref="确认ref")
```

---

## 📊 每日巡检（抖店版）

```
☐ 登录态检查
   - browser_navigate → 首页
   - 检查是否已登录，未登录则扫码

☐ 关闭弹窗
   - snapshot → 检查弹窗 → 关闭

☐ 商品审核状态
   - 商品列表 → 检查审核失败/违规下架的商品
   - >5个审核失败 → 重点排查

☐ 订单处理
   - 订单列表 → 筛选待发货
   - 超24小时未发货 → 优先处理

☐ 售后处理
   - 售后列表 → 待处理
   - 超时未处理会影响店铺评分

☐ 评价管理
   - 检查差评 → 48小时内回复
   - 好评率 < 95% → 异常预警

☐ 违规检查
   - 消息中心 → 查看违规通知
   - 及时申诉/整改

☐ 数据简报
   - 今日订单数、成交额
   - 退款率、退款金额
   - 商品浏览量、转化率
```

---

## 🏪 商机中心（选品核心）

抖店的商机中心可以看到平台热搜品类：

```
browser_navigate("https://fxg.jinritemai.com/ffa/m/business-opportunity")
browser_wait(time=5000)
browser_snapshot()

// 关注指标：
// - 搜索热度：近期搜索趋势
// - 竞争度：同行商家数量
// - 成交指数：实际成交规模
// - 蓝海指数：机会程度

// 选品策略：
// 蓝海指数高 + 竞争度低 = 优先考虑
// 搜索热度上升趋势 + 自身有货源 = 重点跟进
```

---

## 🤖 自动回复设置

抖店支持设置自动回复机器人（无需 API）：

```
browser_navigate("https://fxg.jinritemai.com/ffa/m/customer-service/settings")
browser_wait(time=5000)

// 设置项：
// - 欢迎语：买家首次咨询时的自动回复
// - 常见问题：预设 Q&A 自动匹配
// - 发货提醒：发货后自动发送物流信息
// - 售后引导：售后关键词触发引导流程
```

---

## 🧩 与 super-agent 的衔接

抖店日常操作全部走浏览器自动化，核心流程：

```
操作类型          工具             备注
──────────────────────────────────────────
页面导航          browser_navigate  抖店 SPA 注意等待
元素定位          browser_snapshot  先 snapshot 再操作
表单填写          browser_type      加点随机延迟
文件上传          browser_upload     图片/视频素材
状态识别          browser_vision    审核结果、弹窗内容
登录辅助          desktop 工具集    扫码、通知
数据提取          snapshot + 分析   从页面 DOM 提取数据
```

### 抖店操作黄金法则

1. **加载慢是常态**，browser_wait 至少给 5 秒，关键页面给 10 秒
2. **弹窗是日常**，每次 snapshot 后都检查一次弹窗
3. **登录态每天掉一次**，早晨第一件事就是登录
4. **操作后必截图**，所有修改操作都留记录
5. **频率控制**，同一页操作不超过 20 次/分钟
