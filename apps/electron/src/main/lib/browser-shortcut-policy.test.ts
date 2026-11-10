import { expect, test } from 'bun:test'
import { matchBrowserShortcut } from './browser-shortcut-policy'

const binding = { id: 'focus-input', key: 'l', meta: true, control: false, shift: false, alt: false }
const input = { type: 'keyDown' as const, key: 'L', meta: true, control: false, shift: false, alt: false, isComposing: false }
test('精确匹配有效绑定，不吞额外修饰键、输入法和普通编辑键', () => {
  expect(matchBrowserShortcut(input, [binding])).toBe(binding)
  expect(matchBrowserShortcut({ ...input, shift: true }, [binding])).toBeUndefined()
  expect(matchBrowserShortcut({ ...input, isComposing: true }, [binding])).toBeUndefined()
  expect(matchBrowserShortcut({ ...input, key: 'c' }, [binding])).toBeUndefined()
  expect(matchBrowserShortcut({ ...input, type: 'keyUp' }, [binding])).toBeUndefined()
  expect(matchBrowserShortcut(input, [])).toBeUndefined()
})
