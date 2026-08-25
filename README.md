# OrderPulse Service

这是运行在 NAS 上的 OrderPulse 后台和配套 iOS App：读取你自己的 Tesla 订单及交付详情、建立隐私安全的状态快照，并把状态变化通过 APNs 发到已配对的 iPhone。所有功能只围绕实际订单，不包含社区预测或其他用户数据。

## 已实现

- `GET /healthz`：公开健康检查。
- `GET /.well-known/appspecific/com.tesla.3p.public-key.pem`：继续提供 Tesla 已登记的公钥。
- `GET /oauth/tesla/start`：管理员登录后开始 Tesla 授权。
- `GET /oauth/tesla/callback`：Tesla 回调；校验一次性 state、OIDC issuer/audience/nonce。
- `GET /oauth/owner/start`：管理员开始个人 Owner PKCE 授权，用于读取 Tesla 自有 App 的交付详情。
- `POST /oauth/owner/complete`：提交 Tesla 最终回调地址；校验一次性 state 后加密保存 Owner token。
- `GET /api/status`：只返回两套授权是否存在、有效期、scope 和 Fleet 区域。
- `GET /api/orders`：立即调用 Tesla、更新快照，并只返回脱敏订单；已连接 Owner 时同时读取交付详情。
- `GET /api/orders/schema`：返回原始响应的字段路径和数据类型，不返回字段值。这个接口用于第一次适配真实 Tesla 响应。
- `GET /api/order-details/schema`：使用 Owner 授权检查 Tesla 未公开 delivery API 的字段结构，只返回路径和类型，不返回订单值。
- `GET /api/order-state`：只读 SQLite 中的最新快照，不调用 Tesla。
- `GET /api/events?limit=50`：只读状态变化历史，不调用 Tesla。
- `GET /api/polling/status`：返回调度配置、下次运行时间和最近一次结果。
- `POST /api/polling/run`：手动执行一次查询与变化检测。
- `DELETE /api/authorization`：删除 NAS 上保存的 Tesla 授权。
- `DELETE /api/owner-authorization`：删除 NAS 上保存的个人 Owner 授权。
- `POST /api/devices/pairing-code`：管理员生成 1 小时有效、只能使用一次的 iPhone 配对码。
- `GET /api/devices`：管理员查看已配对设备和推送状态，不返回设备凭证或 APNs token。
- `DELETE /api/devices/:id`：管理员撤销一台设备。
- `POST /api/devices/:id/test-notification`：管理员向一台已注册设备发送 APNs 测试提醒。
- `POST /api/mobile/pair`：iOS App 用一次性配对码换取独立设备凭证。
- `GET /api/mobile/bootstrap`：iOS App 读取快照、事件和轮询状态，不调用 Tesla。
- `PUT /api/mobile/device-token`：已配对设备上传最新 APNs token。
- `DELETE /api/mobile/device`：iOS App 撤销自己的设备凭证。

管理接口受 HTTPS Basic Auth 保护；移动端接口使用每台设备独立的 Bearer 凭证。App 不保存管理员密码或任何 Tesla token。两套 Tesla token 都经 AES-256-GCM 加密保存在 NAS；设备凭证只保存在 iOS Keychain，NAS 只保存它的 HMAC，APNs device token 也加密保存。

Tesla 当前订单字段与预计交付日期的边界见 [`docs/order-fields.md`](docs/order-fields.md)。

## Tesla Developer Portal

OrderPulse 应用应保持以下设置：

- OAuth Grant Type：`Authorization Code and Machine-to-Machine`
- Allowed Origin URL：`https://orderpulse.baodishan.com`
- Allowed Redirect URI：`https://orderpulse.baodishan.com/oauth/tesla/callback`
- Allowed Returned URL：目前留空
- 用户授权 scopes：`openid offline_access user_data vehicle_device_data`

Partner Account 已经注册成功，不需要因为这个 Service 再注册一次，也不需要车辆命令证书。真实验证表明订单读取需要 `vehicle_device_data`；仍不申请 `vehicle_cmds`、`vehicle_location` 等无关权限。

## 本地验证

需要 Node.js 24 或更新版本：

```sh
npm ci
npm run check
npm test
npm run build
```

开发环境可以复制 `.env.example` 为 `.env`，但本项目不会自动加载 `.env`。启动前需由 shell 或开发工具显式载入环境变量。不要在生产 NAS 使用直接的 secret 环境变量。

## 状态变化规则

