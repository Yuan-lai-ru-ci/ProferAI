import { expect, mock, test } from 'bun:test'
import { app } from 'electron'
import { requiresManualUpdate } from './update-policy'
import { getUpdateSources } from './update-sources'

const check = mock(async () => null)
const download = mock(async () => [])
const install = mock(() => undefined)
const on = mock(() => undefined)
const feed = mock(() => undefined)
const release = mock(async () => null)
const updater = { checkForUpdates: check, downloadUpdate: download, quitAndInstall: install, on, setFeedURL: feed, autoDownload: true, autoInstallOnAppQuit: true }
mock.module('electron-updater', () => ({ autoUpdater: updater }))
mock.module('../github-release-service', () => ({ getLatestRelease: release }))
const { initAutoUpdater, checkForUpdates, quitAndInstall, getUpdateStatus, cleanupUpdater, __resetUpdaterStateForTest } = await import('./auto-updater')

test('Given 预发布版本 When 解析策略 Then 与 build metadata 明确区分', () => {
  for (const version of ['0.17.1-beta.1', '0.17.1-rc.2+build.3', '0.15.85-internal.4']) {
    expect(requiresManualUpdate(version)).toBe(true)
  }
  for (const version of ['0.17.1', '0.17.1+build-beta.1']) expect(requiresManualUpdate(version)).toBe(false)
})

test('Given Beta When 选择各平台与发行版源 Then 即使 override 也没有稳定源', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const edition of ['oss', 'commercial'] as const) {
      expect(getUpdateSources('https://updates.example.com/stable/', platform, edition, '0.17.1-beta.1')).toEqual([])
      expect(getUpdateSources(undefined, platform, edition, '0.17.1').map(source => source.id))
        .toEqual(edition === 'oss' ? ['domestic', 'domestic-fallback', 'github'] : ['domestic', 'domestic-fallback'])
    }
  }
})

test('Given Beta 开发版及打包版 When 初始化、手动检查及安装 Then 无调度、网络和安装副作用', async () => {
  const originalVersion = app.getVersion
  const originalPackaged = app.isPackaged
  const originalTimeout = globalThis.setTimeout
  const originalInterval = globalThis.setInterval
  const timeout = mock(() => 1)
  const interval = mock(() => 2)
  globalThis.setTimeout = timeout as unknown as typeof setTimeout
  globalThis.setInterval = interval as unknown as typeof setInterval
  try {
    for (const isPackaged of [false, true]) {
      __resetUpdaterStateForTest()
      Object.assign(app, { isPackaged, getVersion: () => '0.17.1-beta.1' })
      initAutoUpdater({ on: () => undefined, webContents: { send: () => undefined } } as never)
      await checkForUpdates()
      await checkForUpdates()
      quitAndInstall()
      expect(getUpdateStatus()).toMatchObject({ status: 'error', error: expect.stringContaining('仅支持手动安装') })
      expect(updater.autoDownload).toBe(false)
      expect(updater.autoInstallOnAppQuit).toBe(false)
    }
    for (const operation of [timeout, interval, check, download, install, on, feed, release]) expect(operation).not.toHaveBeenCalled()
  } finally {
    cleanupUpdater()
    __resetUpdaterStateForTest()
    Object.assign(app, { getVersion: originalVersion, isPackaged: originalPackaged })
    globalThis.setTimeout = originalTimeout
    globalThis.setInterval = originalInterval
  }
})
