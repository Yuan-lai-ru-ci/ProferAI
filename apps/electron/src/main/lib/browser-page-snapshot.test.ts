import { expect, test } from 'bun:test'
import { compareBrowserPageSnapshots, createBrowserPageSnapshot, hasBrowserPageChanged } from './browser-page-snapshot'

test('页面快照只保留摘要字段，并能识别内容与 frame 变化', () => {
  const before = createBrowserPageSnapshot({ url: 'https://example.com', title: '示例', text: '菜单', frameCount: 1, generation: 2 })
  const after = createBrowserPageSnapshot({ url: 'https://example.com', title: '示例', text: '菜单已打开', frameCount: 2, generation: 2 })

  expect(before).not.toHaveProperty('text')
  expect(compareBrowserPageSnapshots(before, after)).toMatchObject({ content: true, frameTree: true, url: false, generation: false })
  expect(hasBrowserPageChanged(before, after)).toBe(true)
})

test('导航代次变化即使文本相同也会被视为页面变化', () => {
  const before = createBrowserPageSnapshot({ url: 'https://example.com', title: '示例', text: '相同', generation: 1 })
  const after = createBrowserPageSnapshot({ url: 'https://example.com', title: '示例', text: '相同', generation: 2 })
  expect(compareBrowserPageSnapshots(before, after).generation).toBe(true)
  expect(hasBrowserPageChanged(before, after)).toBe(true)
})
