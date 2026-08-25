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

当前真实响应没有 VIN、交付地点、预约时间或预计交付日期；Tesla 公开 Fleet API 文档也没有另一个订单交付日期 endpoint。因此 OrderPulse 目前无法通过受支持的官方 API 提供预计交付日期。

一些第三方产品可能使用 Tesla 网站或 App 的未公开账号接口。OrderPulse 默认不采用这种方案：它可能随时变更，并扩大账号凭证与服务条款风险。如果将来官方 orders 响应新增日期字段，可先用管理员接口 `/api/orders/schema` 只查看字段路径和类型，再显式加入白名单；该接口不会返回字段值。
