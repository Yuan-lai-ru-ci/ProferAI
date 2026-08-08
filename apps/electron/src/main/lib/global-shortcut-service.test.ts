/**
 * 全局快捷键服务测试（重点覆盖 2026-08-08 快速任务开关化改造）
 *
 * 验证：quick-task 仅在 quickTaskEnabled === true 时注册；
 * voice-dictation 行为回归不变；show-main-window 始终注册。
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// preload 统一 electron mock 的测试钩子（类型声明与 test/preload-electron-mock.ts 保持一致）
declare global {
  var __proferElectronTestHooks: {
    createdWindows: Array<{ destroyed: boolean; visible: boolean; opts: Record<string, unknown> }>
    registeredAccelerators: string[]
    reset: () => void
  }
}

/** 已注册 accelerator 记录来自 preload 统一 electron mock 的测试钩子 */
let registeredAccelerators: string[] = []
/** 当前模拟设置（测试内可变） */
let mockSettings: Record<string, unknown> = {}

beforeAll(() => {
  registeredAccelerators = globalThis.__proferElectronTestHooks.registeredAccelerators

  mock.module('./settings-service', () => ({
    getSettings: () => mockSettings,
  }))
})

beforeEach(() => {
  globalThis.__proferElectronTestHooks.reset()
  mockSettings = {}
})

describe('快速任务开关化（2026-08-08）', () => {
  test('quick-task 默认未设置时不注册', async () => {
    const { registerGlobalShortcut } = await import('./global-shortcut-service')
    const ok = registerGlobalShortcut('quick-task', () => {})
    expect(ok).toBe(false)
    expect(registeredAccelerators).not.toContain('Alt+Space')
  })

  test('quick-taskEnabled=false 时不注册', async () => {
    mockSettings = { quickTaskEnabled: false }
    const { registerGlobalShortcut } = await import('./global-shortcut-service')
    const ok = registerGlobalShortcut('quick-task', () => {})
    expect(ok).toBe(false)
    expect(registeredAccelerators).not.toContain('Alt+Space')
  })

  test('quickTaskEnabled=true 时注册 Alt+Space', async () => {
    mockSettings = { quickTaskEnabled: true }
    const { registerGlobalShortcut } = await import('./global-shortcut-service')
    const ok = registerGlobalShortcut('quick-task', () => {})
    expect(ok).toBe(true)
    expect(registeredAccelerators).toContain('Alt+Space')
  })

  test('reregisterAllGlobalShortcuts 随开关变化生效', async () => {
    const { registerGlobalShortcut, reregisterAllGlobalShortcuts } = await import('./global-shortcut-service')
    // 关闭态注册 → 不生效
    mockSettings = { quickTaskEnabled: false }
    registerGlobalShortcut('quick-task', () => {})
    expect(registeredAccelerators).not.toContain('Alt+Space')
    // 打开开关 → 重新注册生效
    mockSettings = { quickTaskEnabled: true }
    reregisterAllGlobalShortcuts()
    expect(registeredAccelerators).toContain('Alt+Space')
    // 关闭开关 → 注销
    mockSettings = { quickTaskEnabled: false }
    reregisterAllGlobalShortcuts()
    expect(registeredAccelerators).not.toContain('Alt+Space')
  })
})

describe('voice-dictation 回归', () => {
  test('voiceDictation.enabled=true 时注册', async () => {
    mockSettings = { voiceDictation: { enabled: true } }
    const { registerGlobalShortcut } = await import('./global-shortcut-service')
    const ok = registerGlobalShortcut('voice-dictation', () => {})
    expect(ok).toBe(true)
  })

  test('voiceDictation 未启用时不注册', async () => {
    mockSettings = { voiceDictation: { enabled: false } }
    const { registerGlobalShortcut } = await import('./global-shortcut-service')
    const ok = registerGlobalShortcut('voice-dictation', () => {})
    expect(ok).toBe(false)
  })
})

describe('show-main-window 始终注册（不受开关影响）', () => {
  test('无任何开关设置时也注册', async () => {
    const { registerGlobalShortcut } = await import('./global-shortcut-service')
    const ok = registerGlobalShortcut('show-main-window', () => {})
    expect(ok).toBe(true)
  })
})
