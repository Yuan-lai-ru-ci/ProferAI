/** 对 Hono 风格 context 写入 CORS 响应头；不负责认证或路由。 */
export function applyCorsHeaders(c, allowedOrigin) {
  const origin = c.req.header('origin')
  if (allowedOrigin && allowedOrigin !== 'none') {
    if (allowedOrigin === '*') {
      c.res.headers.set('Access-Control-Allow-Origin', '*')
    } else {
      const allowedOrigins = allowedOrigin.split(',').map(o => o.trim())
      if (origin && allowedOrigins.includes(origin)) {
        c.res.headers.set('Access-Control-Allow-Origin', origin)
        c.res.headers.set('Vary', 'Origin')
      }
    }
    c.res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  }
}

/** 无论 CORS 是否开放都写入基础安全响应头。 */
export function applySecurityHeaders(c) {
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  c.res.headers.set('X-Permitted-Cross-Domain-Policies', 'none')
}
