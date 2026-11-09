/**
 * 桌面 runtime 开关：v0.16.11 起**默认开启**，显式 `0` 才回旧编排器。
 *
 * 这条默认值决定「用户日常点发送」走哪条链，所以单独锁住：
 * 未设置 = 新链；`0` = 旧链；Goal 相关输入无论如何都回旧链（回调面未下沉）。
 */
import { describe, expect, test } from 'bun:test'
import {
  canUseRuntimeDesktop,
  isDesktopRuntimeSwitchEnabled,
  resolveDesktopRunChain,
} from './agent-runtime-desktop-switch'

describe('桌面 runtime 开关', () => {
  test('未设置时默认走新链', () => {
    expect(isDesktopRuntimeSwitchEnabled({})).toBe(true)
    expect(resolveDesktopRunChain({}, {})).toBe('runtime')
  })

  test('显式 0 回旧编排器（发版止损）', () => {
    expect(isDesktopRuntimeSwitchEnabled({ PROFER_RUNTIME_DESKTOP: '0' })).toBe(false)
    expect(resolveDesktopRunChain({}, { PROFER_RUNTIME_DESKTOP: '0' })).toBe('orchestrator')
  })

  test('其他值不构成关闭', () => {
    expect(isDesktopRuntimeSwitchEnabled({ PROFER_RUNTIME_DESKTOP: '1' })).toBe(true)
    expect(isDesktopRuntimeSwitchEnabled({ PROFER_RUNTIME_DESKTOP: 'true' })).toBe(true)
  })

  test('Goal 相关输入一律回旧链（回调面未下沉）', () => {
    const env = {}
    expect(canUseRuntimeDesktop({ goalRunId: 'g-1' }, env)).toBe(false)
    expect(canUseRuntimeDesktop({ reportGoalResult: () => {} }, env)).toBe(false)
    expect(canUseRuntimeDesktop({ goalProposal: {} as never }, env)).toBe(false)
    expect(canUseRuntimeDesktop({ onRuntimeSessionId: () => {} }, env)).toBe(false)
    expect(canUseRuntimeDesktop({ onRuntimeMessage: () => {} }, env)).toBe(false)
    expect(canUseRuntimeDesktop({}, env)).toBe(true)
  })
})
