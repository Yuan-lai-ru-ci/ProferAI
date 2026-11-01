/**
 * 主进程生命周期诊断日志（退出 / 更新）。
 *
 * 为什么单独做一份：用户反馈「更新很慢」「旧进程关不掉」时，我们过去拿不到任何现场证据——
 * 主进程只往 console 打日志，`app.getPath('logs')` 目录是空的，而启动失败对话框却让用户
 * 去那里找日志。于是每次排查都只能靠猜。
 *
 * 这里只记录**低频、有诊断价值**的节点（退出清理结果、更新源选择、下载失败/换源、
 * 安装与强制退出），不接管普通 console 输出，避免变成又一个没人看的日志洪流。
 *
 * 落盘位置就是 `app.getPath('logs')`：
 * - macOS: ~/Library/Logs/Profer/main-lifecycle.log
 * - Windows: %APPDATA%\Profer\logs\main-lifecycle.log
 */

import { app } from 'electron'
import { appendDevDiagnostic } from './dev-diagnostics-log'

export const LIFECYCLE_LOG_FILE = 'main-lifecycle.log'

/** 解析日志目录；app 尚未 ready 或路径不可用时返回 null（诊断失败绝不阻断业务）。 */
export function resolveLifecycleLogDir(): string | null {
  try {
    return app.getPath('logs')
  } catch {
    return null
  }
}

/**
 * 追加一条生命周期记录。
 *
 * 调用方无需 await：写入失败只影响可观测性，绝不能影响退出或更新本身。
 */
export function logLifecycle(event: string, detail: Record<string, unknown> = {}): void {
  const dir = resolveLifecycleLogDir()
  if (!dir) return
  appendDevDiagnostic(dir, LIFECYCLE_LOG_FILE, {
    at: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
    version: (() => {
      try {
        return app.getVersion()
      } catch {
        return undefined
      }
    })(),
    event,
    ...detail,
  })
}
