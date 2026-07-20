# Paperpipe Bridge 部署与验收

## 运行边界

Profer Team Server 在 Docker 中运行，Bridge 作为宿主机的私有服务运行：

```text
Desktop Client → Profer Server → paperpipe Bridge → papi
```

Bridge 不得暴露到公网。Profer Server 通过 `PAPERPIPE_BRIDGE_URL` 访问 Bridge，并在每次请求发送 `X-Paperpipe-Internal-Key`。Bridge 必须在处理任何业务路径前，以常量时间比较方式校验该 header；缺失或不匹配必须返回 `401` 或 `403`，且不读取/创建用户论文数据。

Bridge 必须提供无副作用的 `GET /health`：不要求 `X-User-Id`、不创建默认用户、不会返回任意用户资料，只返回健康状态。

## 配置

在 `server/.env` 设置：

```bash
PAPERPIPE_BRIDGE_URL=http://host.docker.internal:9876
PAPERPIPE_BRIDGE_SECRET=<32-byte-random-hex>
PAPERPIPE_MAX_FILE_SIZE=52428800
PAPERPIPE_MAX_BODY_SIZE=53477376
```

`docker-compose.yml` 已声明 `host.docker.internal:host-gateway`，适用于 Linux Docker。若 Bridge 在独立容器/主机，直接将 `PAPERPIPE_BRIDGE_URL` 改为该内部地址；不要依赖默认地址。

应用生产配置后先执行：

```bash
cd server
docker compose config
docker compose up -d --build
docker compose exec proma-team node -e "fetch(process.env.PAPERPIPE_BRIDGE_URL + '/health', {headers:{'X-Paperpipe-Internal-Key':process.env.PAPERPIPE_BRIDGE_SECRET}}).then(async r=>{console.log(r.status, await r.text()); process.exit(r.ok?0:1)}).catch(e=>{console.error(e);process.exit(1)})"
```

还必须单独验证错误密钥被 Bridge 拒绝：

```bash
curl -i -H 'X-Paperpipe-Internal-Key: wrong-key' http://127.0.0.1:9876/health
```

期望 `401` 或 `403`。如果返回 `200`，不得上线。

## 生产同构 E2E

禁止用管理员或真实团队数据执行。优先在已授权的生产同构宿主机运行一次性账号脚本；只有显式确认开关才会创建账号，退出时会回收 Bridge 目录，并按外键顺序删除 `audit_logs`、`credit_transactions`、`refresh_tokens`、`credits`、`invite_codes` 和用户记录：

```bash
PAPERPIPE_E2E_CREATE_TEST_ACCOUNT=1 \
PROFER_API_URL=http://127.0.0.1:3456 \
PAPERPIPE_TEST_ARXIV_ID=2306.05427 \
bash server/scripts/paperpipe-disposable-e2e.sh
```

脚本依次执行：health、arXiv add、list、search、show、remove。清理失败会以非零状态退出并输出用户 ID/邮箱，必须先完成回收再继续。

如测试账号已由受控平台预先创建，也可使用低层脚本：

```bash
PROFER_API_URL=https://your-domain.example/proma \
PROFER_TEST_TOKEN=<test-user-token> \
PAPERPIPE_TEST_ARXIV_ID=2306.05427 \
node server/scripts/paperpipe-e2e.mjs
```

## PDF 与故障矩阵

当前客户端和 Server 上传路径都会完整缓冲 PDF。生产起始上限为 **50MB**，在完成流式 multipart 转发前不得上调。手动验证以下场景：

| 场景 | 期望 |
|---|---|
| 1MB 有效 PDF | 上传、搜索、读取、删除成功 |
| 50MB 有效 PDF | 不超过超时；记录客户端与容器 RSS |
| 超过 50MB | `413` + `PAPERPIPE_BODY_TOO_LARGE` 或 `PAPERPIPE_FILE_TOO_LARGE` |
| 非 PDF / 错误 magic bytes | `415` + `PAPERPIPE_INVALID_PDF` |
| 两个并发 PDF 上传 | 无容器 OOM、无用户间数据混淆 |
| Bridge 停止 | Server 稳定返回 `502` 或 `504`，客户端保留本地论文 |
| Bridge 删除失败 | 客户端不得删除本地论文；提示可重试 |
| 错误内部密钥 | Bridge 拒绝，Server 不泄露内部 URL 或密钥 |

每次验收记录：PDF 大小、上传/解析耗时、Electron RSS、Server RSS、Bridge 时延、413/502/504 数量和最终远端 ID。

## 上线前检查

- [ ] `PAPERPIPE_BRIDGE_SECRET` 已配置，且 Bridge 强制校验。
- [ ] `docker compose config` 通过；容器可访问 Bridge health。
- [ ] 错误密钥返回 401/403。
- [ ] arXiv E2E 脚本通过且测试论文已删除。
- [ ] PDF 矩阵完成，50MB 和并发场景没有 OOM。
- [ ] Bridge 断连返回可读 502/504，客户端本地回退可用。
- [ ] 已记录监控阈值：Bridge 可用性、上传耗时、同步失败率和容器内存。
