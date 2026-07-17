/**
 * Admin 渠道管理路由
 */
import { Hono } from 'hono'
import { v4 as uuidv4 } from 'uuid'
import { listAllChannels, getChannelById, createChannel, updateChannel, hardDeleteChannel, db } from '../../db.js'
import { CHANNEL_ENCRYPTION_KEY } from '../../config.js'
import { logAudit } from '../../audit.js'
import { CHANNEL_ACTIVATE_CONFIRM_REQUIRED } from '../../config.js'
import { adminOpLimit, ADMIN_OP_LIMITS } from '../../admin-rate-limiter.js'
import {
  DEFAULT_MODELS,
  encryptApiKey,
  decryptApiKey,
  normalizeChannelUrls,
} from '../../shared/channel-utils.js'
import { syncChannelsFromNewApi } from '../../shared/newapi-channel-sync.js'

export const adminChannels = new Hono()

function maskKey(ciphertext) {
  try {
    const decrypted = decryptApiKey(ciphertext)
    if (decrypted.length <= 8) return '****'
    return decrypted.slice(0, 4) + '****' + decrypted.slice(-4)
  } catch { return '****' }
}

// POST /v1/admin/channels/sync — 强制从 New API 同步渠道（跳过缓存）
adminChannels.post('/sync', async (c) => {
  const result = await syncChannelsFromNewApi(db, { force: true })
  logAudit({ action: 'admin.sync_channels', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', detail: `synced=${result.synced} updated=${result.updated} deactivated=${result.deactivated}` })
  return c.json(result)
})

// GET /v1/admin/channels — 渠道列表（自动触发同步）
adminChannels.get('/', async (c) => {
  // 每次打开 admin 渠道页触发同步（内部 60s 缓存，不会频繁调 New API）
  await syncChannelsFromNewApi(db)
  const channels = listAllChannels()
  const masked = channels.map(ch => ({
    ...ch,
    api_key_encrypted: maskKey(ch.api_key_encrypted),
    models_json: undefined,
    models: JSON.parse(ch.models_json || '[]'),
  }))
  return c.json(masked)
})

// POST /v1/admin/channels — 创建渠道（默认 scope=test，需手动激活为 global）
adminChannels.post('/', async (c) => {
  if (!CHANNEL_ENCRYPTION_KEY) return c.json({ error: 'CHANNEL_ENCRYPTION_KEY 未配置' }, 500)

  // 频控
  const freqLimit = adminOpLimit(c.get('userId'), 'create-channel', ADMIN_OP_LIMITS['create-channel'])
  if (!freqLimit.allowed) {
    return c.json({ error: '今日创建渠道次数已达上限' }, 429)
  }

  const body = await c.req.json()
  const { name, provider, apiKey, baseUrl, agentBaseUrl, models, modelsJson } = body || {}
  if (!name || !provider) return c.json({ error: 'name, provider 必填' }, 400)
  const effectiveKey = apiKey || 'proxy-managed'
  if (!apiKey && !modelsJson && !models) return c.json({ error: 'apiKey 或 models 必填其一' }, 400)

  let finalModels
  if (modelsJson) {
    try { finalModels = JSON.parse(modelsJson) } catch (e) { return c.json({ error: 'modelsJson 必须是合法 JSON' }, 400) }
  } else {
    finalModels = models && models.length > 0 ? models : (DEFAULT_MODELS[provider] || [])
  }

  const id = uuidv4()
  const encrypted = encryptApiKey(effectiveKey)
  const urls = normalizeChannelUrls(provider, baseUrl, agentBaseUrl)
  // 🔒 新建渠道默认 scope=test，仅管理员可见/可用。需手动 activate 后才会对用户开放。
  createChannel({ id, name, provider, apiKeyEncrypted: encrypted, baseUrl: urls.baseUrl, agentBaseUrl: urls.agentBaseUrl, modelsJson: JSON.stringify(finalModels), createdBy: c.get('userId'), scope: 'test' })

  logAudit({ action: 'admin.create_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id, detail: `provider=${provider} name=${name} scope=test` })
  return c.json({ id, name, provider, scope: 'test' }, 201)
})

// GET /v1/admin/channels/:id — 单个渠道
adminChannels.get('/:id', (c) => {
  const ch = getChannelById(c.req.param('id'))
  if (!ch) return c.json({ error: '渠道不存在' }, 404)
  return c.json({ ...ch, api_key_encrypted: maskKey(ch.api_key_encrypted), models: JSON.parse(ch.models_json || '[]'), models_json: undefined })
})

// PATCH /v1/admin/channels/:id — 编辑渠道（官方同步渠道不可编辑名称/供应商/模型）
adminChannels.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (id.startsWith('newapi-')) return c.json({ error: '官方同步渠道不可编辑，请在 New API 后台修改后重新同步' }, 403)
  const body = await c.req.json()
  const fields = {}
  if (body.name !== undefined) fields.name = body.name
  if (body.provider !== undefined) fields.provider = body.provider
  if (body.baseUrl !== undefined || body.agentBaseUrl !== undefined || body.provider === 'deepseek') {
    const current = getChannelById(id)
    const urls = normalizeChannelUrls(
      body.provider ?? current?.provider,
      body.baseUrl ?? current?.base_url,
      body.agentBaseUrl ?? current?.agent_base_url,
    )
    if (body.baseUrl !== undefined || urls.baseUrl !== current?.base_url) fields.base_url = urls.baseUrl
    if (body.agentBaseUrl !== undefined || urls.agentBaseUrl !== current?.agent_base_url) fields.agent_base_url = urls.agentBaseUrl
  }
  if (body.models !== undefined) fields.models_json = JSON.stringify(body.models)
  if (body.modelsJson !== undefined) {
    try { JSON.parse(body.modelsJson); fields.models_json = body.modelsJson } catch (e) {}
  }
  if (body.is_active !== undefined) fields.is_active = body.is_active ? 1 : 0
  if (body.apiKey) fields.api_key_encrypted = encryptApiKey(body.apiKey)

  updateChannel(id, fields)
  logAudit({ action: 'admin.update_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id })
  return c.json({ success: true })
})

// DELETE /v1/admin/channels/:id — 删除渠道（global 范围不可删，需先停用）
adminChannels.delete('/:id', (c) => {
  const id = c.req.param('id')
  if (id.startsWith('newapi-')) return c.json({ error: '官方同步渠道不可删除，请在 New API 后台停用后重新同步' }, 403)
  const ch = getChannelById(id)
  if (!ch) return c.json({ error: '渠道不存在' }, 404)
  if (ch.scope === 'global') return c.json({ error: '全局渠道不可直接删除，请先设为停用 (is_active=0)' }, 403)
  hardDeleteChannel(id)
  logAudit({ action: 'admin.delete_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id })
  return c.json({ success: true })
})

// POST /v1/admin/channels/:id/activate — 激活渠道：test → global（高风险操作，需审计）
adminChannels.post('/:id/activate', (c) => {
  const id = c.req.param('id')
  const ch = getChannelById(id)
  if (!ch) return c.json({ error: '渠道不存在' }, 404)
  if (ch.id.startsWith('newapi-')) return c.json({ error: '官方同步渠道无需手动激活' }, 403)
  if (ch.scope === 'global') return c.json({ error: '渠道已是全局范围' }, 400)

  // 频控
  const freqLimit = adminOpLimit(c.get('userId'), 'activate-channel', ADMIN_OP_LIMITS['activate-channel'])
  if (!freqLimit.allowed) {
    return c.json({ error: '今日激活渠道次数已达上限' }, 429)
  }

  db.prepare('UPDATE channels SET scope = ?, updated_at = ? WHERE id = ?').run('global', Date.now(), id)
  logAudit({ action: 'admin.activate_channel', userId: c.get('userId'), userEmail: c.get('userEmail'), entityType: 'channel', entityId: id, detail: `scope: test → global, name=${ch.name}, provider=${ch.provider}` })
  return c.json({ success: true, scope: 'global' })
})

// POST /v1/admin/channels/test — 测试渠道连通性
adminChannels.post('/test', async (c) => {
  const body = await c.req.json()
  const { apiKey, baseUrl, provider } = body || {}
  if (!apiKey || !baseUrl) return c.json({ error: 'apiKey 和 baseUrl 必填' }, 400)

  const isAnthropic = provider === 'anthropic' || provider === 'anthropic-compatible'
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
    const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/models`
    const resp = await fetch(url, {
      method: isAnthropic ? 'POST' : 'GET',
      headers,
      body: isAnthropic ? JSON.stringify({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    if (resp.ok) return c.json({ success: true, status: resp.status })
    const text = await resp.text()
    return c.json({ success: false, status: resp.status, error: text.slice(0, 200) })
  } catch (err) {
    return c.json({ success: false, error: err.message })
  }
})
