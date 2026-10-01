import { expect, mock, test } from 'bun:test'
import { app } from 'electron'

interface MockInfo { version: string }
interface MockResult { isUpdateAvailable: boolean; updateInfo: MockInfo }
const handlers = new Map<string, (info: MockInfo) => void>()
const sent: Array<{ status: string }> = []
let candidate = '0.15.85'
let failCount = 0
const check = mock(async (): Promise<MockResult> => {
  if (failCount-- > 0) throw new Error('模拟更新源不可用')
  handlers.get('update-available')?.({ version: candidate })
  return { isUpdateAvailable: true, updateInfo: { version: candidate } }
})
const download = mock(async () => ['mock-installer'])
const setFeedURL = mock((_configuration: unknown) => undefined)
const updater = {
  checkForUpdates: check, downloadUpdate: download, setFeedURL,
  on: (event: string, handler: (info: MockInfo) => void) => { handlers.set(event, handler) },
  autoDownload: true, autoInstallOnAppQuit: true,
}
mock.module('electron-updater', () => ({ autoUpdater: updater }))
mock.module('../github-release-service', () => ({ getLatestRelease: mock(async () => null) }))
mock.module('../proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
const { checkForUpdates, getUpdateStatus, initAutoUpdater, cleanupUpdater } = await import('./auto-updater')

test('包态：内测同/低正式基线零提示零下载；多源回退、更高版本及正式包保真', async () => {
  const originalVersion = app.getVersion
  const originalPackaged = app.isPackaged
  const originalTimeout = globalThis.setTimeout
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  // preload 已统一 mock electron，直接配置同一 app 对象，避免二次 mock 被 Bun 忽略。
  Object.assign(app, { isPackaged: true, getVersion: () => '0.15.85-internal.4' })
  globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout
  globalThis.setInterval = (() => 2) as unknown as typeof setInterval
  globalThis.clearInterval = (() => undefined) as typeof clearInterval
  try {
    initAutoUpdater({ on: () => undefined, webContents: { send: (_channel: string, status: { status: string }) => sent.push(status) } } as never)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    for (const version of ['0.15.85', '0.15.84']) {
      candidate = version
      sent.length = 0
      await checkForUpdates()
      handlers.get('update-downloaded')?.({ version })
      handlers.get('download-progress')?.({ percent: 50, transferred: 5, total: 10, bytesPerSecond: 1 } as never)
      expect(download).not.toHaveBeenCalled()
      expect(getUpdateStatus()).toEqual({ status: 'not-available' })
      expect(sent.some(status => ['available', 'downloading', 'downloaded'].includes(status.status))).toBe(false)
    }
    // 两个国内源不可达，GitHub同基线也不得下载。
    candidate = '0.15.85'
    failCount = 2
    setFeedURL.mockClear()
    await checkForUpdates()
    expect(setFeedURL).toHaveBeenCalledTimes(3)
    expect(download).not.toHaveBeenCalled()
    // 正式包仍沿原有 electron-updater 结果下载。
    Object.assign(app, { getVersion: () => '0.15.84' })
    await checkForUpdates()
    expect(download).toHaveBeenCalledTimes(1)
    expect(getUpdateStatus()).toMatchObject({ status: 'available', version: '0.15.85' })
    Object.assign(app, { getVersion: () => '0.15.85-internal.4' })
    candidate = '0.16.0'
    failCount = 2
    setFeedURL.mockClear()
    await checkForUpdates()
    expect(setFeedURL).toHaveBeenCalledTimes(3)
    expect(download).toHaveBeenCalledTimes(2)
    expect(getUpdateStatus()).toMatchObject({ status: 'available', version: '0.16.0' })
    handlers.get('update-downloaded')?.({ version: candidate })
    expect(getUpdateStatus()).toEqual({ status: 'downloaded', version: '0.16.0' })
  } finally {
    cleanupUpdater()
    Object.assign(app, { isPackaged: originalPackaged, getVersion: originalVersion })
    globalThis.setTimeout = originalTimeout
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
  }
})