- 完整 RN 永远不写入快照表。`orderId` 是用独立派生密钥计算的 HMAC，界面只得到 RN 末 4 位。
- 第一次成功查询创建 `baseline_created`，不具备通知资格。
- 从 Fleet 基础字段升级到 Owner 交付详情时只补充静默基线，不制造提醒。
- `orderStatus` 或 `orderSubstatus` 变化时创建一次 `status_changed`。
- 交付窗口、预约、VIN 分配、交付地点/方式、顾问或 App 任务等白名单详情变化时创建可推送的 `configuration_changed`；普通车型配置变化仍只记录、不推送。
- active orders 列表连续三次没有某个订单后才创建 `order_inactive`，避免把短暂空响应误判为交付或取消。
- inactive 订单重新出现时创建 `order_reappeared`。
- 查询失败只记录安全错误码，不修改订单快照，也不会制造事件。
- 同一进程中的并发手动/定时查询会共享一次 Tesla 请求。

已连接 Owner 时，每轮先读取一次活跃订单，再按订单顺序读取详情，避免并发放大 429；401 会刷新 Owner refresh token 并只重试一次。未连接 Owner 时仍使用官方 Fleet 订单接口作为基础字段后备。Fleet 查询不再重复调用 `/users/region`；区域只在 OAuth 时检测，或 Tesla 明确返回区域错误时重新检测。

## NAS 部署目录

建议将本目录复制到 NAS 的 `/volume1/docker/orderpulse`。需要保留如下结构：

```text
orderpulse/
├── compose.yaml
├── Dockerfile
├── data/                         # SQLite，容器可写
├── public/
│   └── .well-known/appspecific/
│       └── com.tesla.3p.public-key.pem
└── secrets/
    ├── admin_password.txt
    ├── token_encryption_key.txt
    ├── tesla_client_id.txt
    ├── tesla_client_secret.txt
    └── apns_private_key.p8        # 启用推送时才需要
```

把 NAS 当前已经通过公网验证的同一份 Tesla 公钥放入上述 `public` 路径。不要生成新的公钥，否则会和已注册指纹不一致。

四个 secret 文件都只放一行、不要加引号：

- `admin_password.txt`：为管理接口新建一个至少 20 位的随机密码。
- `token_encryption_key.txt`：运行 `openssl rand -base64 32` 生成一次；之后必须长期保留。
- `tesla_client_id.txt`：Tesla 提供的 Client ID。
- `tesla_client_secret.txt`：Tesla 提供的 Client Secret。

限制宿主机文件权限，并确认 Docker 仍能读取：

```sh
cd /volume1/docker/orderpulse
mkdir -p data secrets public/.well-known/appspecific
chmod 700 secrets
chmod 644 secrets/*.txt
sudo chown -R 1000:1000 data
docker compose build --pull
docker compose up -d
docker compose ps
```

`secrets` 目录本身为 mode 700，因此其他 NAS 用户无法遍历；文件使用 mode 644 是为了让容器内的非 root 用户能够读取 Docker Compose 的只读 secret bind mount。若 NAS 上该目录不属于当前管理员，请用 DSM ACL 达到同样效果。`data` 需要由镜像内 UID 1000 的非 root 用户写入。如果你的 NAS 已占用 UID 1000 或不允许这样设置，改用 DSM ACL 给该 UID 对 `data` 的读写权限，不要把容器改为 root，也不要把 secret 改成环境变量。

## iPhone 配对

部署后用管理员 Basic Auth 生成一次性配对码：

```sh
curl -u orderpulse -X POST https://orderpulse.baodishan.com/api/devices/pairing-code
```

在 OrderPulse App 输入返回的 `code`。配对码 1 小时后失效且只能用一次；它只负责首次交换设备凭证。换到的设备凭证没有 1 小时限制，会一直保存在 iOS Keychain，直到用户解除配对或管理员撤销设备。App 下拉刷新只读取 NAS 已有快照，不会额外请求 Tesla；Tesla 的调用频率仍完全由 NAS 轮询器控制。

## Apple Push Notifications

在 Apple Developer 后台为 App ID `com.baodishan.orderpulse` 启用 Push Notifications，再创建一枚 APNs signing key 并只下载一次 `.p8` 私钥。把文件保存为 NAS 的 `secrets/apns_private_key.p8`，不要提交 Git。

开发阶段在部署目录的 `.env` 使用：

```text
APNS_ENABLED=true
APNS_ENVIRONMENT=sandbox
APNS_KEY_ID=你的_Key_ID
APNS_TEAM_ID=你的_Team_ID
APNS_TOPIC=com.baodishan.orderpulse
```

TestFlight/App Store 构建应把 NAS 改为 `APNS_ENVIRONMENT=production` 后重启服务。新式 environment-specific APNs key 也必须选择对应环境。Provider JWT 每 50 分钟更新；无效或已注销的 device token 会停止重试，临时错误最多重试五次并指数退避。

## iOS 工程

