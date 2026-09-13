import { describe, expect, test } from 'bun:test'
import type { TabItem } from '@/atoms/tab-atoms'
import { resolveContentTabId } from './active-tab-content'

const tabs: TabItem[] = [
  { id: 'a', type: 'agent', sessionId: 'session-a', title: 'A' },
  { id: 'b', type: 'chat', sessionId: 'session-b', title: 'B' },
]

describe('resolveContentTabId', () => {
  test('active tab 存在时立即使用同步 id', () => {
    expect(resolveContentTabId(tabs, 'b')).toBe('b')
  })

  test('active tab 缺失时不回退到旧 tab', () => {
    expect(resolveContentTabId(tabs, 'missing')).toBeNull()
    expect(resolveContentTabId(tabs, null)).toBeNull()
  })
})
