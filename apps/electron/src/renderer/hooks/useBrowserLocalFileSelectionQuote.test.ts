import { describe, expect, test } from 'bun:test'

import { buildBrowserSelectionQuote } from './useBrowserLocalFileSelectionQuote'

const event = (over: Partial<Parameters<typeof buildBrowserSelectionQuote>[0]> = {}) => ({
  text: '被引用的那段话',
  filePath: '/tmp/samples/sample-legacy.doc',
  fileName: 'sample-legacy.doc',
  capturedAt: 42,
  ...over,
})

describe('浏览器列划词 → 内联引用', () => {
  test('字段与手动引用同口径（sourceType=file + 文件名作展示名）', () => {
    expect(buildBrowserSelectionQuote(event())).toEqual({
      text: '被引用的那段话',
      filePath: '/tmp/samples/sample-legacy.doc',
      sourceType: 'file',
      sourceLabel: 'sample-legacy.doc',
      capturedAt: 42,
      origin: 'browser-selection',
    })
  })

  test('选中文本首尾空白会被裁掉', () => {
    expect(buildBrowserSelectionQuote(event({ text: '  段首段尾  ' }))?.text).toBe('段首段尾')
  })

  test('空选区（用户点了别处）不产生引用', () => {
    expect(buildBrowserSelectionQuote(event({ text: '   ' }))).toBeNull()
    expect(buildBrowserSelectionQuote(event({ text: '' }))).toBeNull()
  })

  test('自动划词标记为 browser-selection，编辑器据此替换上一条自动引用', () => {
    expect(buildBrowserSelectionQuote(event())?.origin).toBe('browser-selection')
  })
})
