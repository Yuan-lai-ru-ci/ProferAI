# 8-Pay / 易支付生产接入与小额验收

> 适用范围：Profer 用户自助充值积分。实现遵循易支付兼容协议：`submit.php` 下单、MD5 签名和异步 `notify_url` 回调。
>
> **安全边界**：本文只包含变量名和验收步骤。商户 PID、KEY、生产数据库或支付截图均不得提交 Git、贴入会话或写入本文件。

## 1. 上线前确认

向支付服务商确认下列兼容性；任何一项不满足，先不要配置生产环境：

- 下单接口为 `{EPAY_API}/submit.php`，接受 `application/x-www-form-urlencoded` POST。
- 支持 `type=wxpay` 和 `type=alipay`。
- 请求字段：`pid`、`type`、`out_trade_no`、`notify_url`、`return_url`、`name`、`money`、`sign_type=MD5`、`sign`。
- 异步回调含 `out_trade_no`、`money`、`trade_status`、`sign`；成功状态为 `TRADE_SUCCESS`。
- MD5 签名规则：排除空值与 `sign` / `sign_type` 后按参数名 ASCII 升序拼接 `k=v`，末尾加 `&key=商户密钥`。
- 服务商可以访问公网 HTTPS 回调地址，并接受纯文本 `success` 作为成功响应。
- 商户类目允许 Profer 的软件服务 / 数字化工具 / 积分充值场景；确认费率、结算周期、退款和风控规则。

## 2. 生产环境变量

在生产服务器 `~/proma-team-server/.env` 写入真实值（不要写入仓库的 `.env.example`）：

```dotenv
# 启用在线充值。未配置完整时服务端会自动退回人工收款模式。
PAY_ON_RECHARGE=1

# 用户能访问、支付服务商也能回调的 Profer 服务端公开根地址；不带路径和尾部斜杠。
PAY_NOTIFY_BASE=https://<你的公开Profer服务域名>

# 8-Pay / 商户后台给出的网关根地址；代码会补 /submit.php。
EPAY_API=https://<支付网关域名>
EPAY_PID=<商户PID>
EPAY_KEY=<商户KEY>
```

Docker Compose 已显式将这五项传给 `proma-team` 容器。服务器不可只修改 `.env` 而不重建/重启容器。

## 3. 部署前检查

在本地仓库根目录：

```bash
cd D:/profer/Profer-main
bun run --filter @profer/electron build:renderer
cd server
JWT_SECRET=<仅本地测试用安全值> bun test src/payment/epay.test.js
JWT_SECRET=<仅本地测试用安全值> node scripts/run-node-tests.mjs
```

部署遵循既有 SOP，使用脚本的 dry-run，不要手工复制 `.env` 或生产数据：

```bash
cd D:/profer/Profer-main
bash server/scripts/deploy-remote.sh
```

脚本同步代码后，会先在远端执行临时容器 dry-run；确认通过后才询问是否正式部署。正式部署前按 `server/scripts/deploy.sh` 的既有流程备份生产数据库和镜像标签。

## 4. 部署后配置检查

1. 在管理后台的「在线充值」配置组确认：启用在线充值、网关、PID、KEY、回调域名均显示为已配置。KEY 页面必须始终脱敏。
2. 访问服务健康检查：`https://<公开Profer服务域名>/health` 应返回成功。
3. 从外网确认下面地址可到达服务器（它对 GET 不是支付验收，只确认域名/反代路径正确）：

   ```text
   https://<公开Profer服务域名>/v1/payment/return
   ```

4. 不要直接用浏览器访问 `/v1/payment/notify` 当作验收；它仅接受签名正确的 POST 回调。

## 5. ¥1 真实支付验收

使用一个测试账号完成一次 **¥1** 充值，默认汇率下预期到账 **10 积分**。

1. 客户端进入「设置 → 订阅」，选择 ¥1 或输入 1。
2. 分别验证微信和支付宝之一；首轮只需要完成一个通道，另一个通道上线当天补测。
3. 确认支付页/二维码成功打开，支付服务商后台出现商户订单。
4. 完成支付，等待客户端轮询自动显示到账；必要时重新打开订阅页刷新余额。
5. 服务端核对：
   - `orders.status`：`pending → paid`；
   - `orders.payment_method`：`online`；
   - `orders.amount_rmb`：100（分）；
   - `users.balance_purchased` 增加 500000 quota，即用户界面显示 10 积分；
   - `credit_transactions` 对该订单 ID 恰有一条 `reference_type='order'` 流水。
6. 在支付服务商后台触发或等待重复通知。订单和余额不得再变化；接口应仍响应 `success`。

## 6. 异常验收与回滚边界

- 易支付下单失败：接口返回 502，订单应立即为 `cancelled`，用户重新发起会生成新订单，不能遗留不可支付的 `pending` 订单。
- 回调金额不匹配、签名不正确、非在线支付订单：返回 `fail`，不增加积分。
- 回调网络故障：服务商会重试；不要人工重复确认已支付订单，`confirmOrder` 的 pending 条件和账本唯一索引会阻止重复到账。
- 若发现异常到账：立刻在管理后台关闭「启用在线充值」或将 `PAY_ON_RECHARGE=0` 后重启容器，使客户端退回人工收款；保留日志和订单 ID 以便对账。

## 7. 当前实现映射

| 职责 | 路径 |
|---|---|
| 易支付下单、MD5 签名 | `server/src/payment/epay.js` |
| 异步回调验签、金额核对、到账 | `server/src/routes/payment.js` |
| 用户充值 API / 订单状态查询 | `server/src/routes/account/credits.js` |
| 订单和三桶账本 | `server/src/db/subscription.js`、`server/src/db/credits.js` |
| 客户端充值 UI | `apps/electron/src/renderer/components/settings/RechargeSection.tsx` |
| 自动化回归 | `server/src/payment/epay.test.js` |
