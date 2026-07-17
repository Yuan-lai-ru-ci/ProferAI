/**
 * 团队桌面通知服务
 *
 * 监听 SSE 事件，在窗口不在前台时弹出 Electron 原生桌面通知。
 * SSE 不可用时，通过 sync-manager 检测变更作为降级通知路径。
 */

import { Notification, BrowserWindow } from 'electron'
import type { SSEEvent } from './sse-client'

// ===== 通知设置 =====

interface NotificationSettings {
  enabled: boolean
  fileUpload: boolean
  fileDelete: boolean
  memberJoin: boolean
  memberLeave: boolean
  invitation: boolean
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  fileUpload: true,
  fileDelete: true,
  memberJoin: true,
  memberLeave: false,
  invitation: true,
}

// ===== 通知服务 =====

class TeamNotificationService {
  private settings: NotificationSettings = { ...DEFAULT_SETTINGS }
  private notificationBuffer: Array<{ title: string; body: string }> = []
  private bufferTimer: ReturnType<typeof setTimeout> | null = null
  private readonly BUFFER_WINDOW_MS = 30_000 // 30s 缓冲窗口
  private readonly MAX_BUFFER_SIZE = 5       // 超过此数量则合并
  private currentUserId = ''

  /** 设置当前用户 ID（用于过滤自己的操作） */
  setCurrentUserId(userId: string): void {
    this.currentUserId = userId
  }

  /** 更新通知设置 */
  updateSettings(partial: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...partial }
  }

  /** 获取当前设置 */
  getSettings(): NotificationSettings {
    return { ...this.settings }
  }

  /** 处理 SSE 事件并决定是否发通知 */
  handleSSEEvent(event: SSEEvent): void {
    if (!this.settings.enabled) return

    // 过滤自己的操作
    const eventUserId = (event.data as Record<string, string>)?.userId
    if (eventUserId && eventUserId === this.currentUserId) return

    // 检查窗口是否在前台
    const isWindowFocused = BrowserWindow.getAllWindows().some(
      (w) => w.isFocused() && !w.isMinimized(),
    )

    // 检查用户是否在看相关工作区（简化：仅检查聚焦状态）
    if (isWindowFocused) return

    // 按事件类型分发
    const { body, title } = this.buildNotification(event)
    if (!body) return

    this.enqueue(title, body)
  }

  /** 从 sync-manager 变更信封构建通知（降级路径） */
  notifyFromSync(workspaceId: string, eventType: string, data: Record<string, unknown>): void {
    if (!this.settings.enabled) return

    const eventUserId = data.userId as string | undefined
    if (eventUserId && eventUserId === this.currentUserId) return

    const isWindowFocused = BrowserWindow.getAllWindows().some(
      (w) => w.isFocused() && !w.isMinimized(),
    )
    if (isWindowFocused) return

    const notification = this.buildNotificationFromSync(workspaceId, eventType, data)
    if (!notification.body) return

    this.enqueue(notification.title, notification.body)
  }

  /** 入队通知，使用缓冲窗口防抖 */
  private enqueue(title: string, body: string): void {
    this.notificationBuffer.push({ title, body })

    if (this.notificationBuffer.length >= this.MAX_BUFFER_SIZE) {
      // 立即合并显示
      this.flush(true)
      return
    }

    if (!this.bufferTimer) {
      this.bufferTimer = setTimeout(() => {
        this.flush(false)
      }, this.BUFFER_WINDOW_MS)
    }
  }

  /** 实际弹出通知 */
  private flush(forceBatched: boolean): void {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer)
      this.bufferTimer = null
    }

    const pending = [...this.notificationBuffer]
    this.notificationBuffer = []

    if (pending.length === 0) return

    if (pending.length >= this.MAX_BUFFER_SIZE || forceBatched) {
      // 合并通知
      const title = `${pending.length} 项团队更新`
      const body = pending.slice(0, 3).map((n) => n.body).join('\n')
        + (pending.length > 3 ? `\n... 还有 ${pending.length - 3} 项` : '')
      this.showNotification(title, body)
    } else {
      // 逐条发送
      for (const n of pending) {
        this.showNotification(n.title, n.body)
      }
    }
  }

  /** 弹出 Electron 原生通知 */
  private showNotification(title: string, body: string): void {
    try {
      const notification = new Notification({
        title,
        body: body.slice(0, 200), // 限制长度
        silent: true, // 不发声（遵循用户已有的声音设置）
      })

      notification.on('click', () => {
        // 点击通知时聚焦窗口
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
      })

      notification.show()
    } catch (err) {
      // 在某些系统上 Notification 可能不可用，静默忽略
      console.warn('[通知] 弹出失败:', err)
    }
  }

  /** 构建通知消息 */
  private buildNotification(event: SSEEvent): { title: string; body: string } {
    const data = event.data as Record<string, unknown>
    const userName = (data.uploadedByName as string) || (data.displayName as string) || ''

    switch (event.type) {
      case 'file_updated': {
        if (!this.settings.fileUpload) return { title: '', body: '' }
        const path = (data.path as string) || ''
        const fileName = path.split('/').pop() || path
        const action = data.action === 'rename' ? '重命名了' : data.action === 'move' ? '移动了' : '上传了'
        return {
          title: '📄 文件更新',
          body: userName ? `${userName} ${action} ${fileName}` : `文件已${action}: ${fileName}`,
        }
      }
      case 'file_deleted': {
        if (!this.settings.fileDelete) return { title: '', body: '' }
        const path = (data.path as string) || ''
        const fileName = path.split('/').pop() || path
        return {
          title: '🗑 文件已删除',
          body: userName ? `${userName} 删除了 ${fileName}` : `已删除: ${fileName}`,
        }
      }
      case 'member_changed': {
        if (data.action === 'joined' || data.action === 'invited') {
          if (!this.settings.memberJoin) return { title: '', body: '' }
          return {
            title: '👋 新成员',
            body: userName ? `${userName} 加入了工作区` : '有新成员加入工作区',
          }
        }
        if (data.action === 'removed' || data.action === 'left') {
          if (!this.settings.memberLeave) return { title: '', body: '' }
          return {
            title: '👤 成员变动',
            body: userName ? `${userName} 离开了工作区` : '有成员离开了工作区',
          }
        }
        return { title: '', body: '' }
      }
      case 'invitation_changed': {
        if (!this.settings.invitation) return { title: '', body: '' }
        return {
          title: '📨 邀请更新',
          body: '有成员处理了工作区邀请',
        }
      }
      default:
        return { title: '', body: '' }
    }
  }

  /** 从 sync 信封构建通知 */
  private buildNotificationFromSync(
    _workspaceId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): { title: string; body: string } {
    const userName = (data.uploadedByName as string) || ''
    switch (eventType) {
      case 'file_updated':
        if (!this.settings.fileUpload) return { title: '', body: '' }
        return { title: '📄 文件更新', body: userName ? `${userName} 上传了新文件` : '工作区有新文件' }
      case 'file_deleted':
        if (!this.settings.fileDelete) return { title: '', body: '' }
        return { title: '🗑 文件已删除', body: '有文件被删除' }
      default:
        return { title: '', body: '' }
    }
  }
}

export const teamNotificationService = new TeamNotificationService()
