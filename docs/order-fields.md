# Tesla 订单字段边界

截至 2026-08-25，Tesla Fleet API 官方文档对 `GET /api/1/users/orders` 只承诺“返回用户的活跃订单”，没有公布逐字段 schema。OrderPulse 因此把“官方保证”和“当前真实响应”分开处理，不假定未公开字段永远存在。

## 当前账号真实响应

| 字段 | 当前类型 | OrderPulse 用途 |
| --- | --- | --- |
| `referenceNumber` | string | 生成不可逆 HMAC 订单 ID；数据库只保留末 4 位 |
| `orderStatus` | string | 保存、展示、变化提醒 |
| `orderSubstatus` | string | 保存、展示、变化提醒；目前最有价值的细分状态 |
| `modelCode` | string | 保存、展示 |
| `mktOptions` | string | 标准化后保存；不触发默认提醒 |
| `vehicleMapId` | number | 仅在缺少 reference number 时作为订单身份后备，不向 App 输出 |
| `isUsed` | boolean | 当前不保存；与状态提醒无关 |
| `isB2b` | boolean | 当前不保存；与状态提醒无关 |
| `isTeslaAssistEnabled` | boolean | 当前不保存；与状态提醒无关 |
| `countryCode` | string | 当前不保存；与状态提醒无关 |
| `locale` | string | 当前不保存；与状态提醒无关 |

代码也会安全处理以后可能出现的 `vin`，但本次真实响应没有它。完整 VIN 不写入订单快照。

## 预计交付日期

当前 Fleet API 真实响应没有 VIN、交付地点、预约时间或预计交付日期；Tesla 公开文档也没有受支持的订单交付详情 endpoint。

进一步调查发现，Tesla 自有 App 使用的未公开 delivery API 可能包含以下字段：

- `tasks.scheduling.deliveryWindowDisplay`：预计交付窗口
- `tasks.scheduling.apptDateTimeAddressStr`：交付预约
- `tasks.finalPayment.data.etaToDeliveryCenter`：到达交付中心的 ETA

这些字段不是 Fleet API 合约的一部分，可能随时改变；第三方 Fleet token 也不一定被该服务接受。因此 OrderPulse 只增加管理员手动探测入口 `/api/order-details/schema`，它使用第一笔活跃订单在内存中发起一次请求，并只返回字段路径和类型，不返回完整订单号或任何字段值。探测成功并审阅 schema 之前，后台轮询和 iOS App 都不会依赖该接口。
