import crypto from 'node:crypto'
import { broadcastEvent } from '../event-bus.js'

function targetsFor(db, workspaceId, targetType, targetId) {
  const table = targetType === 'todo' ? 'planning_todos' : 'planning_calendar_events'
  const target = db.prepare(`SELECT title, created_by, assignee_id FROM ${table} WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).get(workspaceId, targetId)
  if (!target) return null
  return { title: target.title, recipients: [...new Set([target.created_by, target.assignee_id].filter(Boolean))] }
}

/** 幂等分发到期提醒；返回本轮实际创建的用户级投递，供 SSE 使用。 */
export function dispatchDuePlanningReminders(db, now = Date.now()) {
  const due = db.prepare(`SELECT * FROM planning_reminders WHERE status='pending' AND trigger_at <= ? ORDER BY trigger_at`).all(now)
  const deliveries = []
  const dispatchOne = db.transaction((reminder) => {
    const target = targetsFor(db, reminder.workspace_id, reminder.target_type, reminder.target_id)
    if (!target) {
      db.prepare("UPDATE planning_reminders SET status='cancelled', updated_at=? WHERE workspace_id=? AND id=?").run(now, reminder.workspace_id, reminder.id)
      return
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO planning_reminder_deliveries
      (workspace_id,id,reminder_id,recipient_id,status,delivered_at,created_at,updated_at)
      VALUES (?,?,?,?,'pending',?,?,?)`)
    for (const recipientId of target.recipients) {
      const id = crypto.randomUUID()
      if (insert.run(reminder.workspace_id, id, reminder.id, recipientId, now, now, now).changes > 0) {
        deliveries.push({ id, workspaceId: reminder.workspace_id, reminderId: reminder.id, recipientId, targetType: reminder.target_type, targetId: reminder.target_id, targetTitle: target.title, triggerAt: reminder.trigger_at })
      }
    }
    db.prepare("UPDATE planning_reminders SET status='dispatched', dispatched_at=?, updated_at=? WHERE workspace_id=? AND id=? AND status='pending'").run(now, now, reminder.workspace_id, reminder.id)
  })
  for (const reminder of due) dispatchOne(reminder)
  // 初始投递与稍后提醒都通过同一 SSE 事件通知。last_notified_at 是可恢复的通知租约：
  // 客户端断线不会丢失，因为 active deliveries API 仍是权威来源。
  const snoozed = db.prepare(`SELECT d.id, d.workspace_id, d.reminder_id, d.recipient_id, r.target_type, r.target_id, r.trigger_at,
    COALESCE(t.title, e.title, '已删除事项') AS target_title
    FROM planning_reminder_deliveries d JOIN planning_reminders r ON r.workspace_id=d.workspace_id AND r.id=d.reminder_id
    LEFT JOIN planning_todos t ON r.target_type='todo' AND t.workspace_id=r.workspace_id AND t.id=r.target_id
    LEFT JOIN planning_calendar_events e ON r.target_type='calendar_event' AND e.workspace_id=r.workspace_id AND e.id=r.target_id
    WHERE d.status='pending' AND d.snoozed_until IS NOT NULL AND d.snoozed_until <= ? AND d.last_notified_at IS NULL`).all(now)
  const markNotified = db.prepare('UPDATE planning_reminder_deliveries SET last_notified_at=?,updated_at=? WHERE workspace_id=? AND id=? AND last_notified_at IS NULL')
  for (const row of snoozed) {
    if (markNotified.run(now, now, row.workspace_id, row.id).changes > 0) deliveries.push({ id: row.id, workspaceId: row.workspace_id, reminderId: row.reminder_id, recipientId: row.recipient_id, targetType: row.target_type, targetId: row.target_id, targetTitle: row.target_title, triggerAt: row.trigger_at })
  }
  for (const delivery of deliveries) broadcastEvent(delivery.workspaceId, 'planning_reminder_due', delivery)
  return deliveries
}

export function listActiveDeliveries(db, workspaceId, recipientId) {
  return db.prepare(`SELECT d.id, d.reminder_id, d.status, d.snoozed_until, d.delivered_at, d.last_notified_at, r.trigger_at,
    r.target_type, r.target_id, COALESCE(t.title, e.title, '已删除事项') AS target_title
    FROM planning_reminder_deliveries d JOIN planning_reminders r ON r.workspace_id=d.workspace_id AND r.id=d.reminder_id
    LEFT JOIN planning_todos t ON r.target_type='todo' AND t.workspace_id=r.workspace_id AND t.id=r.target_id
    LEFT JOIN planning_calendar_events e ON r.target_type='calendar_event' AND e.workspace_id=r.workspace_id AND e.id=r.target_id
    WHERE d.workspace_id=? AND d.recipient_id=? AND d.status='pending'
    ORDER BY COALESCE(d.snoozed_until, r.trigger_at)`).all(workspaceId, recipientId)
}
