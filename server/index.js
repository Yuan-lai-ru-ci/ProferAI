/**
 * Proma Team Server — 团队协作后端
 *
 * Hono + better-sqlite3 + JWT
 * 部署目标: 47.109.108.57
 *
 * 目录结构:
 *   server/
 *   ├── index.js            ← 入口（本文件）
 *   ├── src/
 *   │   ├── config.js       ← 配置
 *   │   ├── db.js           ← 数据库初始化
 *   │   ├── utils.js        ← 工具函数
 *   │   ├── middleware.js    ← CORS + JWT 认证
 *   │   └── routes/
 *   │       ├── auth.js         ← 注册/登录
 *   │       ├── workspaces.js   ← 工作区 CRUD + 成员管理
 *   │       ├── invitations.js  ← 邀请验证/接受/拒绝
 *   │       ├── sync.js         ← 变更同步
 *   │       ├── files.js        ← 文件上传/下载/删除
 *   │       └── heartbeat.js    ← 心跳上报
 *   └── files/              ← 上传文件存储目录
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { PORT, ADMIN_EMAIL, MAX_FILE_SIZE, WORKSPACE_GRACE_PERIOD_MS, INVITATION_RETENTION_MS, FILES_DIR } from './src/config.js'
import { initAdmin, db } from './src/db.js'
import { corsMiddleware, authMiddleware, honoAuthMiddleware, proxyAuthMiddleware } from './src/middleware.js'
import { adminMiddleware } from './src/middleware/admin.js'
import { authRoutes } from './src/routes/auth.js'
import { workspaceRoutes } from './src/routes/workspaces.js'
import { invitationRoutes } from './src/routes/invitations.js'
import { syncRoutes } from './src/routes/sync.js'
import { fileRoutes } from './src/routes/files.js'
import { heartbeatRoutes } from './src/routes/heartbeat.js'
import { adminUsers } from './src/routes/admin/users.js'
import { adminChannels } from './src/routes/admin/channels.js'
import { adminCredits } from './src/routes/admin/credits.js'
import { adminDashboard } from './src/routes/admin/dashboard.js'
import { adminActivationCodes } from './src/routes/admin/activation-codes.js'
import { adminPricing } from './src/routes/admin/pricing.js'
import { accountChannels } from './src/routes/account/channels.js'
import { accountCredits } from './src/routes/account/credits.js'
import { proxyRoutes } from './src/routes/proxy/chat.js'

// ===== 初始化 =====
initAdmin()

// ===== 组装路由 =====
const app = new Hono()

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      },
    })
  }
  corsMiddleware(c)
  await next()
})

app.route('/v1/auth', authRoutes)
app.route('/v1/workspaces', workspaceRoutes)
app.route('/v1/invitations', invitationRoutes)
app.route('/v1/sync', syncRoutes)
app.route('/v1/workspaces', fileRoutes)
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
adminApp.route('/pricing', adminPricing)
app.route('/v1/admin', adminApp)

// Account 路由（需要 auth）
const accountApp = new Hono()
accountApp.use('*', honoAuthMiddleware)
accountApp.route('/channels', accountChannels)
accountApp.route('/credits', accountCredits)
app.route('/v1/account', accountApp)

// Proxy 路由（需要 auth）
// 用 proxyAuthMiddleware：兼容长效 relay 令牌和标准 accessToken，
// 避免客户端把 1h accessToken 当渠道 key 长期持有导致中途 401
//
// 计费已收敛到 New API 单一计费方：Profer 不再预扣 credits，
// proxy 只认人 + 透传转发，额度校验/扣费完全交给 New API。
const proxyApp = new Hono()
proxyApp.use('*', proxyAuthMiddleware)
proxyApp.route('/', proxyRoutes)
app.route('/v1/proxy', proxyApp)

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
  console.error('[Proma] 未处理的错误:', err.message)
  return c.json({ error: '服务器内部错误' }, 500)
})

// ===== 启动 =====
console.log('[Proma Team Server] 启动中...')
console.log(`  端口: ${PORT}`)
console.log(`  文件上限: ${Math.round(MAX_FILE_SIZE / 1048576)}MB`)
console.log(`  admin: ${ADMIN_EMAIL}`)

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`[Proma Team Server] 已启动: http://0.0.0.0:${info.port}`)
})

// 定期清理过期邀请
setInterval(() => {
  try {
    const result = db.prepare(
      "UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?"
    ).run(Date.now())
    if (result.changes > 0) {
      console.log(`[清理] 已将 ${result.changes} 条过期邀请标记为 expired`)
    }
  } catch (err) {
    console.warn('[清理] 邀请过期标记失败:', err.message)
  }
}, 10 * 60 * 1000).unref()

// 定期清理过期黑名单条目
setInterval(() => {
  try {
    db.prepare('DELETE FROM token_blacklist WHERE expires_at < ?').run(Date.now())
  } catch { /* 忽略 */ }
}, 30 * 60 * 1000).unref()

// 工作区冷静期满硬删除（每 1 小时检查）
setInterval(() => {
  try {
    const cutoff = Date.now() - WORKSPACE_GRACE_PERIOD_MS
    const expired = db.prepare(
      'SELECT id FROM workspaces WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?'
    ).all(cutoff)

    if (expired.length === 0) return

    const hardDeleteWorkspace = db.transaction((wsId) => {
      db.prepare('DELETE FROM sync_envelopes WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM file_manifests WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM invitations WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM audit_logs WHERE workspace_id = ?').run(wsId)
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId)
    })

    // 防护：FILES_DIR 未配置或指向根路径时，绝不执行目录删除，避免灾难性 rmSync（DB 清理不受影响）
    const filesDirOk =
      typeof FILES_DIR === 'string' &&
      FILES_DIR.trim().length > 0 &&
      FILES_DIR.trim() !== '/' &&
      FILES_DIR.trim() !== '\\'

    for (const { id } of expired) {
      if (filesDirOk && id) {
        const wsDir = pathJoin(FILES_DIR, id)
        if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true })
      }
      hardDeleteWorkspace(id)
      console.log(`[清理] 已硬删除过期工作区: ${id}`)
    }
  } catch (err) {
    console.warn('[清理] 工作区冷静期满清理失败:', err.message)
  }
}, 60 * 60 * 1000).unref()

// 定期清理已处理的过期历史邀请（每 24 小时）
setInterval(() => {
  try {
    const cutoff = Date.now() - INVITATION_RETENTION_MS
    const result = db.prepare(
      "DELETE FROM invitations WHERE status != 'pending' AND created_at < ?"
    ).run(cutoff)
    if (result.changes > 0) {
      console.log(`[清理] 已删除 ${result.changes} 条过期历史邀请`)
    }
  } catch (err) {
    console.warn('[清理] 邀请历史清理失败:', err.message)
  }
}, 24 * 60 * 60 * 1000).unref()

// 优雅关闭
process.on('SIGTERM', () => { db.close(); process.exit(0) })
process.on('SIGINT', () => { db.close(); process.exit(0) })
