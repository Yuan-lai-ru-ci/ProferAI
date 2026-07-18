/**
 * Rate Limiting 中间件
 *
 * 基于 IP 地址的简单速率限制，防止 API 滥用。
 * 内存存储（进程重启后重置），适合单实例部署。
 * 多实例部署建议使用 Redis 共享存储。
 */

/**
 * 创建速率限制中间件
 *
 * @param {number} maxRequests - 时间窗口内允许的最大请求数
 * @param {number} windowMs - 时间窗口（毫秒）
 * @param {string} message - 超限时的错误消息
 * @returns {Function} Hono 中间件
 */
export function createRateLimiter(maxRequests, windowMs, message = '请求过于频繁，请稍后再试') {
  // 存储格式: { [ip]: { count: number, resetAt: number } }
  const store = new Map()

  // 定期清理过期记录（每分钟清理一次）
  setInterval(() => {
    const now = Date.now()
    for (const [ip, data] of store.entries()) {
      if (now > data.resetAt) {
        store.delete(ip)
      }
    }
  }, 60_000)

  return async (c, next) => {
    // 获取客户端 IP（支持代理）
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
            || c.req.header('x-real-ip')
            || 'unknown'

    const now = Date.now()
    let record = store.get(ip)

    // 初始化或重置窗口
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs }
      store.set(ip, record)
    }

    record.count++

    // 检查是否超限
    if (record.count > maxRequests) {
      const retryAfter = Math.ceil((record.resetAt - now) / 1000)
      c.res.headers.set('Retry-After', String(retryAfter))
      c.res.headers.set('X-RateLimit-Limit', String(maxRequests))
      c.res.headers.set('X-RateLimit-Remaining', '0')
      c.res.headers.set('X-RateLimit-Reset', String(Math.floor(record.resetAt / 1000)))

      return c.json({
        error: 'Too Many Requests',
        message,
        retryAfter,
      }, 429)
    }

    // 添加速率限制响应头
    c.res.headers.set('X-RateLimit-Limit', String(maxRequests))
    c.res.headers.set('X-RateLimit-Remaining', String(maxRequests - record.count))
    c.res.headers.set('X-RateLimit-Reset', String(Math.floor(record.resetAt / 1000)))

    await next()
  }
}

/**
 * 预设的速率限制器
 */

// 严格限制（公开 API）：每分钟最多 10 次
export const strictRateLimit = createRateLimiter(
  10,
  60_000,
  '请求过于频繁，每分钟最多 10 次请求'
)

// 宽松限制（认证 API）：每分钟最多 60 次
export const relaxedRateLimit = createRateLimiter(
  60,
  60_000,
  '请求过于频繁，每分钟最多 60 次请求'
)

// 登录限制：每 15 分钟最多 5 次
export const loginRateLimit = createRateLimiter(
  5,
  15 * 60_000,
  '登录尝试过于频繁，请 15 分钟后再试'
)
