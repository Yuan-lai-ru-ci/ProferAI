/**
 * 后台定时任务调度器
 *
 * 从 index.js 抽离，统一管理所有 setInterval 定时任务。
 * 启动时调用 startSchedulers()，返回 stop 函数用于测试/优雅关闭。
 */
import { db } from './db.js'
import {
  WORKSPACE_GRACE_PERIOD_MS,
  INVITATION_RETENTION_MS,
  SYNC_ENVELOPE_RETENTION_MS,
  FILES_DIR,
} from './config.js'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join as pathJoin } from 'node:path'

/**
 * 启动所有后台定时任务。返回 { stop } 用于清理。
 * 所有 interval 均 .unref()，不阻止进程退出。
 */
export function startSchedulers() {
  const timers = []

  // 1. 过期邀请标记（每 10 分钟）
  timers.push(setInterval(() => {
    try {
      const result = db.prepare(
        "UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?"
      ).run(Date.now())
      if (result.changes > 0) {
        console.log(`[清理] 已将 ${result.changes} 条过期邀请标记为 expired`)
      }
    } catch (err) {
      console.warn('[清理] 邀请过期标记失败:', err.message)
    }
  }, 10 * 60 * 1000).unref())

  // 2. 扣费补扫（每 5 分钟）
  timers.push(setInterval(async () => {
    try {
      const { sweepUnbilledRequests } = await import('./db.js')
      await sweepUnbilledRequests()
    } catch { /* 后台静默，不崩服务器 */ }
  }, 5 * 60 * 1000).unref())

  // 3. 过期黑名单清理（每 30 分钟）
  timers.push(setInterval(() => {
    try {
      db.prepare('DELETE FROM token_blacklist WHERE expires_at < ?').run(Date.now())
    } catch { /* 忽略 */ }
  }, 30 * 60 * 1000).unref())

  // 4. 工作区冷静期满硬删除（每 1 小时）
  timers.push(setInterval(() => {
    try {
      const cutoff = Date.now() - WORKSPACE_GRACE_PERIOD_MS
      const expired = db.prepare(
        'SELECT id FROM workspaces WHERE is_deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?'
      ).all(cutoff)

      if (expired.length === 0) return

      const hardDeleteWorkspace = db.transaction((wsId) => {
        db.prepare('DELETE FROM sync_envelopes WHERE workspace_id = ?').run(wsId)
        db.prepare('DELETE FROM file_manifests WHERE workspace_id = ?').run(wsId)
        db.prepare('DELETE FROM workspace_members WHERE workspace_id = ?').run(wsId)
        db.prepare('DELETE FROM invitations WHERE workspace_id = ?').run(wsId)
        db.prepare('DELETE FROM audit_logs WHERE workspace_id = ?').run(wsId)
        db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId)
      })

      // 防护：FILES_DIR 未配置或指向根路径时，绝不执行目录删除
      const filesDirOk =
        typeof FILES_DIR === 'string' &&
        FILES_DIR.trim().length > 0 &&
        FILES_DIR.trim() !== '/' &&
        FILES_DIR.trim() !== '\\'

      for (const { id } of expired) {
        if (filesDirOk && id) {
          const wsDir = pathJoin(FILES_DIR, id)
          if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true })
        }
        hardDeleteWorkspace(id)
        console.log(`[清理] 已硬删除过期工作区: ${id}`)
      }
    } catch (err) {
      console.warn('[清理] 工作区冷静期满清理失败:', err.message)
    }
  }, 60 * 60 * 1000).unref())

  // 5. 过期历史邀请清理（每 24 小时）
  timers.push(setInterval(() => {
    try {
      const cutoff = Date.now() - INVITATION_RETENTION_MS
      const result = db.prepare(
        "DELETE FROM invitations WHERE status != 'pending' AND created_at < ?"
      ).run(cutoff)
      if (result.changes > 0) {
        console.log(`[清理] 已删除 ${result.changes} 条过期历史邀请`)
      }
    } catch (err) {
      console.warn('[清理] 邀请历史清理失败:', err.message)
    }
  }, 24 * 60 * 60 * 1000).unref())

  // 6. 超期同步信封清理（每 6 小时）
  timers.push(setInterval(() => {
    try {
      const cutoff = Date.now() - SYNC_ENVELOPE_RETENTION_MS
      const result = db.prepare('DELETE FROM sync_envelopes WHERE occurred_at < ?').run(cutoff)
      if (result.changes > 0) {
        console.log(`[清理] 已删除 ${result.changes} 条超期同步信封`)
      }
    } catch (err) {
      console.warn('[清理] 同步信封清理失败:', err.message)
    }
  }, 6 * 60 * 60 * 1000).unref())

  console.log(`[scheduler] 已启动 6 个定时任务`)

  return {
    stop() {
      for (const t of timers) clearInterval(t)
      console.log('[scheduler] 所有定时任务已停止')
    },
  }
}
