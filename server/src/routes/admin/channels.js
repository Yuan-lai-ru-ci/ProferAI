/**
 * Admin 渠道管理路由
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { listAllChannels, getChannelById, createChannel, updateChannel, softDeleteChannel } from '../../db.js'
import { CHANNEL_ENCRYPTION_KEY } from '../../config.js'
import { logAudit } from '../../audit.js'

export const adminChannels = new Hono()

const ALGO = 'aes-256-gcm'

function encryptApiKey(plaintext) {
  const key = Buffer.from(CHANNEL_ENCRYPTION_KEY, 'hex')
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex'), tag: tag.toString('hex') })
}

function decryptApiKey(ciphertext) {
  const { iv, data, tag } = JSON.parse(ciphertext)
  const key = Buffer.from(CHANNEL_ENCRYPTION_KEY, 'hex')
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'))
  decipher.setAuthTag(Buffer.from(tag, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8')
}

function maskKey(ciphertext) {
  try {
    const decrypted = decryptApiKey(ciphertext)
    if (decrypted.length <= 8) return '****'
    return decrypted.slice(0, 4) + '****' + decrypted.slice(-4)
  } catch { return '****' }
}

// GET /v1/admin/channels — 渠道列表
adminChannels.get('/', (c) => {
  const channels = listAllChannels()
  const masked = channels.map(ch => ({
    ...ch,
    api_key_encrypted: maskKey(ch.api_key_encrypted),
    models_json: undefined,
    models: JSON.parse(ch.models_json || '[]'),
  }))
  return c.json(masked)
})

// POST /v1/admin/channels — 创建渠道
adminChannels.post('/', async (c) => {
  if (!CHANNEL_ENCRYPTION_KEY) return c.json({ error: 'CHANNEL_ENCRYPTION_KEY 未配置' }, 500)

  const body = await c.req.json()
  const { name, provider, apiKey, baseUrl, models } = body || {}
  if (!name || !provider || !apiKey) return c.json({ error: 'name, provider, apiKey 必填' }, 400)

  const id = uuidv4()
  const encrypted = encryptApiKey(apiKey)
  createChannel({ id, name, provider, apiKeyEncrypted: encrypted, baseUrl, modelsJson: JSON.stringify(models || []), createdBy: c.get('userId') })

  logAudit({ action: 'admin.create_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id, detail: `provider=${provider} name=${name}` })
  return c.json({ id, name, provider }, 201)
})

// GET /v1/admin/channels/:id — 单个渠道
adminChannels.get('/:id', (c) => {
  const ch = getChannelById(c.req.param('id'))
  if (!ch) return c.json({ error: '渠道不存在' }, 404)
  return c.json({ ...ch, api_key_encrypted: maskKey(ch.api_key_encrypted), models: JSON.parse(ch.models_json || '[]'), models_json: undefined })
})

// PATCH /v1/admin/channels/:id — 编辑渠道
adminChannels.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields = {}
  if (body.name !== undefined) fields.name = body.name
  if (body.provider !== undefined) fields.provider = body.provider
  if (body.baseUrl !== undefined) fields.base_url = body.baseUrl
  if (body.models !== undefined) fields.models_json = JSON.stringify(body.models)
  if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0
  if (body.apiKey) fields.api_key_encrypted = encryptApiKey(body.apiKey)

  updateChannel(id, fields)
  logAudit({ action: 'admin.update_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id })
  return c.json({ success: true })
})

// DELETE /v1/admin/channels/:id — 删除渠道（软删除）
adminChannels.delete('/:id', (c) => {
  const id = c.req.param('id')
  softDeleteChannel(id)
  logAudit({ action: 'admin.delete_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id })
  return c.json({ success: true })
})

// POST /v1/admin/channels/test — 测试渠道连通性
adminChannels.post('/test', async (c) => {
  const body = await c.req.json()
  const { apiKey, baseUrl, provider } = body || {}
  if (!apiKey || !baseUrl) return c.json({ error: 'apiKey 和 baseUrl 必填' }, 400)

  try {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    const url = provider === 'anthropic' || provider === 'anthropic-compatible'
      ? `${baseUrl}/v1/messages`
      : `${baseUrl}/models`
    const resp = await fetch(url, { method: provider === 'anthropic' || provider === 'anthropic-compatible' ? 'POST' : 'GET', headers, body: provider === 'anthropic' || provider === 'anthropic-compatible' ? JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) : undefined, signal: AbortSignal.timeout(15000) })
    if (resp.ok) return c.json({ success: true, status: resp.status })
    const text = await resp.text()
    return c.json({ success: false, status: resp.status, error: text.slice(0, 200) })
  } catch (err) {
    return c.json({ success: false, error: err.message })
  }
})
