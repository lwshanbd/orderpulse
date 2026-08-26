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

## 预计交付日期和订单任务

当前 Fleet API 真实响应没有 VIN、交付地点、预约时间或预计交付日期；Tesla 公开文档也没有受支持的订单交付详情 endpoint。

Owner 授权实测成功后，Tesla 自有 App 使用的未公开 delivery API 已确认包含以下字段：

- `tasks.scheduling.deliveryWindowDisplay`：预计交付窗口
- `tasks.scheduling.deliveryAppointmentDate`：交付预约日期
- `tasks.scheduling.strings.apptDateTimeStringRange`：适合展示的预约时段
- `tasks.scheduling.appointmentStatusName`：预约状态
- `tasks.scheduling.isValidAppointment`：预约是否有效
- `tasks.scheduling.isEligibleForReschedule`：是否可改期
- `tasks.scheduling.isDeliveryEstimatesEnabled`：是否提供交付预估
- `tasks.finalPayment.data.etaToDeliveryCenter`：到达交付中心的 ETA
- `strings.vin`：Tesla 分配 VIN 后出现

Fleet API 的第三方 token 已实测无法访问该服务。因此 OrderPulse 使用一个独立的个人 Owner PKCE 授权读取这些内容，官方 Fleet 授权仍作为未连接 Owner 时的基础字段后备。Owner 授权不会让 NAS 接触 Tesla 密码或 MFA，也不申请车辆命令权限。

后台只保留经过白名单筛选的交付窗口、预约日期与状态、是否可改期、交付方式/中心、运输 ETA、VIN 是否分配、交付顾问状态以及 Tesla App 任务的简短标题/完成状态。VIN 和车牌先掩码，任务中的自由文本、跳转目标和未知字段全部丢弃。第一次取得详情时只建立静默基线；之后任一白名单交付字段变化才生成可推送事件。

Tesla 在 VIN 或交付预约尚未生成时，偶尔会返回 `##vin##`、`##date##` 一类界面模板。OrderPulse 会把这些模板视为缺失值；只有符合 17 位 VIN 规则的值才算 VIN 已分配，模板也不会触发订单进度或变化提醒。

`/api/order-details/schema` 仍可供管理员检查当前账号实际返回的字段结构，但不会返回字段值。由于这是 Tesla 自有 App 使用的未公开接口，其 URL 和 schema 都可能变化；OrderPulse 会在失败时保留最后一份成功快照，不把接口错误误报成订单变化。
