import { expect, test } from 'bun:test'
import { closeTab, type TabItem } from './tab-atoms'

const tab = (id: string): TabItem => ({ id, type: 'agent', sessionId: id, title: id })

test('关闭当前普通标签时回退到最近访问标签而非右侧标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b'), tab('c')], 'c', 'c', ['c', 'b', 'a'])
  expect(result.activeTabId).toBe('b')
  expect(result.mru).toEqual(['b', 'a'])
})

test('关闭非当前标签不改变活动标签', () => {
  const result = closeTab([{ id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' }, tab('a'), tab('b')], 'a', 'b', ['a', 'b'])
  expect(result.activeTabId).toBe('a')
  expect(result.mru).toEqual(['a'])
})
