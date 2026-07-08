/**
 * New API → Profer 渠道自动同步
 *
 * 每次请求 /v1/account/channels 时调用。从 New API 拉取活跃渠道列表，
 * 对比本地 channels 表：名称/供应商/模型任一变化的更新，不存在的创建。
 * New API 结果缓存 60s，避免高并发时频繁调上游。
 *
 * 同步范围：仅处理 id 前缀为 newapi- 的渠道。管理员手动创建的渠道不受影响。
 *
 * 模型映射规则：
 *   - New API channel.models（逗号分隔）→ Profer models_json [{id, name, enabled:true}]
 *   - New API channel.type → Profer provider（内置映射表）
 *   - apiKey 留空：proxy 转发时用 RELAY_API_KEY
 */
import { RELAY_BASE_URL, NEWAPI_ADMIN_TOKEN, NEWAPI_ADMIN_USER_ID } from '../config.js'

/** 缓存：上次拉取结果 + 时间戳 */
let cachedChannels = null
let cachedAt = 0
const CACHE_TTL_MS = 60_000

/** 全局 model → group 映射（代理转发时用来指定 New API 分组路由） */
let modelGroupMap = new Map()

/** 查询模型所属的 New API 分组（非 default 时代理转发需要加 ?group=xxx） */
export function getGroupForModel(model) {
  return modelGroupMap.get(model) || null
}

/** New API channel type → Profer provider */
const TYPE_TO_PROVIDER = {
  1: 'openai', 8: 'openai', 14: 'anthropic', 15: 'openai',
  16: 'zhipu', 17: 'openai', 27: 'deepseek', 28: 'doubao',
  30: 'minimax', 43: 'deepseek',
}
const DEFAULT_PROVIDER = 'openai'

