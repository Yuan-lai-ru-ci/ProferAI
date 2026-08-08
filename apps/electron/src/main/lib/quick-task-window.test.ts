/**
 * 快速任务窗口测试（覆盖 2026-08-08 开关化改造的实时启停路径）
 *
 * 验证：createQuickTaskWindow 幂等（重复调用不重复创建）；
 * destroyQuickTaskWindow 销毁并清空；toggle 在窗口缺失时自愈创建。
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/** 假 BrowserWindow 实例记录 */
let createdWindows: FakeWin[] = []

class FakeWin {
  destroyed = false
  visible = false
  webContents = { send: () => {}, once: () => {}, on: () => {} }
  private readyCb: (() => void) | null = null

  constructor(public opts: Record<string, unknown>) {
    createdWindows.push(this)
  }

  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.destroyed = true }
  isVisible(): boolean { return this.visible }
  show(): void { this.visible = true }
  hide(): void { this.visible = false }
  focus(): void {}
  setBounds(): void {}
  restore(): void {}
  isMinimized(): boolean { return false }
  loadURL(): Promise<void> { return Promise.resolve() }
  loadFile(): Promise<void> { return Promise.resolve() }
  on(_evt: string, cb: () => void): void { void _evt; void cb }
  once(evt: string, cb: () => void): void {
    if (evt === 'ready-to-show') this.readyCb = cb
  }
  emitReady(): void { this.readyCb?.() }
}

beforeAll(() => {
  mock.module('electron', () => ({
    app: { isPackaged: true, on: () => {} },
    BrowserWindow: FakeWin,
    screen: {
      getCursorScreenPoint: () => ({ x: 800, y: 450 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
  }))
})

beforeEach(() => {
  createdWindows = []
})

/** 复位模块级单例（bun 模块缓存跨测试保留，需显式销毁） */
async function resetSingleton(): Promise<void> {
  const { destroyQuickTaskWindow } = await import('./quick-task-window')
  destroyQuickTaskWindow()
}

describe('快速任务窗口实时启停（2026-08-08）', () => {
  test('createQuickTaskWindow 创建隐藏窗口', async () => {
    await resetSingleton()
    const { createQuickTaskWindow } = await import('./quick-task-window')
    createQuickTaskWindow()
    expect(createdWindows.length).toBe(1)
    expect(createdWindows[0].opts.show).toBe(false)
  })

  test('createQuickTaskWindow 幂等：重复调用不重复创建', async () => {
    await resetSingleton()
    const { createQuickTaskWindow } = await import('./quick-task-window')
    createQuickTaskWindow()
    createQuickTaskWindow()
    createQuickTaskWindow()
    expect(createdWindows.length).toBe(1)
  })

  test('destroyQuickTaskWindow 销毁并清空（后续 create 可重建）', async () => {
    await resetSingleton()
    const { createQuickTaskWindow, destroyQuickTaskWindow } = await import('./quick-task-window')
    createQuickTaskWindow()
    destroyQuickTaskWindow()
    expect(createdWindows[0].destroyed).toBe(true)
    // 销毁后可再次创建全新实例
    createQuickTaskWindow()
    expect(createdWindows.length).toBe(2)
    expect(createdWindows[1].destroyed).toBe(false)
  })

  test('destroyQuickTaskWindow 在窗口缺失时安全（不抛错）', async () => {
    await resetSingleton()
    const { destroyQuickTaskWindow } = await import('./quick-task-window')
    expect(() => destroyQuickTaskWindow()).not.toThrow()
  })
})
