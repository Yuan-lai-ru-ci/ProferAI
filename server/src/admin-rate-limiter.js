/**
 * Admin 操作频控工具
 *
 * 复用 rate-limiter.js 的滑动窗口，按 admin:action:userId 键限流。
 * 所有限制也可通过环境变量覆盖。
 */

import { rateLimit } from './rate-limiter.js'

/**
 * 按 admin 操作类型限频
 * @param {string} adminUserId - 管理员用户 ID
 * @param {string} action - 操作类型标识（如 'batch-reset', 'grant-credits'）
 * @param {{ windowMs?: number, max?: number }} opts
 * @returns {{ allowed: boolean, retryAfterMs?: number }}
 */
export function adminOpLimit(adminUserId, action, { windowMs = 86400000, max } = {}) {
  const key = `admin:${action}:${adminUserId}`
  return rateLimit(key, windowMs, max)
}

/** 预设限流规则（每天每管理员上限） */
export const ADMIN_OP_LIMITS = {
  'batch-reset':     { max: 3,  windowMs: 86400_000 },
  'grant-credits':   { max: 30, windowMs: 86400_000 },
  'create-order':    { max: 50, windowMs: 86400_000 },
  'confirm-order':   { max: 30, windowMs: 86400_000 },
  'create-channel':  { max: 10, windowMs: 86400_000 },
  'activate-channel':{ max: 5,  windowMs: 86400_000 },
}
