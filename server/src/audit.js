/**
 * 审计日志工具
 *
 * 记录关键操作：登录/注册/登出、文件上传删除移动、成员邀请移除、工作区创建删除。
 */

import { db } from './db.js'

/**
 * @param {object} opts
 * @param {string} opts.action  操作类型，如 'login' 'upload' 'member.invite'
 * @param {string} [opts.workspaceId]
 * @param {string} [opts.userId]
 * @param {string} [opts.userEmail]
 * @param {string} [opts.entityType]
 * @param {string} [opts.entityId]
 * @param {string} [opts.detail]
 */
export function logAudit(opts) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (workspace_id, user_id, user_email, action, entity_type, entity_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.workspaceId || '',
      opts.userId || '',
      opts.userEmail || '',
      opts.action,
      opts.entityType || '',
      opts.entityId || '',
      opts.detail || '',
      Date.now(),
    )
  } catch (err) {
    console.warn('[审计] 写入失败:', err.message)
  }
}
