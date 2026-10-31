/**
 * 本地任务/日程提醒调度器。
 *
 * 只在 Electron 主进程存活时运行。每条提醒在首次到期及每次推迟重新到期时各通知一次；
 * 未确认的提醒会由渲染进程从 SQLite 恢复为固定通知条。
 */

import { app, BrowserWindow, Notification } from 'electron'
import { claimDuePlanningReminders } from './planning-manager'
import { getSettings } from './settings-service'
import { broadcastPlanningChanged, broadcastPlanningRemindersDue } from './planning-events'
import type { ActivePlanningReminder } from '@profer/shared'

const POLL_INTERVAL_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null
let checking = false

/** 原生通知由主进程发送，窗口被隐藏或未聚焦时也不依赖渲染进程的 Web Notification。 */
function showPlanningSystemNotification(reminder: ActivePlanningReminder): void {
  if (!getSettings().notificationsEnabled || !Notification.isSupported()) return
  // macOS：Electron 的 willPresentNotification 固定返回 UNNotificationPresentationOptionSound，
  // 前台呈现通知必然播放系统提示音（silent 无效）。前台已有常驻提醒条与可配置提示音，
  // 这里跳过系统通知；后台走系统投递时 content.sound 为 nil，不会出声。
  if (process.platform === 'darwin' && app.isActive()) return

  const notification = new Notification({
    title: reminder.targetType === 'todo' ? 'Todo 提醒' : '日程提醒',
    body: reminder.targetTitle,
    silent: true,
  })
  notification.on('click', () => {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (!window) return
    window.show()
    window.focus()
  })
  notification.show()
}

function checkDueReminders(): void {
  if (checking) return
  checking = true
  try {
    const reminders = claimDuePlanningReminders()
    if (reminders.length > 0) {
      for (const reminder of reminders) showPlanningSystemNotification(reminder)
      broadcastPlanningRemindersDue(reminders)
      broadcastPlanningChanged(['reminders'])
    }
  } catch (error) {
    console.error('[任务/日程] 检查提醒失败:', error)
  } finally {
    checking = false
  }
}

export function startPlanningReminderScheduler(): void {
  if (timer) return
  checkDueReminders()
  timer = setInterval(checkDueReminders, POLL_INTERVAL_MS)
}

export function stopPlanningReminderScheduler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
