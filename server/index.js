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
import { PORT, ADMIN_EMAIL, MAX_FILE_SIZE } from './src/config.js'
import { initAdmin, db } from './src/db.js'
import { corsMiddleware } from './src/middleware.js'
import { authRoutes } from './src/routes/auth.js'
import { workspaceRoutes } from './src/routes/workspaces.js'
import { invitationRoutes } from './src/routes/invitations.js'
import { syncRoutes } from './src/routes/sync.js'
import { fileRoutes } from './src/routes/files.js'
import { heartbeatRoutes } from './src/routes/heartbeat.js'

// ===== 初始化 =====
initAdmin()

// ===== 组装路由 =====
const app = new Hono()

app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    corsMiddleware(c)
    return new Response(null, { status: 204 })
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

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: Date.now() }))

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

// 优雅关闭
process.on('SIGTERM', () => { db.close(); process.exit(0) })
process.on('SIGINT', () => { db.close(); process.exit(0) })