async function fetchNewApiChannels() {
  if (!NEWAPI_ADMIN_TOKEN) return { ok: false, reason: 'no_admin_token' }
  try {
    const resp = await fetch(`${RELAY_BASE_URL}/api/channel/?p=0&page_size=100`, {
      headers: {
        Authorization: `Bearer ${NEWAPI_ADMIN_TOKEN}`,
        'New-API-User': String(NEWAPI_ADMIN_USER_ID),
      },
      signal: AbortSignal.timeout(10000),
    })
    const text = await resp.text()
    let json = null
    try { json = JSON.parse(text) } catch { return { ok: false, reason: 'invalid_json' } }
    if (json.success === false) return { ok: false, reason: json.message || 'api_error' }
    if (!json.data?.items) return { ok: false, reason: 'no_items' }
    return { ok: true, channels: json.data.items }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/** 单条 New API 渠道 → Profer 格式 */
function mapNewApiChannel(nc) {
  const provider = TYPE_TO_PROVIDER[nc.type] || DEFAULT_PROVIDER
  const modelNames = (nc.models || '').split(',').map(s => s.trim()).filter(Boolean)
  const models = modelNames.map(m => ({ id: m, name: m, enabled: true }))
  return {
    id: `newapi-${nc.id}`,
    name: nc.name || `渠道 #${nc.id}`,
    provider,
    modelsJson: JSON.stringify(models),
  }
}

/** 比较两个模型清单是否一致（按模型 id 排序后逐项比较） */
function modelsMatch(aJson, bJson) {
  try {
    const a = JSON.parse(aJson || '[]')
    const b = JSON.parse(bJson || '[]')
    if (a.length !== b.length) return false
    const aIds = a.map(m => m.id).sort()
    const bIds = b.map(m => m.id).sort()
    return aIds.every((id, i) => id === bIds[i])
  } catch { return false }
}

/**
 * 同步 New API 渠道到 Profer channels 表。
 * 新增不存在的渠道；名称/供应商/模型任一变化即更新。非 newapi-* 渠道不受影响。
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{synced:number, updated:number, skipped:number, error?:string}>}
 */
export async function syncChannelsFromNewApi(db) {
  // 缓存 60s，避免每次请求都调 New API
  if (cachedChannels && (Date.now() - cachedAt) < CACHE_TTL_MS) {
    return await applySync(db, cachedChannels)
  }

  const { ok, channels, reason } = await fetchNewApiChannels()
  if (!ok) {
    // 网络失败时用旧缓存兜底（如有）
    if (cachedChannels) return await applySync(db, cachedChannels)
    return { synced: 0, updated: 0, skipped: 0, error: reason }
  }

  cachedChannels = channels
  cachedAt = Date.now()
  return applySync(db, channels)
}

async function applySync(db, newApiChannels) {
  const existingRows = db.prepare('SELECT id, name, provider, models_json, is_active FROM channels WHERE id LIKE ?').all('newapi-%')
  const existingMap = new Map(existingRows.map(r => [r.id, r]))

  let synced = 0, updated = 0, skipped = 0
  const now = Date.now()

  const insert = db.prepare(
    `INSERT OR IGNORE INTO channels (id, name, provider, api_key_encrypted, base_url, agent_base_url, models_json, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', ?, 1, 'newapi-sync', ?, ?)`
  )
  // 全量更新：名称、供应商、模型列表 —— 任一变化都同步，以 New API 为准
  const updateChannel = db.prepare(
    `UPDATE channels SET name = ?, provider = ?, models_json = ?, is_active = 1, updated_at = ? WHERE id = ?`
  )
  const ensureActive = db.prepare(
    `UPDATE channels SET is_active = 1, updated_at = ? WHERE id = ?`
  )

  /** 检查渠道的 name / provider / models 是否有任何变化 */
  function needsUpdate(existing, mapped) {
    if (existing.name !== mapped.name) return true
    if (existing.provider !== mapped.provider) return true
    if (!modelsMatch(existing.models_json, mapped.modelsJson)) return true
    return false
  }

  // 重建 model → group 映射（代理转发时查此表决定加哪个 ?group= 参数）
  const newModelGroupMap = new Map()
  for (const nc of newApiChannels) {
    if (nc.status !== 1) continue
    const group = nc.group || 'default'
    const modelNames = (nc.models || '').split(',').map(s => s.trim()).filter(Boolean)
    for (const m of modelNames) {
      newModelGroupMap.set(m, group)
    }
  }
  modelGroupMap = newModelGroupMap

  const tx = db.transaction(() => {
    for (const nc of newApiChannels) {
      if (nc.status !== 1) continue
      const mapped = mapNewApiChannel(nc)
      const existing = existingMap.get(mapped.id)

      if (!existing) {
        // 新渠道：创建
        insert.run(mapped.id, mapped.name, mapped.provider, mapped.modelsJson, now, now)
        synced++
      } else if (needsUpdate(existing, mapped)) {
        // 名称 / 供应商 / 模型任一变化 → 全量更新
        updateChannel.run(mapped.name, mapped.provider, mapped.modelsJson, now, mapped.id)
        updated++
      } else {
        // 完全匹配：确保 active=1（防止被手动停用后忘了开）
        if (existing.is_active !== 1) {
          ensureActive.run(now, mapped.id)
        }
        skipped++
      }
    }
  })
  tx()

  if (synced > 0 || updated > 0) {
    console.log(`[newapi-sync] 新增 ${synced}，更新 ${updated}，跳过 ${skipped}（共 ${newApiChannels.length} 条 New API 来源）`)
  }

  // 自动维护 New API 的 abilities 路由表：确保所有渠道的模型在 default 组可路由
  await maintainAbilitiesTable(db, newApiChannels)

  return { synced, updated, skipped }
}

/**
 * 维护 New API 的 abilities 表：对每个活跃渠道的每个模型，确保 default 组有路由条目。
 * 这样代理转发走 default 组时，所有渠道的模型都能被找到，不依赖用户的分组配置。
 * 原分组（特价/vip等）的 abilities 条目不删除，保留其倍率语义。
 */
async function maintainAbilitiesTable(proferDb, newApiChannels) {
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    const newApiDb = new Database('/app/new-api-data/one-api.db', { readonly: false })
    const upsert = newApiDb.prepare(
      `INSERT OR IGNORE INTO abilities ([group], model, channel_id, enabled, priority, weight)
       VALUES ('default', ?, ?, 1, 0, 0)`
    )
    const tx = newApiDb.transaction(() => {
      let count = 0
      for (const nc of newApiChannels) {
        if (nc.status !== 1) continue
        const models = (nc.models || '').split(',').map(s => s.trim()).filter(Boolean)
        for (const m of models) {
          upsert.run(m, nc.id)
          count++
        }
      }
      return count
    })
    const total = tx()
    if (total > 0) {
      console.log(`[newapi-sync] abilities 路由表已维护：${total} 条模型映射`)
    }
  } catch (e) {
    // 无法访问 New API DB 时不阻塞同步
    console.warn('[newapi-sync] 维护 abilities 表失败（New API DB 不可访问）:', e.message)
  }
}
