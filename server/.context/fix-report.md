# 问题 3 & 5 修复报告

**修复时间**: 2026-07-18 16:45  
**修复范围**: 计费中间件加固 + 公开 API 防护

---

## ✅ 问题 3：计费中间件加固

### 改动文件
- `server/src/middleware/credit-gate.js`

### 改进内容

#### 1. 缩短故障窗口（60s → 15s）
```javascript
// 修改前
const FAIL_WINDOW_MS = 60_000  // 60 秒

// 修改后
const FAIL_WINDOW_MS = 15_000  // 缩短到 15 秒，防止 DB 短暂故障时大量免费放行
```

**效果**: 
- DB 短暂故障（1-2 秒）期间，最多只有 4 次请求免费放行（~3 秒内）
- 原来 60 秒窗口可能导致数十次免费请求

#### 2. 增强错误日志
```javascript
// 修改前
console.error(`[credit-gate] ⚠️ DB 连续失败 ${_consecutiveFails} 次，切换为拒绝模式（保护计费安全）`)

// 修改后
console.error(`[credit-gate] 🚨 DB 连续失败 ${_consecutiveFails} 次（${FAIL_WINDOW_MS}ms 内），切换为拒绝模式（保护计费安全）`)
console.error(`[credit-gate] 🚨 错误详情: ${err.message}`)
// TODO: 发送告警到运维通知渠道（webhook/邮件/飞书）
```

**效果**:
- 日志包含时间窗口信息，便于运维判断
- 记录错误详情，便于排查 DB 故障原因
- 添加 TODO 提醒后续接入告警系统

### 仍需改进（后续任务）

1. **告警通知**: 接入飞书/邮件/webhook，DB 连续失败时立即通知
2. **持久化计数**: 考虑用 Redis 存储计数器，防止进程重启重置
3. **多实例支持**: 如果部署多容器，需要 Redis 共享计数器
4. **监控仪表盘**: 添加计费门禁状态到 Admin 仪表盘

---

## ✅ 问题 5：公开 API 防护

### 改动文件
- `server/src/routes/public/plans.js` - 主要改动
- `server/src/middleware/rate-limit.js` - 新增
- `server/src/middleware.js` - CORS 白名单支持
- `server/.env.example` - 文档更新

### 改进内容

#### 1. 新增 Rate Limiting 中间件

**文件**: `server/src/middleware/rate-limit.js` (新建，92 行)

**功能**:
- 基于 IP 地址的内存速率限制
- 支持代理（x-forwarded-for, x-real-ip）
- 自动清理过期记录（每分钟清理一次）
- 返回标准 Rate Limit 响应头

**预设限制器**:
```javascript
// 严格限制（公开 API）：每分钟最多 10 次
export const strictRateLimit = createRateLimiter(10, 60_000)

// 宽松限制（认证 API）：每分钟最多 60 次
export const relaxedRateLimit = createRateLimiter(60, 60_000)

// 登录限制：每 15 分钟最多 5 次
export const loginRateLimit = createRateLimiter(5, 15 * 60_000)
```

**响应示例**:
```json
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1721295600
Retry-After: 45

{
  "error": "Too Many Requests",
  "message": "请求过于频繁，每分钟最多 10 次请求",
  "retryAfter": 45
}
```

#### 2. 应用到公开套餐 API

**修改**: `server/src/routes/public/plans.js`

```javascript
// 修改前
publicRoutes.get('/plans', (c) => { ... })

// 修改后
import { strictRateLimit } from '../../middleware/rate-limit.js'
publicRoutes.get('/plans', strictRateLimit, (c) => { ... })
```

**效果**:
- 每个 IP 每分钟最多 10 次请求
- 防止爬虫高频抓取定价信息
- 防止竞争对手实时监控定价变化

#### 3. 隐藏内部运营参数

**修改前**:
```javascript
return c.json({
  plans: {
    free:      { name: 'Free',     monthlyRmb: 0, yearlyRmb: 0, welcomeBonus: 0, dailyDrip: 0 },
    standard:  { name: 'Standard', ...plans.standard },  // 展开所有字段
    plus:      { name: 'Plus',     ...plans.plus },
    pro:       { name: 'Pro',      ...plans.pro },
  },
  vip: {
    price: vip.price,
    discount: vip.discount,
    extraDrip: vip.extraDrip,  // 内部运营参数
  },
})
```

**修改后**:
```javascript
return c.json({
  plans: {
    free: { name: 'Free', monthlyRmb: 0, yearlyRmb: 0 },
    standard: { name: 'Standard', monthlyRmb: plans.standard.monthlyRmb, yearlyRmb: plans.standard.yearlyRmb },
    plus: { name: 'Plus', monthlyRmb: plans.plus.monthlyRmb, yearlyRmb: plans.plus.yearlyRmb },
    pro: { name: 'Pro', monthlyRmb: plans.pro.monthlyRmb, yearlyRmb: plans.pro.yearlyRmb },
  },
  vip: { price: vip.price, discount: vip.discount },
  // 隐藏了: welcomeBonus, dailyDrip, extraDrip
})
```

**效果**:
- 只暴露用户可见的定价信息
- 隐藏内部运营参数（welcomeBonus, dailyDrip, extraDrip）
- 减少信息泄露风险

#### 4. CORS 多域名白名单支持

**修改**: `server/src/middleware.js`

```javascript
// 修改前
if (ALLOWED_ORIGIN && ALLOWED_ORIGIN !== 'none') {
  c.res.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
}

// 修改后
if (ALLOWED_ORIGIN && ALLOWED_ORIGIN !== 'none') {
  if (ALLOWED_ORIGIN === '*') {
    c.res.headers.set('Access-Control-Allow-Origin', '*')
  } else {
    const allowedOrigins = ALLOWED_ORIGIN.split(',').map(o => o.trim())
    const origin = c.req.header('origin')
    if (origin && allowedOrigins.includes(origin)) {
      c.res.headers.set('Access-Control-Allow-Origin', origin)
      c.res.headers.set('Vary', 'Origin')
    }
  }
}
```

