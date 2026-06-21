/**
 * 简易内存滑动窗口限流器
 *
 * 按 key（通常为 IP 或 email+action 组合）追踪请求频率。
 * 单一服务器进程内有效，重启后清空。
 */

const buckets = new Map()

/** 清理整个限流器（测试用） */
export function clearRateLimiter() {
  buckets.clear()
}

/**
 * @param {string} key  限流键（如 IP 或 "login:192.168.1.1"）
 * @param {number} windowMs  时间窗口（毫秒）
 * @param {number} max  窗口内最大请求数
 * @returns {{ allowed: boolean, retryAfterMs?: number }}
 */
export function rateLimit(key, windowMs, max) {
  const now = Date.now()
  let bucket = buckets.get(key)

  if (!bucket) {
    bucket = { timestamps: [], first: now }
    buckets.set(key, bucket)
  }

  // 淘汰窗口之外的记录
  const cutoff = now - windowMs
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
    bucket.timestamps.shift()
  }

  if (bucket.timestamps.length >= max) {
    const retryAfterMs = bucket.timestamps[0] + windowMs - now + 1
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) }
  }

  bucket.timestamps.push(now)
  return { allowed: true }
}

// 每 5 分钟清理一次过期 bucket，防止内存泄漏
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    // 如果一个 bucket 的最新时间戳已超过 30 分钟，整组删除
    const newest = bucket.timestamps.length > 0
      ? bucket.timestamps[bucket.timestamps.length - 1]
      : bucket.first
    if (now - newest > 30 * 60 * 1000) {
      buckets.delete(key)
    }
  }
}, 5 * 60 * 1000).unref()
