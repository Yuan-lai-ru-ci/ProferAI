/**
 * 审计日志工具 — 带 hash-chain 完整性保护
 *
 * 每条日志 = SHA256(prev_hash | action | userId | entityType | entityId | detail | createdAt | nonce)
 * 链上任意删改会断链，可通过 GET /v1/admin/audit/verify 检测。
 */

import crypto from 'crypto'
import { db } from './db.js'

/**
 * @param {object} opts
 * @param {string} opts.action  操作类型
 * @param {string} [opts.workspaceId]
 * @param {string} [opts.userId]
 * @param {string} [opts.userEmail]
 * @param {string} [opts.entityType]
 * @param {string} [opts.entityId]
 * @param {string} [opts.detail]
 */
export function logAudit(opts) {
  try {
    // 获取上一条 hash 用于链式校验
    const lastRow = db.prepare('SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get()
    const prevHash = lastRow?.row_hash || '0000000000000000000000000000000000000000000000000000000000000000'

    const nonce = crypto.randomBytes(8).toString('hex')
    const now = Date.now()

    const payload = [
      prevHash,
      opts.action,
      opts.userId || '',
      opts.entityType || '',
      opts.entityId || '',
      opts.detail || '',
      String(now),
      nonce,
    ].join('|')

    const rowHash = crypto.createHash('sha256').update(payload).digest('hex')

    db.prepare(`
      INSERT INTO audit_logs (workspace_id, user_id, user_email, action, entity_type, entity_id, detail, created_at, prev_hash, row_hash, nonce)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.workspaceId || '',
      opts.userId || '',
      opts.userEmail || '',
      opts.action,
      opts.entityType || '',
      opts.entityId || '',
      opts.detail || '',
      now,
      prevHash,
      rowHash,
      nonce,
    )
  } catch (err) {
    console.warn('[审计] 写入失败:', err.message)
  }
}

/**
 * 验证审计日志 hash 链完整性
 * @returns {{ valid: boolean, totalRows: number, firstBreak?: number }}
 */
export function verifyAuditChain() {
  const rows = db.prepare('SELECT id, row_hash, prev_hash, action, user_id, entity_type, entity_id, detail, created_at, nonce FROM audit_logs ORDER BY id ASC').all()
  let prevHash = '0000000000000000000000000000000000000000000000000000000000000000'

  for (const row of rows) {
    const payload = [
      prevHash,
      row.action,
      row.user_id || '',
      row.entity_type || '',
      row.entity_id || '',
      row.detail || '',
      String(row.created_at),
      row.nonce || '',
    ].join('|')

    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex')
    if (expectedHash !== row.row_hash) {
      return { valid: false, totalRows: rows.length, firstBreak: row.id }
    }
    prevHash = row.row_hash
  }

  return { valid: true, totalRows: rows.length }
}
