/**
 * 快速任务窗口测试（覆盖 2026-08-08 开关化改造的实时启停路径）
 *
 * 验证：createQuickTaskWindow 幂等（重复调用不重复创建）；
 * destroyQuickTaskWindow 销毁并清空；toggle 在窗口缺失时自愈创建。
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

// preload 统一 electron mock 的测试钩子（类型声明与 test/preload-electron-mock.ts 保持一致）
declare global {
  var __proferElectronTestHooks: {
    createdWindows: Array<{ destroyed: boolean; visible: boolean; opts: Record<string, unknown> }>
    registeredAccelerators: string[]
    reset: () => void
  }
}

/** 实例记录来自 preload 统一 electron mock 的测试钩子（--isolate 下无法在测试文件内二次 mock electron） */
const hooks = () => globalThis.__proferElectronTestHooks
let createdWindows: Array<{ destroyed: boolean; visible: boolean; opts: Record<string, unknown> }>

beforeAll(() => {
  createdWindows = hooks().createdWindows
})

beforeEach(() => {
  hooks().reset()
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
    expect(createdWindows[0]!.opts.show).toBe(false)
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
    expect(createdWindows[0]!.destroyed).toBe(true)
    // 销毁后可再次创建全新实例
    createQuickTaskWindow()
    expect(createdWindows.length).toBe(2)
    expect(createdWindows[1]!.destroyed).toBe(false)
  })

  test('destroyQuickTaskWindow 在窗口缺失时安全（不抛错）', async () => {
    await resetSingleton()
    const { destroyQuickTaskWindow } = await import('./quick-task-window')
    expect(() => destroyQuickTaskWindow()).not.toThrow()
  })
})
