import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { app } from 'electron'

/**
 * 下载阶段的源回退。
 *
 * 背景：检查阶段早就会按探活顺序换源，但 `downloadUpdate()` 失败只把状态改成 error，
 * 用户点重试仍然打回同一个源。国内源抽风时用户会卡在「下载失败」；一旦落到 GitHub 兜底，
 * 实测只有百 KB/s（200MB+ 的包要半小时）。这里锁定「下载失败必须换下一个源」。
 */

process.env.PROFER_UPDATE_CHECK_DEADLINE_MS = '5_000'
process.env.PROFER_UPDATE_CHECK_TOTAL_DEADLINE_MS = '10_000'
process.env.PROFER_UPDATE_INFLIGHT_STALE_MS = '10_000'

let downloadImpl: () => Promise<unknown> = async () => []
let checkImpl: () => Promise<unknown> = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.16.2' } })
const download = mock(() => downloadImpl())
const check = mock(() => checkImpl())
const setFeedURL = mock(() => undefined)
const updater = {
  checkForUpdates: check,
  downloadUpdate: download,
  setFeedURL,
  on: () => undefined,
  autoDownload: true,
  autoInstallOnAppQuit: true,
}

mock.module('electron-updater', () => ({ autoUpdater: updater }))
mock.module('./update-probe', () => ({
  orderSourcesByReachability: async (sources: unknown[]) => sources,
  describeProbeOutcomes: () => '测试固定顺序',
}))
mock.module('../proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('../github-release-service', () => ({ getLatestRelease: async () => null }))
mock.module('../lifecycle-diagnostics', () => ({ logLifecycle: () => undefined }))

const { checkForUpdates, getUpdateStatus, __resetUpdaterStateForTest } = await import('./auto-updater')

Object.assign(app, { isPackaged: true, getVersion: () => '0.16.1' })

/** 轮询等待异步状态收敛，避免依赖固定 sleep 时长。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('下载失败换源', () => {
  beforeEach(() => {
    __resetUpdaterStateForTest()
    download.mockClear()
    check.mockClear()
    setFeedURL.mockClear()
    checkImpl = async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.16.2' } })
  })

  test('首个源下载失败后自动换下一个源，而不是把错误直接抛给用户', async () => {
    let attempts = 0
    downloadImpl = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('连接被重置')
      return []
    }
    await checkForUpdates()
    await waitFor(() => attempts >= 2)

    expect(download).toHaveBeenCalledTimes(2)
    // 换源前必须重新 setFeedURL 并重新检查：下载地址来自检查结果里的绝对 URL。
    expect(setFeedURL.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(getUpdateStatus().status).toBe('downloading')
  })

  test('所有源都下载失败时才收敛成错误，并说明每个源的失败原因', async () => {
    downloadImpl = async () => {
      throw new Error('网络不可达')
    }

    await checkForUpdates()
    await waitFor(() => getUpdateStatus().status === 'error')

    const status = getUpdateStatus()
    expect(status.status).toBe('error')
    const message = status.status === 'error' ? status.error : ''
    expect(message).toContain('国内更新服务器')
    expect(message).toContain('GitHub Releases')
    expect(download).toHaveBeenCalledTimes(3)
  })

  test('换源期间不会把界面从「下载中」拽回「检查中」', async () => {
    const seen: string[] = []
    let attempts = 0
    downloadImpl = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('连接被重置')
      return []
    }
    checkImpl = async () => {
      seen.push(getUpdateStatus().status)
      return { isUpdateAvailable: true, updateInfo: { version: '0.16.2' } }
    }

    await checkForUpdates()
    await waitFor(() => attempts >= 2)

    // 换源重检发生时，状态必须仍是 downloading（quietStatusUpdates 生效）。
    expect(seen.at(-1)).toBe('downloading')
  })
})
