/**
 * Feedback 路由 — 意见箱
 *
 * 接收用户反馈，写入飞书多维表格（Lark Base）。
 * 无需登录态，匿名也可提交。
 * 已登录用户：自动附带邮箱，每日限 5 条（本地 SQLite 计数）。
 */

import { Hono } from 'hono'
import { db } from '../db.js'

// ===== 本地计数器（每日限流，零额外 API 调用）=====

// 确保计数表存在
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_daily_count (
    user_email TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_email, date)
  )
`)

const incrStmt = db.prepare(`
  INSERT INTO feedback_daily_count (user_email, date, count)
  VALUES (?, ?, 1)
  ON CONFLICT(user_email, date) DO UPDATE SET count = count + 1
`)
const getStmt = db.prepare(
  'SELECT count FROM feedback_daily_count WHERE user_email = ? AND date = ?'
)

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 检查当日次数（不递增），返回 { ok, count } */
function checkDailyLimit(userEmail) {
  const row = getStmt.get(userEmail, todayStr())
  const count = row?.count ?? 0
  return { ok: count < 5, count }
}

/** 递增当日计数 */
function incrementDailyCount(userEmail) {
  incrStmt.run(userEmail, todayStr())
}

// ===== 飞书 API 客户端 =====

const LARK_HOST = 'https://open.feishu.cn'

let cachedToken = null
let tokenExpiresAt = 0

async function getTenantAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken
  }

  const appId = process.env.LARK_APP_ID
  const appSecret = process.env.LARK_APP_SECRET

  if (!appId || !appSecret) {
    throw new Error('飞书应用未配置（LARK_APP_ID / LARK_APP_SECRET）')
  }

  const resp = await fetch(`${LARK_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`获取飞书 token 失败 (${resp.status}): ${body}`)
  }

  const data = await resp.json()
  if (data.code !== 0) {
    throw new Error(`飞书 token 错误 [${data.code}]: ${data.msg}`)
  }

  cachedToken = data.tenant_access_token
  tokenExpiresAt = Date.now() + (data.expire - 300) * 1000
  console.log('[feedback] 飞书 tenant_access_token 已刷新')
  return cachedToken
}

async function createBaseRecord(baseToken, tableId, fields) {
  const token = await getTenantAccessToken()

  const resp = await fetch(
    `${LARK_HOST}/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    }
  )

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`飞书 Base 写入失败 (${resp.status}): ${body}`)
  }

  const data = await resp.json()
  if (data.code !== 0) {
    throw new Error(`飞书 Base 错误 [${data.code}]: ${data.msg}`)
  }

  return data.data.record
}

// ===== 路由 =====

export const feedbackRoutes = new Hono()

feedbackRoutes.post('/', async (c) => {
  const baseToken = process.env.LARK_FEEDBACK_BASE_TOKEN
  const tableId = process.env.LARK_FEEDBACK_TABLE_ID

  if (!baseToken || !tableId) {
    console.error('[feedback] 未配置 LARK_FEEDBACK_BASE_TOKEN / LARK_FEEDBACK_TABLE_ID')
    return c.json({ error: '意见箱暂不可用，请联系管理员配置' }, 503)
  }

  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: '请求格式错误' }, 400)
  }

  const { content, contact, category, pageUrl, teamEmail, teamAccountId } = body || {}

  if (!content || typeof content !== 'string' || !content.trim()) {
    return c.json({ error: '意见内容不能为空' }, 400)
  }

  if (content.length > 5000) {
    return c.json({ error: '意见内容不能超过 5000 字' }, 400)
  }

  // 每日限流（仅针对已登录用户）
  const userEmail = (teamEmail && typeof teamEmail === 'string') ? teamEmail.trim() : ''
  if (userEmail) {
    const limit = checkDailyLimit(userEmail)
    if (!limit.ok) {
      return c.json({ error: `今天已提交 ${limit.count} 条反馈，明天再来吧` }, 429)
    }
  }

  // 分类映射
  const categoryMap = {
    'general': '💬 通用反馈',
    'feature': '💡 功能建议',
    'bug': '🐛 BUG报告',
    'other': '📝 其他',
  }
  const categoryValue = categoryMap[category] || '💬 通用反馈'

  const fields = {
    '分类': categoryValue,
    '意见内容': content.trim(),
    '联系方式': (contact && typeof contact === 'string' && contact.trim()) ? contact.trim().slice(0, 200) : '',
    '提交用户': userEmail,
    '提交时间': Date.now(),
    '来源页面': (pageUrl && typeof pageUrl === 'string') ? pageUrl.slice(0, 500) : '',
    '处理状态': '待处理',
  }

  try {
    const record = await createBaseRecord(baseToken, tableId, fields)
    // 写入成功后递增计数
    if (userEmail) incrementDailyCount(userEmail)
    console.log('[feedback] 已写入:', record?.record_id, userEmail ? `(用户: ${userEmail}, 今日第${checkDailyLimit(userEmail).count}条)` : '(匿名)')
    return c.json({ ok: true, record_id: record?.record_id })
  } catch (err) {
    console.error('[feedback] 写入失败:', err.message)
    return c.json({ error: '提交失败，请稍后重试' }, 500)
  }
})
