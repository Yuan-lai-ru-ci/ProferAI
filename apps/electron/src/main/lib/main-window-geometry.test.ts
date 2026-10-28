import { describe, expect, test } from 'bun:test'
import { resolveSecondaryWindowBounds } from './main-window-geometry'

const workArea = { x: 0, y: 0, width: 1440, height: 900 }

describe('resolveSecondaryWindowBounds', () => {
  test('窗口出现在鼠标附近，并沿用源窗口尺寸', () => {
    const bounds = resolveSecondaryWindowBounds({
      cursor: { x: 700, y: 300 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      sourceSize: { width: 1200, height: 800 },
    })
    expect(bounds).toEqual({ x: 400, y: 276, width: 1200, height: 800 })
  })

  test('贴右边缘时向内收，不超出工作区', () => {
    const bounds = resolveSecondaryWindowBounds({
      cursor: { x: 1430, y: 120 },
      workArea,
      sourceSize: { width: 1200, height: 800 },
    })
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.width)
    expect(bounds.y).toBe(96)
  })

  test('鼠标在负坐标副屏时仍落在该屏工作区内', () => {
    const secondary = { x: -1600, y: 0, width: 1600, height: 900 }
    const bounds = resolveSecondaryWindowBounds({
      cursor: { x: -1500, y: 40 },
      workArea: secondary,
      sourceSize: { width: 1200, height: 800 },
    })
    expect(bounds.x).toBeGreaterThanOrEqual(secondary.x)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(secondary.x + secondary.width)
  })

  test('源窗口大于工作区时缩到工作区尺寸', () => {
    const small = { x: 0, y: 0, width: 1000, height: 700 }
    const bounds = resolveSecondaryWindowBounds({
      cursor: { x: 100, y: 100 },
      workArea: small,
      sourceSize: { width: 2400, height: 1600 },
    })
    expect(bounds).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
  })

  test('Windows 任务栏占用底部时，窗口不压到任务栏', () => {
    // 1366×768 笔记本常见工作区：底部任务栏扣掉约 40px。
    const laptop = { x: 0, y: 0, width: 1366, height: 728 }
    const bounds = resolveSecondaryWindowBounds({
      cursor: { x: 1300, y: 700 },
      workArea: laptop,
      sourceSize: { width: 1400, height: 900 },
    })
    expect(bounds).toEqual({ x: 0, y: 0, width: 1366, height: 728 })
  })

  test('Windows 任务栏在顶部时，窗口不会跑进任务栏', () => {
    const topTaskbar = { x: 0, y: 40, width: 1920, height: 1040 }
    const bounds = resolveSecondaryWindowBounds({
      cursor: { x: 600, y: 10 },
      workArea: topTaskbar,
      sourceSize: { width: 1200, height: 800 },
    })
    expect(bounds.y).toBe(40)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1080)
  })
})
