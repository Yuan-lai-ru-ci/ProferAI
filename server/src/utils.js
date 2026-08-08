import crypto from 'crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join as pathJoin, sep as pathSep } from 'node:path'
import { TRUST_PROXY } from './config.js'

// ===== 输入校验 =====
export function validatePassword(password) {
  if (!password || typeof password !== 'string') return '密码不能为空'
  if (password.length < 8) return '密码至少 8 个字符'
  if (!/[a-z]/.test(password)) return '密码需包含小写字母'
  if (!/[A-Z]/.test(password)) return '密码需包含大写字母'
  if (!/[0-9]/.test(password)) return '密码需包含数字'
  return null
}

export function validateEmail(email) {
  if (!email || typeof email !== 'string') return '邮箱不能为空'
  // 简单但实用的格式校验
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式无效'
  return null
}

// ===== 密码哈希 =====
// 每用户随机盐，格式 salt:hash；兼容旧固定盐格式（无冒号前缀）
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || stored.length < 32) return false
  const idx = stored.indexOf(':')
  if (idx !== -1) {
    // 新格式 salt:hash
    const salt = stored.slice(0, idx)
    const expected = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex')
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(stored.slice(idx + 1)))
  }
  // 旧格式：固定盐，兼容已有用户
  const expected = crypto.pbkdf2Sync(password, 'proma-salt', 100000, 64, 'sha512').toString('hex')
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(stored))
}

// ===== 无状态令牌哈希 =====
// 令牌（API Key / refresh / relay）随机熵高，无需加盐：sha256 摘要即防库泄后反推。
// 所有令牌类凭证只存 hash、按 hash 反查；明文仅出现在响应与内存中。
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

// ===== 文件系统 =====
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 防路径遍历：pathJoin 会规一化 .. 段，再检查结果是否仍在 root 之下 */
export function safePath(root, ...parts) {
  const full = pathJoin(root, ...parts)
  // 确保 root 以路径分隔符结尾，兼容 Windows (\) 和 POSIX (/)
  const rootPrefix = pathJoin(root) + pathSep
  if (full !== pathJoin(root) && !full.startsWith(rootPrefix)) return null
  return full
}

// ===== 网络工具 =====

/** 从请求中提取客户端真实 IP。
 *
 * 安全策略：
 *  - 直连部署（TRUST_PROXY=false）：优先取 socket 真实对端地址（@hono/node-server 通过
 *    c.env.incoming 暴露原生 IncomingMessage），XFF/X-Real-IP 完全不可信（可伪造），
 *    否则 register/login 限流退化为全局共享桶（5 个请求锁死所有用户）。
 *  - 反代部署（TRUST_PROXY=true，nginx 已设置 X-Forwarded-For）：信任 XFF 首项，
 *    此时反代负责剥离客户端伪造的头。
 */
export function clientIP(c) {
  if (TRUST_PROXY) {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded) return forwarded.split(',')[0].trim()
    const real = c.req.header('x-real-ip')
    if (real) return real.trim()
  }
  const remote = c.env?.incoming?.socket?.remoteAddress || c.env?.incoming?.connection?.remoteAddress
  if (remote) return remote
  return 'unknown'
}
