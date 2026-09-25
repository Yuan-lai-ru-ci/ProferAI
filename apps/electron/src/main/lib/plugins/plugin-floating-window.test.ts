import { describe, expect, mock, test } from 'bun:test'

// plugin-floating-window 顶层依赖 electron / 宿主服务，这里仅验证纯逻辑：边界钳制。
mock.module('electron', () => ({
  app: { getVersion: () => '0.15.80', isPackaged: true },
  BrowserWindow: class {},
  screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), on: () => undefined },
}))
mock.module('./plugin-manager', () => ({
  getInstalledPlugin: () => null,
  resolvePluginPage: () => { throw new Error('not used') },
  resolveInstalledPluginRoot: () => '/tmp',
}))
mock.module('./plugin-requests', () => ({ pluginRequests: { cancelOwner: () => undefined } }))
mock.module('../config-paths', () => ({ getPluginDataDir: () => '/tmp' }))

const { clampBoundsToDisplays } = await import('./plugin-floating-window')

describe('悬浮窗口边界钳制', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]

  test('完全跑出屏幕的窗口被拉回可见区域', () => {
    const clamped = clampBoundsToDisplays({ x: 5000, y: 3000, width: 320, height: 240 }, displays)
    expect(clamped.x).toBeLessThanOrEqual(1920 - 320)
    expect(clamped.y).toBeLessThanOrEqual(1040 - 240)
    expect(clamped.x).toBeGreaterThanOrEqual(0)
    expect(clamped.y).toBeGreaterThanOrEqual(0)
  })

  test('窗口尺寸不小于最小可见像素', () => {
    const clamped = clampBoundsToDisplays({ x: 0, y: 0, width: 1, height: 1 }, displays)
    expect(clamped.width).toBeGreaterThanOrEqual(48)
    expect(clamped.height).toBeGreaterThanOrEqual(48)
  })

  test('多显示器时选择重叠面积最大的显示器', () => {
    const multi = [
      { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } },
    ]
    // 窗口大部分在第二台显示器上
    const clamped = clampBoundsToDisplays({ x: 2000, y: 100, width: 400, height: 300 }, multi)
    expect(clamped.x).toBeGreaterThanOrEqual(1920)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(1920 + 2560)
  })

  test('窗口大于显示器工作区时被收缩到工作区内', () => {
    const clamped = clampBoundsToDisplays({ x: 0, y: 0, width: 5000, height: 5000 }, displays)
    expect(clamped.width).toBeLessThanOrEqual(1920)
    expect(clamped.height).toBeLessThanOrEqual(1040)
  })

  test('无显示器时返回兜底矩形', () => {
    const clamped = clampBoundsToDisplays({ x: 10, y: 20, width: 320, height: 240 }, [])
    expect(clamped).toEqual({ x: 0, y: 0, width: 320, height: 240 })
  })
})
