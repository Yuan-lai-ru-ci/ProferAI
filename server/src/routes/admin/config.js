/**
 * Admin 系统配置路由 — 读/写/重置可动态调整的商业参数
 */
import { Hono } from 'hono'
import { getConfigsGrouped, getConfig, setConfig, setConfigs, resetConfig, CONFIG_SCHEMA } from '../../db/config-store.js'
import { logAudit } from '../../audit.js'

export const adminConfig = new Hono()

// GET /v1/admin/config — 列出所有配置项（分组）
adminConfig.get('/', (c) => {
  const groups = getConfigsGrouped()
  return c.json({ groups })
})

// GET /v1/admin/config/:key — 读取单个配置
adminConfig.get('/:key', (c) => {
  const key = c.req.param('key')
  const schema = CONFIG_SCHEMA[key]
  if (!schema) return c.json({ error: `未知配置项: ${key}` }, 404)

  const raw = getConfig(key)
  return c.json({
    key,
    value: raw,
    type: schema.type,
    label: schema.label,
    group: schema.group,
    defaultValue: schema.type === 'int' ? parseInt(schema.defaultValue, 10)
      : schema.type === 'float' ? parseFloat(schema.defaultValue)
      : schema.defaultValue,
  })
})

// PUT /v1/admin/config/:key — 更新单个配置
adminConfig.put('/:key', async (c) => {
  const key = c.req.param('key')
  const { value } = await c.req.json()
  const userId = c.get('userId')

  if (value === undefined || value === null || value === '') {
    return c.json({ error: 'value 必填' }, 400)
  }

  try {
    const result = setConfig(key, value, userId)

    logAudit({
      action: 'admin.update_config',
      userId,
      userEmail: c.get('userEmail'),
      entityType: 'system_config',
      entityId: key,
      detail: `${key}: ${value}`,
    })

    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message, code: 'INVALID_CONFIG_VALUE', key }, 400)
  }
})

// POST /v1/admin/config/batch — 批量更新
adminConfig.post('/batch', async (c) => {
  const { updates } = await c.req.json()
  const userId = c.get('userId')

  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return c.json({ error: 'updates 必须是非空对象 { key: value }' }, 400)
  }

  try {
    const results = setConfigs(updates, userId)

    logAudit({
      action: 'admin.batch_update_config',
      userId,
      userEmail: c.get('userEmail'),
      entityType: 'system_config',
      entityId: 'batch',
      detail: JSON.stringify(Object.keys(updates)),
    })

    return c.json({ success: true, results })
  } catch (e) {
    return c.json({ error: e.message, code: 'INVALID_CONFIG_BATCH' }, 400)
  }
})

// POST /v1/admin/config/reset — 重置为默认值
adminConfig.post('/reset', async (c) => {
  const { key, confirmAll } = await c.req.json().catch(() => ({}))
  const userId = c.get('userId')

  if (!key && confirmAll !== true) {
    return c.json({ error: '全量重置需要 confirmAll: true', code: 'RESET_ALL_CONFIRMATION_REQUIRED' }, 400)
  }

  try {
    const result = resetConfig(key || undefined)
    logAudit({
      action: 'admin.reset_config',
      userId,
      userEmail: c.get('userEmail'),
      entityType: 'system_config',
      entityId: key || 'all',
      detail: key ? `reset: ${key}` : 'reset all',
    })
    return c.json({ success: true, reset: key || 'all', ...result })
  } catch (e) {
    return c.json({ error: e.message, code: 'INVALID_CONFIG_RESET', key: key || null }, 400)
  }
})
