# 微信小店运营手册

微信小店对小商家友好，**开店即可调用 API**，是自动化运营的首选平台。

---

## 🔑 API 认证

### 获取 access_token

```
POST https://api.weixin.qq.com/cgi-bin/token
  ?grant_type=client_credential
  &appid={APPID}
  &secret={APPSECRET}

响应:
{
  "access_token": "ACCESS_TOKEN",
  "expires_in": 7200
}
```

- Token 有效期 2 小时，需缓存并提前刷新
- AppID/AppSecret 在微信公众平台 → 开发 → 基本配置中获取

### 调用方式

```
POST https://api.weixin.qq.com/channels/ec/product/list/get
  ?access_token={ACCESS_TOKEN}

Body (JSON):
{
  "status": 2,   // 2=上架中
  "page_size": 10,
  "next_key": null
}
```

---

## 📦 商品管理（API 优先）

### 获取商品列表

```
POST /channels/ec/product/list/get
Body: { "status": 2, "page_size": 10, "next_key": null }
// status: 0=全部, 1=草稿, 2=上架, 3=下架, 5=审核中, 6=审核失败
```

### 获取商品详情

```
POST /channels/ec/product/get
Body: { "product_id": "1234567890" }
```

### 新增商品

```
POST /channels/ec/product/add
Body: {
  "out_product_id": "外部商品ID",
  "title": "商品标题",
  "head_imgs": ["https://..."],
  "cats": [{ "cat_id": 1234 }],
  "skus": [{
    "out_sku_id": "SKU001",
    "sale_price": 2990,        // 单位：分
    "stock_num": 100,
    "thumb_img": "https://..."
  }],
  "desc_info": {
    "imgs": ["https://detail1.png", "https://detail2.png"]
  },
  "extra_service": { "seven_day_return": 1 }
}
```

### 上架商品

```
POST /channels/ec/product/listing
Body: { "product_id": "1234567890" }
```

### 下架商品

```
POST /channels/ec/product/delisting
Body: { "product_id": "1234567890" }
```

### 修改价格/库存

```
POST /channels/ec/product/update
Body: {
  "product_id": "1234567890",
  "skus": [{
    "sku_id": "9876543210",
    "sale_price": 2590,
    "stock_num": 200
  }]
}
```

---

## 📋 订单管理

### 获取订单列表

```
POST /channels/ec/order/list/get
Body: {
  "status": 10,       // 10=待发货, 20=已发货, 100=已完成
  "page_size": 20,
  "next_key": null,
  "start_create_time": 1714867200,
  "end_create_time": 1714953599
}
```

### 获取订单详情

```
POST /channels/ec/order/get
Body: { "order_id": "1234567890" }
```

### 订单发货

```
POST /channels/ec/order/delivery/send
Body: {
  "order_id": "1234567890",
  "delivery_list": [{
    "delivery_id": "YT1234567890",    // 快递单号
    "waybill_id": "SF123456",          // 运单号
    "deliver_type": 1                   // 1=快递
  }]
}
```

---

## 🔧 售后管理

### 获取售后列表

```
POST /channels/ec/aftersale/getaftersalelist
Body: {
  "status": "USER_WAIT_RETURN",
  "page_size": 20,
  "next_key": null
}
```

### 同意售后（退款/退货）

```
POST /channels/ec/aftersale/acceptapply
Body: { "after_sale_order_id": "1234567890" }
```

### 拒绝售后

```
POST /channels/ec/aftersale/rejectapply
Body: {
  "after_sale_order_id": "1234567890",
  "reject_reason": "商品已使用，影响二次销售"
}
```

---

## 🌐 浏览器自动化兜底

以下场景用浏览器自动化（Web 端后台）：

### 场景一：批量修改物流模板
- API 不支持批量修改物流模板
- 浏览器操作：`store.weixin.qq.com/shop/product/list` → 勾选商品 → 批量设置运费模板

### 场景二：查看商品审核驳回原因
- API 返回的审核失败原因可能不完整
- 浏览器操作：进入商品详情页 → 截图 → vision 分析驳回具体原因

### 场景三：店铺装修/页面管理
- 无对应 API
- 浏览器操作：进入店铺装修页面操作

### 场景四：营销活动设置
- 优惠券、秒杀等活动通常无 API 或 API 不完善
- 浏览器操作兜底

---

## 📊 每日巡检清单

```
☐ 商品状态检查
   - 获取商品列表，检查 status=6(审核失败) 的商品
   - 处理审核失败：查看原因 → 修改 → 重新提交

☐ 订单处理
   - 获取 status=10(待发货) 的订单
   - 确认库存 → 打单发货

☐ 售后处理
   - 获取待处理的售后单
   - 按情况处理：同意退款 / 同意退货 / 拒绝

☐ 库存预警
   - 获取商品列表，检查 stock < 10 的商品
   - 提醒补货

☐ 数据汇总
   - 当日订单数、成交金额
   - 售后率、退款金额
```

---

## 🧩 与 super-agent 的衔接

### 推荐工具选择

| 操作 | 首选工具 | 备选 |
|------|----------|------|
| 获取商品列表 | `web` (HTTP API) | `browser` |
| 上架/下架 | `web` (HTTP API) | `browser` |
| 修改价格/库存 | `web` (HTTP API) | `browser` |
| 订单发货 | `web` (HTTP API) | `browser` |
| 批量操作 | `browser` | - |
| 店铺装修 | `browser` | - |
| 审核原因查看 | `browser` + `vision` | - |

### API 调用示例（super-agent web 工具）

```
web_post(
  url="https://api.weixin.qq.com/channels/ec/product/list/get?access_token=TOKEN",
  body={ "status": 2, "page_size": 10 }
)
```
