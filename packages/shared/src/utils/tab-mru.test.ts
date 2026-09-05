import { expect, test } from 'bun:test'
import { promoteMru, removeMruId, selectMruFallbackId } from './tab-mru'

test('MRU 访问会去重并把最近标签放在队首', () => {
  expect(promoteMru(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
})

test('关闭后跳过失效记录并选择最近仍存在的标签', () => {
  expect(selectMruFallbackId(['closed', 'b', 'a'], 'c', ['a', 'b'])).toBe('b')
  expect(removeMruId(['c', 'b', 'a'], 'c')).toEqual(['b', 'a'])
})
