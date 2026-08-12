# Profer Team Server 部署参数

生产部署必须显式配置的安全/容量参数（2026-08-08 质检修复后基线）。

## 必配

| 变量 | 值 | 说明 |
|---|---|---|
| `JWT_SECRET` | ≥32 字符随机串 | 缺失时进程 `process.exit(1)` 拒绝启动。生成：`node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `TRUST_PROXY` | `1`（仅 nginx 反代部署） | 信任 X-Forwarded-For / X-Real-IP。**直连部署必须保持未设置**——否则攻击者可伪造 XFF 绕过限流/审计（clientIP 将直连取 socket 真实对端，见 `server/src/utils.js`）。 |

## 按需

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEFAULT_BODY_SIZE` | 1048576 (1MB) | 普通端点（登录/注册/反馈等未认证或轻量接口）JSON 请求体上限。50MB（`MAX_BODY_SIZE`）仅对 `/v1/proxy/*` 放开 |
| `MAX_BODY_SIZE` | 52428800 (50MB) | 多模态转发路由的请求体上限 |
| `COMMERCIAL_MODE` | `false` | `true` 时必须同时设置 `CHANNEL_ENCRYPTION_KEY`（64 hex），否则启动即退出 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 内置默认 | 生产请显式覆盖 |
| `DATA_DIR` / `DB_PATH` | `.` | Docker 下指向 volume 挂载点 |

## 安全模型要点

- **refresh/relay 令牌哈希化**（2026-08-08 起）：库中只存 sha256(token)，明文仅存在于响应与内存；存量明文行由 `IN (hash, plain)` 双匹配平滑兼容，随客户端轮换自然消亡，无需迁移操作。
- **限流键**：`/refresh` 60s/30 次、激活码/注册等按 IP。直连部署无需额外配置；反代部署必须 `TRUST_PROXY=1`，否则全部流量共享反代 IP 的限流桶。
- **服务端测试门禁**：`node scripts/run-node-tests.mjs`（node:test，33 个用例，收集规则 `*.node.test.mjs`）；bun 回归 `bun test --isolate`。
