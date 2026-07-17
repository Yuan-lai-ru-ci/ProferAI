/**
 * Admin 审计验证路由
 *
 * GET /v1/admin/audit/verify — 验证审计日志 hash 链完整性
 * 返回 { valid, totalRows, firstBreak? }，检测是否存在删除/篡改。
 */

import { Hono } from 'hono'
import { verifyAuditChain } from '../../audit.js'

export const adminAudit = new Hono()

adminAudit.get('/verify', (c) => {
  const result = verifyAuditChain()
  if (!result.valid) {
    console.warn(`[审计] ⚠️ hash 链断裂！firstBreak: id=${result.firstBreak}`)
  }
  return c.json(result)
})
