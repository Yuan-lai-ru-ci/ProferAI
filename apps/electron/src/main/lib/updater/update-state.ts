import type { UpdateStatus } from './updater-types'

/**
 * 已下载的安装包是不可逆的本地事实。迟到的检查或错误事件不能覆盖它，
 * 否则用户会看见“检查失败”而失去“立即重启更新”入口。
 */
export function canReplaceUpdateStatus(current: UpdateStatus, next: UpdateStatus): boolean {
  return current.status !== 'downloaded' || next.status === 'downloaded'
}
