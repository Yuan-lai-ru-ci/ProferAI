import { describe, expect, test } from 'bun:test'
import { pluginViewKey } from './plugin-view-instance'

describe('插件页面实例键', () => {
  test('不同会话的插件 Tab 使用不同实例键', () => {
    expect(pluginViewKey('demo', 'main', { kind: 'tab', sessionId: 'session-a' })).toBe('demo:main:tab:session-a')
    expect(pluginViewKey('demo', 'main', { kind: 'tab', sessionId: 'session-b' })).not.toBe(pluginViewKey('demo', 'main', { kind: 'tab', sessionId: 'session-a' }))
  })
})
