/**
 * Profer Team Server — 团队协作后端
 *
 * Hono + better-sqlite3 + JWT
 * 部署目标: 47.109.108.57
 *
 * 目录结构:
 *   server/
 *   ├── index.js                 ← 入口（本文件）
 *   ├── src/
 *   │   ├── config.js            ← 配置（订阅/计费/MinerU）
 *   │   ├── db.js                ← 数据库 barrel（re-export 子模块）
 *   │   ├── db/
 *   │   │   ├── schema.js        ←   db 实例 + DDL + 迁移
 *   │   │   ├── credits.js       ←   三桶扣款/透支/交易
 *   │   │   └── subscription.js  ←   订阅/订单/邀请/drip/兑换码
 *   │   ├── utils.js             ← 工具函数
 *   │   ├── middleware.js         ← CORS + JWT/relay/pk_ 鉴权
 *   │   ├── middleware/
 *   │   │   ├── admin.js         ←   管理员鉴权
 *   │   │   ├── credit-gate.js   ←   余额透支门禁
 *   │   │   └── tier-gate.js     ←   国际模型等级门禁
 *   │   ├── event-bus.js         ← SSE 事件广播
 *   │   ├── newapi-client.js     ← New API 对账客户端
 *   │   └── routes/
 *   │       ├── auth.js              ← 注册/登录
 *   │       ├── workspaces.js        ← 工作区 CRUD + 成员
 *   │       ├── invitations.js       ← 邀请
 *   │       ├── sync.js              ← 变更同步
 *   │       ├── files.js             ← 文件上传/下载
 *   │       ├── heartbeat.js         ← 心跳
 *   │       ├── events.js            ← SSE 事件端点
 *   │       ├── announcements.js     ← 工作区公告
 *   │       ├── feedback.js          ← 意见箱（飞书 Base）
 *   │       ├── invite.js            ← 邀请返利
 *   │       ├── account/
 *   │       │   ├── channels.js      ←   渠道管理
 *   │       │   ├── credits.js       ←   额度查询
 *   │       │   ├── api-keys.js      ←   开放 API Key
 *   │       │   ├── subscription.js  ←   订阅状态/drip
 *   │       │   └── redeem.js        ←   兑换码核销
 *   │       ├── admin/
 *   │       │   ├── users.js         ←   用户管理
 *   │       │   ├── channels.js      ←   渠道管理
 *   │       │   ├── credits.js       ←   额度管理
 *   │       │   ├── dashboard.js     ←   仪表盘
 *   │       │   ├── activation-codes.js  ← 激活码
 *   │       │   ├── orders.js        ←   订单管理
 *   │       │   ├── redemption-codes.js  ← 兑换码管理
 *   │       │   └── audit.js         ←   审计日志
 *   │       ├── proxy/
 *   │       │   └── chat.js          ←   AI API 代理转发
 *   │       └── services/
 *   │           ├── kb.js            ←   知识库
 *   │           └── mineru.js        ←   论文解析
 *   └── scripts/                 ← 运维脚本（drip/备份/部署/迁移）
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { PORT, ADMIN_EMAIL, MAX_FILE_SIZE } from './src/config.js'
import { initAdmin, db } from './src/db.js'
import { corsMiddleware, authMiddleware, honoAuthMiddleware, proxyAuthMiddleware } from './src/middleware.js'
import { adminMiddleware } from './src/middleware/admin.js'
import { authRoutes } from './src/routes/auth.js'
import { workspaceRoutes } from './src/routes/workspaces.js'
import { invitationRoutes } from './src/routes/invitations.js'
import { syncRoutes } from './src/routes/sync.js'
import { fileRoutes } from './src/routes/files.js'
import { heartbeatRoutes } from './src/routes/heartbeat.js'
import { eventRoutes } from './src/routes/events.js'
import { announcementRoutes } from './src/routes/announcements.js'
import { adminUsers } from './src/routes/admin/users.js'
import { adminChannels } from './src/routes/admin/channels.js'
import { adminCredits } from './src/routes/admin/credits.js'
import { adminDashboard } from './src/routes/admin/dashboard.js'
import { adminActivationCodes } from './src/routes/admin/activation-codes.js'
import { adminOrders } from './src/routes/admin/orders.js'
import { adminRedemptionCodes } from './src/routes/admin/redemption-codes.js'
import { adminAudit } from './src/routes/admin/audit.js'
import { accountChannels } from './src/routes/account/channels.js'
import { accountCredits } from './src/routes/account/credits.js'
import { accountApiKeys } from './src/routes/account/api-keys.js'
import { inviteRoutes } from './src/routes/invite.js'
import { accountSubscription } from './src/routes/account/subscription.js'
import { accountRedeem } from './src/routes/account/redeem.js'
import { proxyRoutes } from './src/routes/proxy/chat.js'
import { mineruRoutes } from './src/routes/services/mineru.js'
import { kbRoutes } from './src/routes/services/kb.js'
import { creditGateMiddleware } from './src/middleware/credit-gate.js'
import { tierGateMiddleware } from './src/middleware/tier-gate.js'
import { feedbackRoutes } from './src/routes/feedback.js'

// ===== 初始化 =====
initAdmin()

// ===== 组装路由 =====
const app = new Hono()

app.use('*', async (c, next) => {
  const corsResult = corsMiddleware(c)
  if (corsResult) return corsResult
  await next()
})

app.route('/v1/auth', authRoutes)
app.route('/v1/workspaces', workspaceRoutes)
app.route('/v1/invitations', invitationRoutes)
app.route('/v1/sync', syncRoutes)
app.route('/v1/workspaces', fileRoutes)
app.route('/v1/workspaces', eventRoutes)
app.route('/v1/workspaces', announcementRoutes)
app.route('/v1/heartbeat', heartbeatRoutes)

// Admin 路由（需要 auth + admin 双重鉴权）
const adminApp = new Hono()
adminApp.use('*', honoAuthMiddleware)
adminApp.use('*', adminMiddleware)
adminApp.route('/users', adminUsers)
adminApp.route('/channels', adminChannels)
adminApp.route('/credits', adminCredits)
adminApp.route('/dashboard', adminDashboard)
adminApp.route('/activation-codes', adminActivationCodes)
adminApp.route('/orders', adminOrders)
adminApp.route('/redemption-codes', adminRedemptionCodes)
adminApp.route('/audit', adminAudit)
app.route('/v1/admin', adminApp)

// Account 路由（需要 auth）
const accountApp = new Hono()
accountApp.use('*', honoAuthMiddleware)
accountApp.route('/channels', accountChannels)
accountApp.route('/credits', accountCredits)
accountApp.route('/api-keys', accountApiKeys)
accountApp.route('/subscription', accountSubscription)
accountApp.route('/redeem', accountRedeem)
accountApp.route('/', inviteRoutes)
app.route('/v1/account', accountApp)

// Proxy 路由（需要 auth）
// 用 proxyAuthMiddleware：兼容长效 relay 令牌和标准 accessToken，
// 避免客户端把 1h accessToken 当渠道 key 长期持有导致中途 401
//
// 计费已收敛到 New API 单一计费方：Profer 不再预扣 credits，
// proxy 只认人 + 透传转发，额度校验/扣费完全交给 New API。
const proxyApp = new Hono()
proxyApp.use('*', proxyAuthMiddleware)
proxyApp.use('*', tierGateMiddleware)
proxyApp.use('*', creditGateMiddleware)
proxyApp.route('/', proxyRoutes)
app.route('/v1/proxy', proxyApp)

// MinerU 论文解析路由（需要 auth）
// 用 proxyAuthMiddleware 兼容 relay token / JWT / pk_ 三种凭证
const servicesApp = new Hono()
servicesApp.use('*', proxyAuthMiddleware)
servicesApp.route('/mineru', mineruRoutes)
servicesApp.route('/kb', kbRoutes)
// 扣费循环触发端点（供外部 cron / automation 调用）
servicesApp.get('/billing/sweep', adminMiddleware, async (c) => {
  const { sweepUnbilledRequests } = await import('./src/db.js')
  try {
    const result = await sweepUnbilledRequests()
    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message }, 500)
  }
})
app.route('/v1/services', servicesApp)

// 意见箱（无需登录态）
app.route('/v1/feedback', feedbackRoutes)

// Admin SPA — 管理后台
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
const adminHtmlPath = pathJoin(import.meta.dirname, 'src', 'admin-ui', 'index.html')
app.get('/admin', (c) => {
  if (!existsSync(adminHtmlPath)) return c.text('Admin UI not found', 404)
  return c.html(readFileSync(adminHtmlPath, 'utf-8'))
})
app.get('/admin/*', (c) => {
  if (!existsSync(adminHtmlPath)) return c.text('Admin UI not found', 404)
  return c.html(readFileSync(adminHtmlPath, 'utf-8'))
})

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: Date.now() }))

// 全局错误处理
app.onError((err, c) => {
  console.error('[Profer] 未处理的错误:', err.message)
  return c.json({ error: '服务器内部错误' }, 500)
})

// ===== 启动 =====
console.log('[Profer Team Server] 启动中...')
console.log(`  端口: ${PORT}`)
console.log(`  文件上限: ${Math.round(MAX_FILE_SIZE / 1048576)}MB`)
console.log(`  admin: ${ADMIN_EMAIL}`)

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`[Profer Team Server] 已启动: http://0.0.0.0:${info.port}`)
})

// 后台定时任务（邀请清理/扣费补扫/黑名单/工作区硬删/信封清理）
import { startSchedulers } from './src/scheduler.js'
startSchedulers()

// 优雅关闭
process.on('SIGTERM', () => { db.close(); process.exit(0) })
process.on('SIGINT', () => { db.close(); process.exit(0) })