工程位于 `ios/OrderPulse.xcodeproj`，最低支持 iOS 17，Bundle ID 为 `com.baodishan.orderpulse`。首次真机运行前在 Xcode 的 Signing & Capabilities 选择你的 Apple Developer Team，并确认 Push Notifications capability 生效。

如需重新生成工程：

```sh
cd ios
xcodegen generate --spec project.yml
```

## 启用定时轮询

Tesla Fleet API 按使用量计费，所有低于 HTTP 500 的请求通常都会计入使用量。先在 Tesla Developer Dashboard 设置支付方式、较低的 Billing Limit，并查看当前 pricing category。Owner 详情接口本身未公开，也应保持低频。OrderPulse 默认关闭后台轮询，避免部署后意外持续调用。

部署新版本后，先手动建立基线；`curl -u orderpulse` 会交互式询问密码，不要把密码写进命令参数：

```sh
curl -u orderpulse -X POST https://orderpulse.baodishan.com/api/polling/run
curl -u orderpulse https://orderpulse.baodishan.com/api/order-state
curl -u orderpulse https://orderpulse.baodishan.com/api/events
```

确认第一条事件为 `baseline_created` 且 `notificationEligible=false` 后，在部署目录创建一个不提交 Git 的 `.env`：

```text
ORDER_POLLING_ENABLED=true
ORDER_POLL_INTERVAL_SECONDS=1800
ORDER_POLL_JITTER_SECONDS=60
ORDER_MISSING_THRESHOLD=3
```

再执行 `docker compose up -d`。默认每 30 分钟查询一次，并加入最多 60 秒随机抖动；失败时指数退避，最长六小时，Tesla 返回 `Retry-After` 时也会遵守。一次 Owner 轮询会产生一次订单请求和每笔活跃订单一次详情请求，这些请求按顺序发送。可以通过 `/api/polling/status` 检查运行情况。

## Synology 反向代理

保留现有 `orderpulse.baodishan.com` 证书和域名规则，将目标改为：

- 来源：`HTTPS` / `orderpulse.baodishan.com` / `443`
- 目标：`HTTP` / `127.0.0.1` / `8787`

路由器不要转发 8787，compose 也只将它绑定到 NAS 的 `127.0.0.1`。当前占用该域名的 placeholder 服务需要先停止或改名，反向代理规则只指向新的 OrderPulse 容器。

部署后依次检查：

```sh
curl -fsS https://orderpulse.baodishan.com/healthz
curl -fsS https://orderpulse.baodishan.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

预期第一个响应是 `{"status":"ok"}`，第二个仍是已经向 Tesla 注册的 P-256 公钥。

## 第一次 Fleet 授权

浏览器打开：

`https://orderpulse.baodishan.com/oauth/tesla/start`

输入 `orderpulse` 和 `admin_password.txt` 中的密码，登录 Tesla 并同意四项 scope。成功页面出现后，再用相同 Basic Auth 访问：

- `https://orderpulse.baodishan.com/api/status`
- `https://orderpulse.baodishan.com/api/orders`
- `https://orderpulse.baodishan.com/api/orders/schema`

不要发送 OAuth callback URL、Client Secret、数据库、完整 `/api/orders` 原始响应、access token 或 refresh token。

## 连接个人订单详情

Fleet 授权可以读取基础订单状态，但预计交付窗口等信息位于 Tesla 自有 App 使用的另一套未公开接口。个人自用部署可再打开：

`https://orderpulse.baodishan.com/oauth/owner/start`

输入管理员 Basic Auth 后，按页面说明在 Tesla 官方页面登录。Tesla 最后会停在空白页；把地址栏中以 `https://auth.tesla.com/void/callback` 开头的完整地址复制回 OrderPulse 页面提交。这个流程可在一小时内完成；NAS 只接收一次性授权码，不会看到 Tesla 密码或 MFA。

成功后检查 `/api/status` 的 `ownerAuthorized` 为 `true`，然后手动执行一次 `/api/polling/run`。第一次只建立交付详情基线，不推送；此后交付窗口、预约、VIN 分配、地点、顾问和 Tesla App 任务状态发生变化才提醒。iOS App 会直接显示这些字段。

这套 Owner 接口不是 Tesla Fleet API 的正式合约，Tesla 将来可能修改或关闭它。OrderPulse 对 Owner 登录和查询使用 HTTP/2，固定只向 Tesla 域名发送请求，并且查询阶段只有 GET；只保存白名单字段，请求失败时保留最后一次成功快照，不会伪造状态变化。

## 备份与恢复

必须把 `data/orderpulse.sqlite` 和 `secrets/token_encryption_key.txt` 当成一组备份。恢复数据库却丢失旧加密密钥会导致 token 永久无法解密，只能删除数据库并重新进行 Tesla 授权。
