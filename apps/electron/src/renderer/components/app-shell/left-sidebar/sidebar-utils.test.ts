/**
 * sidebar-utils.test.ts — 侧边栏纯函数测试
 *
 * 当前覆盖「删除当前会话」快捷键的开关决策：同一个键既要能打开确认框，
 * 也要能关掉它，且关闭永远优先于再次打开。
 */

import { describe, expect, test } from 'bun:test'
import { resolveDeleteShortcutAction } from './sidebar-utils'

describe('resolveDeleteShortcutAction', () => {
  test('Given 确认框未打开且有可删除的活跃会话 When 按 Delete Then 打开', () => {
    expect(resolveDeleteShortcutAction(null, 'session-a')).toBe('open')
  })

  test('Given 确认框已打开 When 再按 Delete Then 关闭', () => {
    expect(resolveDeleteShortcutAction('session-a', 'session-a')).toBe('close')
  })

  test('Given 确认框已打开但活跃会话已切换 When 再按 Delete Then 仍先关闭', () => {
    expect(resolveDeleteShortcutAction('session-a', 'session-b')).toBe('close')
  })

  test('Given 无可删除的活跃会话（未选中 / 草稿） When 按 Delete Then 不响应', () => {
    expect(resolveDeleteShortcutAction(null, null)).toBe('none')
  })
})
