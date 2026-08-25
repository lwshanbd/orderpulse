# OrderPulse Service

这是运行在 NAS 上的 OrderPulse 后台：完成 Tesla 用户 OAuth、加密保存和自动刷新 token、读取订单、建立隐私安全的状态快照，并记录可供后续 APNs 使用的变化事件。APNs 与 iOS 客户端仍属于下一阶段。

## 已实现

- `GET /healthz`：公开健康检查。
- `GET /.well-known/appspecific/com.tesla.3p.public-key.pem`：继续提供 Tesla 已登记的公钥。
- `GET /oauth/tesla/start`：管理员登录后开始 Tesla 授权。
- `GET /oauth/tesla/callback`：Tesla 回调；校验一次性 state、OIDC issuer/audience/nonce。
- `GET /api/status`：只返回授权是否存在、有效期、scope 和 Fleet 区域。
- `GET /api/orders`：立即调用 Tesla、更新快照，并只返回脱敏订单。这个请求可能产生 Tesla 计费使用量。
- `GET /api/orders/schema`：返回原始响应的字段路径和数据类型，不返回字段值。这个接口用于第一次适配真实 Tesla 响应。
- `GET /api/order-state`：只读 SQLite 中的最新快照，不调用 Tesla。
- `GET /api/events?limit=50`：只读状态变化历史，不调用 Tesla。
- `GET /api/polling/status`：返回调度配置、下次运行时间和最近一次结果。
- `POST /api/polling/run`：手动执行一次查询与变化检测。
- `DELETE /api/authorization`：删除 NAS 上保存的 Tesla 授权。

除健康检查、公钥和 Tesla 回调外，所有接口都受 HTTPS Basic Auth 保护。

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
- `orderStatus` 或 `orderSubstatus` 变化时创建一次 `status_changed`。
- 配置代码变化会记录 `configuration_changed`，但默认不用于推送。
- active orders 列表连续三次没有某个订单后才创建 `order_inactive`，避免把短暂空响应误判为交付或取消。
- inactive 订单重新出现时创建 `order_reappeared`。
- 查询失败只记录安全错误码，不修改订单快照，也不会制造事件。
- 同一进程中的并发手动/定时查询会共享一次 Tesla 请求。

正常订单查询不再重复调用 `/users/region`；区域只在 OAuth 时检测，或 Tesla 明确返回区域错误时重新检测。401 会刷新 rotating refresh token 并只重试一次。

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
    └── tesla_client_secret.txt
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

## 启用定时轮询

Tesla Fleet API 按使用量计费，所有低于 HTTP 500 的请求通常都会计入使用量。先在 Tesla Developer Dashboard 设置支付方式、较低的 Billing Limit，并查看当前 pricing category。OrderPulse 默认关闭后台轮询，避免一次部署意外产生持续费用。

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

再执行 `docker compose up -d`。默认每 30 分钟查询一次，并加入最多 60 秒随机抖动；失败时指数退避，最长六小时，Tesla 返回 `Retry-After` 时也会遵守。可以通过 `/api/polling/status` 检查运行情况。

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

## 第一次真实授权

浏览器打开：

`https://orderpulse.baodishan.com/oauth/tesla/start`

输入 `orderpulse` 和 `admin_password.txt` 中的密码，登录 Tesla 并同意四项 scope。成功页面出现后，再用相同 Basic Auth 访问：

- `https://orderpulse.baodishan.com/api/status`
- `https://orderpulse.baodishan.com/api/orders`
- `https://orderpulse.baodishan.com/api/orders/schema`

请只把 `/api/orders/schema` 的输出发给开发端；不要发送 OAuth callback URL、Client Secret、数据库、完整 `/api/orders` 原始响应、access token 或 refresh token。`schema` 只有字段名和类型，适合下一步设计订单状态快照和 APNs 提醒。

## 备份与恢复

必须把 `data/orderpulse.sqlite` 和 `secrets/token_encryption_key.txt` 当成一组备份。恢复数据库却丢失旧加密密钥会导致 token 永久无法解密，只能删除数据库并重新进行 Tesla 授权。
