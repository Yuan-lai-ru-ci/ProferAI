/**
 * 用户开放 API Key 路由 — 用户自建 pk_ key，通过 HTTP 调 /v1/proxy 访问。
 *
 * 铁律：
 *   - 明文 key 只在创建时返回一次，之后只能看脱敏前缀。
 *   - key 只存 sha256 hash；pk_ 仅用于反查用户，绝不等于平台 RELAY_API_KEY。
 *   - 所有操作强制归属校验（只能管自己的 key）。
 *
 * 挂载在 /v1/account/api-keys，走 honoAuthMiddleware（登录 JWT）。
 */
import { Hono } from 'hono'
import { createApiKey, listApiKeys, updateApiKey, deleteApiKey } from '../../db.js'

export const accountApiKeys = new Hono()

// GET /v1/account/api-keys — 当前用户的 key 列表（不含明文）
accountApiKeys.get('/', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)
  return c.json({ keys: listApiKeys(userId) })
})

// POST /v1/account/api-keys — 创建 key，返回明文（唯一一次）
accountApiKeys.post('/', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)

  const body = await c.req.json().catch(() => ({}))
  const name = (body?.name || '').toString().slice(0, 64)
  const quotaLimit = body?.quotaLimit != null ? parseInt(body.quotaLimit, 10) : null

  const { id, plaintext, prefix } = createApiKey({ userId, name, quotaLimit })
  // key 字段仅此一次返回明文
  return c.json({ id, name, key: plaintext, keyPrefix: prefix, status: 'active' })
})

// PATCH /v1/account/api-keys/:id — 改名 / 启停 / 改限额
accountApiKeys.patch('/:id', async (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)

  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const patch = {}
  if (body?.name !== undefined) patch.name = body.name.toString().slice(0, 64)
  if (body?.status !== undefined) patch.status = body.status
  if (body?.quotaLimit !== undefined) patch.quotaLimit = body.quotaLimit != null ? parseInt(body.quotaLimit, 10) : null

  const ok = updateApiKey(id, userId, patch)
  if (!ok) return c.json({ error: 'API Key 不存在或无权操作' }, 404)
  return c.json({ success: true })
})

// DELETE /v1/account/api-keys/:id — 删除 key
accountApiKeys.delete('/:id', (c) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: '未认证' }, 401)

  const ok = deleteApiKey(c.req.param('id'), userId)
  if (!ok) return c.json({ error: 'API Key 不存在或无权操作' }, 404)
  return c.json({ success: true })
})
