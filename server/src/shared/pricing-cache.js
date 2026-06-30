/**
 * 定价缓存 — 60 秒 TTL，避免每次请求都查 DB
 *
 * 由 middleware/credits.js 和 routes/proxy/chat.js 共享。
 *
 * getPricingMap 基于 better-sqlite3，本身是同步的，因此缓存可以同步加载：
 * 冷启动首个请求直接同步查一次 DB，绝不返回空表。
 * （旧实现首请求返回 {} → findBillingRate 回退默认费率 → 服务重启后头几个
 *   请求按 input1/output3 误计费，这里彻底消除该窗口。）
 */
import { getPricingMap } from '../db.js'

let _cache = null
let _cacheAt = 0
const TTL = 60_000

export async function refreshPricingCache() {
  return refreshPricingCacheSync()
}

/** 同步刷新缓存并返回最新定价表。 */
function refreshPricingCacheSync() {
  _cache = getPricingMap()
  _cacheAt = Date.now()
  return _cache
}

/**
 * 获取缓存的定价表（始终返回有效数据，绝不返回空表）。
 * - 缓存有效 → 直接返回
 * - 缓存过期 → 返回旧缓存，后台同步刷新（getPricingMap 同步，开销极小）
 * - 无缓存（冷启动）→ 同步加载一次，保证首请求即拿到真实费率
 */
export function getPricingCached() {
  const now = Date.now()
  if (_cache && (now - _cacheAt) < TTL) return _cache
  try {
    return refreshPricingCacheSync()
  } catch (e) {
    // DB 暂时不可用：有旧缓存就用旧的，否则返回空表（调用方回退默认费率）
    console.warn('[pricing-cache] 刷新失败:', e?.message)
    return _cache || {}
  }
}

/** 模块加载时同步预热缓存。 */
try {
  refreshPricingCacheSync()
} catch (e) {
  console.warn('[pricing-cache] 预热失败:', e?.message)
}
