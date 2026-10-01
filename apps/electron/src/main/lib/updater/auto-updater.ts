/**
 * 自动更新核心模块
 *
 * 打包版：检测新版本 → 自动后台下载 → 用户确认后重启安装。
 * 开发版：只检查最新 Release，并引导手动下载，不尝试覆盖源码目录。
 */

import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'
import type { UpdateStatus } from './updater-types'
import { UPDATER_IPC_CHANNELS } from './updater-types'
import { runWithUpdateSourceFallback } from './update-fallback'
import { getUpdateSources, type UpdateSource } from './update-sources'
import { canReplaceUpdateStatus } from './update-state'
import { getLatestRelease } from '../github-release-service'

const GITHUB_RELEASES_URL = 'https://github.com/Yuan-lai-ru-ci/ProferAI/releases'

/** 当前更新状态 */
// 开发版也支持检查最新 Release；只有“自动下载安装”能力在开发版不可用。
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

  const candidateVersion = result.updateInfo?.version ?? result.versionInfo?.version
  if (candidateVersion && isBlockedInternalUpdate(candidateVersion)) {
    console.log(`[更新] 内测包 ${getCurrentAppVersion()} 忽略同/更低正式基线 ${candidateVersion}`)
    setStatus({ status: 'not-available' })
    return false
  }

  await autoUpdater.downloadUpdate()
  return true
}

export function compareVersions(left: string, right: string): number {
  // 内测包采用 `正式版本-internal.x`，更新判断只比较正式基线三段数字：
  // 0.15.85-internal.4 与 0.15.85 应视为同一正式基线，不能把同基线正式包当更新。
  const parseBaseVersion = (value: string): number[] => (value.replace(/^v/, '').split('-', 1)[0] ?? '').split('.').map((part) => {
    const parsed = Number(part)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const leftParts = parseBaseVersion(left)
  const rightParts = parseBaseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const INTERNAL_VERSION_PATTERN = /^v?\d+\.\d+\.\d+-internal\.\d+$/i

/** 只有明确的内测版本才启用“正式基线”保护，正式版行为保持 electron-updater 原样。 */
export function isInternalVersion(version: string): boolean {
  return INTERNAL_VERSION_PATTERN.test(version.trim())
}

/**
 * electron-updater 使用 semver 比较时，会把同基线正式版视为高于 internal 版。
 * 对当前内测包，仅拒绝同/更低的正式基线；更高正式版本和内测序号升级仍不拦截。
 */
export function shouldBlockInternalBaseline(currentVersion: string, candidateVersion: string): boolean {
  return isInternalVersion(currentVersion)
    && /^v?\d+\.\d+\.\d+(?:\+[\w.-]+)?$/.test(candidateVersion)
    && compareVersions(candidateVersion, currentVersion) <= 0
}

function getCurrentAppVersion(): string {
  return app.getVersion()
}

function isBlockedInternalUpdate(candidateVersion: string): boolean {
  return shouldBlockInternalBaseline(getCurrentAppVersion(), candidateVersion)
}

async function checkDevelopmentUpdate(): Promise<void> {
  setStatus({ status: 'checking' })
  const release = await getLatestRelease()
  // getLatestRelease 只在请求失败时返回 null。必须与「确实没有新版本」区分，
  // 否则断网 / 代理不通 / 触发 GitHub Rate limit 时开发者会看到“已是最新版本”的假象。
  if (!release) {
    setStatus({ status: 'error', error: '无法获取最新版本信息，请检查网络或代理设置' })
    return
  }
  if (release.draft || release.prerelease) {
    setStatus({ status: 'not-available' })
    return
  }
  const version = release.tag_name.replace(/^v/, '')
  if (compareVersions(version, app.getVersion()) <= 0) {
    setStatus({ status: 'not-available' })
    return
  }
  setStatus({
    status: 'available',
    version,
    releaseNotes: release.body || undefined,
    manualUrl: release.html_url || GITHUB_RELEASES_URL,
  })
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
  // 开发版不能把安装包覆盖到源码目录，但可以检查最新 Release，方便开发期间及时获知
  // 新版本；真正安装仍由用户打开发布页下载正式安装包完成。
  if (!app.isPackaged) {
    console.log('[更新] 开发模式，检查 GitHub 最新 Release')
    if (inFlightUpdateCheck) return inFlightUpdateCheck
    inFlightUpdateCheck = checkDevelopmentUpdate()
      .catch((error) => {
        const message = errorMessage(error)
        console.error('[更新] 开发版检查更新失败:', message)
        setStatus({ status: 'error', error: message })
      })
      .finally(() => { inFlightUpdateCheck = null })
    return inFlightUpdateCheck
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
 * 装配 electron-updater（仅在打包版可用：feed URL 在打包时嵌入）。
 *
 * 开发版不装配任何会尝试安装的路径，调度与状态推送由 initAutoUpdater 统一负责。
 */
function setupPackagedAutoUpdater(): void {
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
    if (isBlockedInternalUpdate(info.version)) {
      console.log(`[更新] 内测包 ${getCurrentAppVersion()} 忽略同/更低正式基线 ${info.version}`)
      setStatus({ status: 'not-available' })
      return
    }
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
    const version = (currentStatus as { version?: string }).version || ''
    // 被拒绝的 available 事件不会留下版本；忽略其迟到的进度，避免出现空版本下载状态。
    if (isInternalVersion(getCurrentAppVersion()) && !version) return
    if (version && isBlockedInternalUpdate(version)) {
      console.log(`[更新] 内测包拒绝同/更低正式基线下载进度 ${version}`)
      setStatus({ status: 'not-available' })
      return
    }
    setStatus({
      status: 'downloading',
      version,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (isBlockedInternalUpdate(info.version)) {
      console.log(`[更新] 内测包拒绝同/更低正式基线下载完成 ${info.version}`)
      setStatus({ status: 'not-available' })
      return
    }
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
}

/**
 * 初始化自动更新
 *
 * @param mainWindow - 主窗口实例，用于推送更新状态
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow

  // 开发版不能把安装包覆盖到源码目录，feed URL 也只在打包后嵌入，因此不装配
  // electron-updater；但下面的调度照旧执行，走 checkDevelopmentUpdate 检查最新
  // Release 并引导手动下载（否则开发期间完全感知不到新版本）。
  if (app.isPackaged) {
    setupPackagedAutoUpdater()
  } else {
    console.log('[更新] 开发模式：跳过自动安装装配，仅检查最新 Release')
  }

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

  console.log(
    app.isPackaged
      ? '[更新] 自动更新模块已初始化（国内主源、GitHub 备用，自动下载）'
      : '[更新] 开发版更新检查已初始化（仅检查最新 Release，提示手动下载）',
  )
}
