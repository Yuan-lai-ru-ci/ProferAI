import { describe, expect, mock, test } from 'bun:test'
import type { GitHubRelease } from '@profer/shared'

// 禁止测试触发真实网络检查或下载。
const check = mock(async () => null)
const download = mock(async () => [])
const on = mock(() => undefined)
let latestRelease: GitHubRelease | null = null
const getLatestRelease = mock(async () => latestRelease)
mock.module('../github-release-service', () => ({ getLatestRelease }))
mock.module('electron-updater', () => ({
  autoUpdater: { checkForUpdates: check, downloadUpdate: download, on },
}))

const { checkForUpdates, getUpdateStatus, initAutoUpdater, cleanupUpdater, isInternalVersion, shouldBlockInternalBaseline } = await import('./auto-updater')

/** 构造一条 Release 替身。 */
function makeRelease(tagName: string, overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    id: 1,
    tag_name: tagName,
    name: `Profer ${tagName}`,
    body: '测试更新说明',
    draft: false,
    prerelease: false,
    created_at: '',
    published_at: '',
    html_url: `https://github.com/Yuan-lai-ru-ci/ProferAI/releases/tag/${tagName}`,
    ...overrides,
  }
}

describe('内测版本基线门禁', () => {
  test('只拦截内测包的同/更低正式基线，不影响更高正式版或正式包', () => {
    expect(isInternalVersion('0.15.85-internal.4')).toBe(true)
    expect(isInternalVersion('0.15.85')).toBe(false)
    expect(shouldBlockInternalBaseline('0.15.85-internal.4', '0.15.85')).toBe(true)
    expect(shouldBlockInternalBaseline('0.15.85-internal.4', '0.15.84')).toBe(true)
    expect(shouldBlockInternalBaseline('0.15.85-internal.4', '0.16.0')).toBe(false)
    expect(shouldBlockInternalBaseline('0.15.85-internal.4', '0.15.85-internal.5')).toBe(false)
    expect(shouldBlockInternalBaseline('0.15.85', '0.15.85')).toBe(false)
  })
})
describe('开发版更新状态', () => {
  test('Given 未打包应用 When 获取初始状态 Then 保持 idle，允许手动检查最新 Release', () => {
    expect(getUpdateStatus()).toEqual({ status: 'idle' })
  })

  test('Given 开发版 When 手动或重复检查 Then 查询 Release 但不触发安装包下载', async () => {
    latestRelease = makeRelease('v1.0.0')
    getLatestRelease.mockClear()
    await checkForUpdates()
    await checkForUpdates()
    expect(getUpdateStatus()).toEqual({ status: 'not-available' })
    expect(check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(getLatestRelease).toHaveBeenCalledTimes(2)
  })

  test('Given 开发版查询 Release 失败 Then 报告错误而不是伪装成已是最新版本', async () => {
    latestRelease = null
    await checkForUpdates()
    const status = getUpdateStatus()
    expect(status.status).toBe('error')
    expect(status.status === 'error' ? status.error : undefined).toContain('无法获取最新版本信息')
    expect(check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  test('Given 开发版发现新 Release Then 提供手动下载地址而不进入自动安装流程', async () => {
    latestRelease = makeRelease('v99.0.0')

    await checkForUpdates()

    expect(getUpdateStatus()).toEqual({
      status: 'available',
      version: '99.0.0',
      releaseNotes: '测试更新说明',
      manualUrl: 'https://github.com/Yuan-lai-ru-ci/ProferAI/releases/tag/v99.0.0',
    })
    expect(check).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })
})

describe('开发版自动检查调度', () => {
  /** 用替身接管定时器，避免等待真实的 10s / 4h，并确认调度参数本身。 */
  async function withCapturedTimers(run: (timer: {
    timeouts: Array<{ handler: () => void; delay: number }>
    intervals: Array<{ handler: () => void; delay: number }>
    cleared: unknown[]
    flush: () => Promise<void>
  }) => Promise<void>): Promise<void> {
    const realSetTimeout = globalThis.setTimeout
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    const timeouts: Array<{ handler: () => void; delay: number }> = []
    const intervals: Array<{ handler: () => void; delay: number }> = []
    const cleared: unknown[] = []
    let token = 0

    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
      timeouts.push({ handler, delay: delay ?? 0 })
      token += 1
      return token as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setTimeout
    globalThis.setInterval = ((handler: () => void, delay?: number) => {
      intervals.push({ handler, delay: delay ?? 0 })
      token += 1
      return token as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof globalThis.setInterval
    globalThis.clearInterval = ((handle: unknown) => {
      cleared.push(handle)
    }) as unknown as typeof globalThis.clearInterval

    try {
      await run({
        timeouts,
        intervals,
        cleared,
        flush: () => new Promise<void>((resolve) => { realSetTimeout(resolve, 0) }),
      })
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    }
  }

  test('Given 开发版启动 When 初始化更新器 Then 保留自动调度但不装配 electron-updater', async () => {
    await withCapturedTimers(async (timer) => {
      on.mockClear()
      check.mockClear()
      getLatestRelease.mockClear()
      latestRelease = null

      const closedHandlers: Array<() => void> = []
      initAutoUpdater({
        on: (event: string, handler: () => void) => {
          if (event === 'closed') closedHandlers.push(handler)
        },
      } as never)

      // 调度与打包版一致：启动 10s 后首次检查 + 每 4 小时一次
      expect(timer.timeouts.map((entry) => entry.delay)).toEqual([10_000])
      expect(timer.intervals.map((entry) => entry.delay)).toEqual([4 * 60 * 60 * 1000])
      // 开发版不装配 electron-updater 事件与安装流程
      expect(on).not.toHaveBeenCalled()
      expect(check).not.toHaveBeenCalled()

      // 触发首次检查：应走开发版路径（查 Release）而不是 electron-updater
      latestRelease = null
      timer.timeouts[0]!.handler()
      await timer.flush()
      expect(getLatestRelease).toHaveBeenCalled()
      expect(check).not.toHaveBeenCalled()
      expect(getUpdateStatus().status).toBe('error')

      // 定时检查走同一条开发版路径
      latestRelease = makeRelease('v1.0.0')
      timer.intervals[0]!.handler()
      await timer.flush()
      expect(getLatestRelease).toHaveBeenCalledTimes(2)
      expect(getUpdateStatus()).toEqual({ status: 'not-available' })

      // 窗口关闭时清理定时器
      expect(closedHandlers).toHaveLength(1)
      closedHandlers[0]!()
      expect(timer.cleared).toHaveLength(1)
      cleanupUpdater()
      expect(timer.cleared).toHaveLength(1)
    })
  })
})
