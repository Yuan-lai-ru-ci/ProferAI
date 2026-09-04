/**
 * 自动更新核心模块
 *
 * 检测新版本 → 自动后台下载 → 用户确认后重启安装。
 * 仅在打包后的生产环境中工作。
 */

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { runWithUpdateSourceFallback } from './update-fallback'
import { getUpdateSources, type UpdateSource } from './update-sources'
import { canReplaceUpdateStatus } from './update-state'

/** 当前更新状态 */
let currentStatus: UpdateStatus = { status: 'idle' }

/** 主窗口引用 */
let win: BrowserWindow | null = null

/** 定时检查定时器 */
let checkInterval: ReturnType<typeof setInterval> | null = null

/** 同一时间只允许一个检查/下载流程，防止手动与定时检查互相覆盖状态。 */
let inFlightUpdateCheck: Promise<void> | null = null

/** 更新状态并推送给渲染进程 */
function setStatus(status: UpdateStatus): void {
  if (!canReplaceUpdateStatus(currentStatus, status)) {
    console.log(`[更新] 保留已下载状态，忽略迟到的 ${status.status} 事件`)
    return
  }
  currentStatus = status
  win?.webContents?.send(UPDATER_IPC_CHANNELS.ON_STATUS_CHANGED, status)
}

/** 获取当前更新状态 */
export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 在单一更新源上完整执行“检查 → 下载”。
 * autoDownload 关闭后，下载错误会回到调用方，从而可切换到备用源。
 */
async function checkSource(source: UpdateSource): Promise<boolean> {
  autoUpdater.setFeedURL(source.configuration)
  console.log(`[更新] 尝试更新源: ${source.label}`)

  const result = await autoUpdater.checkForUpdates()
  if (!result?.isUpdateAvailable) {
    return false
  }

  await autoUpdater.downloadUpdate()
  return true
}

async function runUpdateCheck(): Promise<void> {
  setStatus({ status: 'checking' })

  try {
    const didDownload = await runWithUpdateSourceFallback(
      getUpdateSources(),
      checkSource,
      (source, error) => {
        console.warn(`[更新] ${source.label} 不可用，切换备用源:`, errorMessage(error))
      },
    )
    if (!didDownload) console.log('[更新] 当前已是最新版本')
  } catch (error) {
    const message = errorMessage(error)
    console.error('[更新] 所有更新源均不可用:', message)
    setStatus({ status: 'error', error: message })
  }
}

/** 手动触发检查更新 */
export async function checkForUpdates(): Promise<void> {
  // 开发模式不检查更新（electron-updater 的 feed URL 仅在打包后嵌入）
  if (!app.isPackaged) {
    console.log('[更新] 开发模式，跳过更新检查')
    setStatus({ status: 'not-available' })
    return
  }

  // 已在下载中或已下载完成，不重复检查
  if (currentStatus.status === 'downloading' || currentStatus.status === 'downloaded') {
    console.log('[更新] 跳过检查：已在下载中或已下载完成')
    return
  }

  if (inFlightUpdateCheck) {
    console.log('[更新] 合并重复检查请求')
    return inFlightUpdateCheck
  }

  inFlightUpdateCheck = runUpdateCheck().finally(() => {
    inFlightUpdateCheck = null
  })
  return inFlightUpdateCheck
}

/** 退出并安装已下载的更新 */
export function quitAndInstall(): void {
  // 移除所有窗口的 close 监听器，避免 preventDefault 阻止退出
  for (const w of BrowserWindow.getAllWindows()) {
    w.removeAllListeners('close')
  }

  // 延迟调用确保 IPC 响应已发送回渲染进程
  setImmediate(() => {
    autoUpdater.quitAndInstall(true, true)
  })
}

/** 清理更新器资源（定时器等） */
export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow

  // 开发模式不初始化更新检查（feed URL 仅在打包后嵌入）
  if (!app.isPackaged) {
    console.log('[更新] 开发模式，自动更新模块未启用')
    return
  }

  // 应用代理设置 — electron-updater 底层用 Electron net 模块，遵循 HTTPS_PROXY 环境变量
  try {
    const { getEffectiveProxyUrl } = require('../proxy-settings-service') as {
      getEffectiveProxyUrl: () => Promise<string | undefined>
    }
    getEffectiveProxyUrl().then((proxyUrl: string | undefined) => {
      if (proxyUrl) {
        process.env.HTTPS_PROXY = proxyUrl
        process.env.HTTP_PROXY = proxyUrl
        console.log('[更新] 已应用代理:', proxyUrl)
      }
    }).catch(() => {})
  } catch { /* 代理模块不可用时跳过 */ }

  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log('[更新-updater]', ...args),
    warn: (...args: unknown[]) => console.warn('[更新-updater]', ...args),
    error: (...args: unknown[]) => console.error('[更新-updater]', ...args),
    debug: (...args: unknown[]) => console.log('[更新-updater:debug]', ...args),
  }

  // 由 checkSource 显式下载，才能在下载失败后切换另一个更新源。
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // 监听更新事件
  autoUpdater.on('checking-for-update', () => {
    console.log('[更新] 正在检查更新...')
    setStatus({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[更新] 发现新版本:', info.version)
    setStatus({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string'
        ? info.releaseNotes
        : undefined,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setStatus({
      status: 'downloading',
      version: (currentStatus as { version?: string }).version || '',
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[更新] 下载完成:', info.version)
    setStatus({
      status: 'downloaded',
      version: info.version,
    })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[更新] 已是最新版本')
    setStatus({ status: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    console.error('[更新] 更新出错:', err)
    // 当前检查流程会捕获此错误并切换备用源。只有脱离该流程的异常才直接展示。
    if (!inFlightUpdateCheck) setStatus({ status: 'error', error: err.message })
  })

  // 启动后延迟 10 秒首次检查
  setTimeout(() => {
    console.log('[更新] 首次自动检查更新')
    checkForUpdates()
  }, 10_000)

  // 每 4 小时自动检查一次
  checkInterval = setInterval(() => {
    console.log('[更新] 定时自动检查更新')
    checkForUpdates()
  }, 4 * 60 * 60 * 1000)

  // 窗口关闭时清理定时器
  mainWindow.on('closed', () => {
    if (checkInterval) {
      clearInterval(checkInterval)
      checkInterval = null
    }
    win = null
  })

  console.log('[更新] 自动更新模块已初始化（国内主源、GitHub 备用，自动下载）')
}