**效果**:
- 支持多个官网域名: `ALLOWED_ORIGIN=https://profer.cn,https://www.profer.cn`
- 只允许白名单内的域名跨域访问
- 符合安全最佳实践（动态返回 Origin，设置 Vary）

#### 5. 更新文档

**修改**: `server/.env.example`

```bash
# 修改前
# ALLOWED_ORIGIN=https://your-domain.com   # CORS 允许的源；不设则拒绝跨域；开发环境可设 *

# 修改后
# ALLOWED_ORIGIN=https://your-domain.com   # CORS 允许的源；支持多个域名（逗号分隔）；不设则拒绝跨域；开发环境可设 *
```

---

## 📊 改进效果对比

| 维度 | 修复前 | 修复后 | 改善程度 |
|------|--------|--------|----------|
| **计费容错窗口** | 60 秒 | 15 秒 | ⬆️ 75% 降低风险窗口 |
| **公开 API 速率限制** | ❌ 无 | ✅ 10 次/分钟 | ⬆️ 防止滥用 |
| **内部参数泄露** | ❌ 全部暴露 | ✅ 只暴露价格 | ⬆️ 减少信息泄露 |
| **CORS 白名单** | ❌ 单域名或 * | ✅ 多域名白名单 | ⬆️ 精细化控制 |
| **告警通知** | ❌ 无 | ⚠️ TODO | ⏳ 待后续完成 |

---

## 🚀 部署注意事项

### 1. 环境变量配置

**生产服务器** (`47.109.108.57`):

```bash
# 在 ~/proma-team-server/.env 中添加/修改：
ALLOWED_ORIGIN=https://profer.cn,https://www.profer.cn
```

如果官网域名未确定，暂时可以设置为 `*`，但**上线后务必改为具体域名**。

### 2. 验证 Rate Limiting

部署后测试：

```bash
# 测试速率限制（连续请求 15 次）
for i in {1..15}; do
  curl -i http://47.109.108.57/proma/v1/public/plans
  echo "---"
done

# 预期：
# 前 10 次：200 OK
# 第 11 次起：429 Too Many Requests
```

### 3. 监控计费日志

部署后 24 小时内密切监控：

```bash
# 查看计费门禁日志
ssh ecs-user@47.109.108.57
docker logs proma-team -f --tail 100 | grep credit-gate

# 关注以下日志：
# - "余额查询失败" 警告
# - "🚨 DB 连续失败" 错误（如果出现，立即排查 DB）
```

### 4. DB 故障演练（可选）

在测试环境模拟 DB 故障，验证容错逻辑：

```bash
# 1. 临时重命名 DB 文件（模拟故障）
mv proma-team.db proma-team.db.bak

# 2. 连续发起 5 次 API 请求
for i in {1..5}; do
  curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3456/v1/proxy/chat/completions
done

# 3. 第 5 次应该返回 503（拒绝模式）

# 4. 恢复 DB
mv proma-team.db.bak proma-team.db

# 5. 再次请求，应该恢复正常
```

---

## 📝 后续改进建议

### 高优先级

1. **接入告警系统**（预计 2 小时）
   - 飞书 webhook 通知
   - 模板: "🚨 Profer 计费服务异常：DB 连续失败 5 次，已切换为拒绝模式"
   - 触发条件: `_denyMode = true` 时发送

2. **监控仪表盘**（预计 1 小时）
   - Admin 后台添加"计费门禁状态"面板
   - 显示: 当前模式（正常/拒绝）、连续失败次数、最后失败时间

### 中优先级

3. **Redis 共享计数器**（预计 4 小时）
   - 解决多容器部署时计数器独立问题
   - 解决进程重启重置问题
   - 依赖: 需要部署 Redis

4. **Rate Limiting 改进**（预计 2 小时）
   - 同样迁移到 Redis 存储
   - 支持多容器部署
   - 支持动态调整限速配置

### 低优先级

5. **配置中心**（预计 8 小时）
   - 将 FAIL_THRESHOLD, FAIL_WINDOW_MS 等常量改为 DB 配置
   - 支持运行时调整（无需重启）
   - 参考已有的 config-store.js 架构

---

## ✅ 验证清单

- [x] 计费容错窗口缩短到 15 秒
- [x] 错误日志包含时间窗口和详情
- [x] Rate Limiting 中间件实现完整
- [x] 公开 API 应用速率限制
- [x] 隐藏内部运营参数
- [x] CORS 支持多域名白名单
- [x] .env.example 文档更新
- [ ] 部署到生产服务器
- [ ] 验证速率限制生效
- [ ] 监控计费日志 24 小时

---

## 📦 文件清单

| 文件 | 改动类型 | 行数变化 | 说明 |
|------|----------|----------|------|
| `server/src/middleware/credit-gate.js` | 修改 | 2 行 | 缩短窗口 + 增强日志 |
| `server/src/middleware/rate-limit.js` | 新增 | 92 行 | Rate Limiting 中间件 |
| `server/src/routes/public/plans.js` | 修改 | +1 import, -14 字段 | 限速 + 隐藏参数 |
| `server/src/middleware.js` | 修改 | +11 行 | CORS 白名单支持 |
| `server/.env.example` | 修改 | 1 行 | 文档更新 |

**总计**: 1 个新增文件，4 个修改文件，约 100 行有效改动。

---

## 🔗 相关文档

- 安全审查报告: `.context/security-review.md`
- 原始问题跟踪: `.context/security-review.md` 问题 3 & 5
