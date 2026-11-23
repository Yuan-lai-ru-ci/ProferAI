import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserStartPage } from './BrowserStartPage'

describe('起始页资源操作', () => {
  test('书签删除在父级键盘聚焦时可显现，普通滚动复用 ScrollRegion', () => {
    const html = renderToStaticMarkup(<BrowserStartPage state={{ bookmarks: [{ id: 'bookmark', title: '示例', url: 'https://example.com', favicon: '', createdAt: 0 }], recentHistory: [], defaultHomeUrl: null }} onNavigate={() => {}} onRemoveBookmark={() => {}} />)
    expect(html).toContain('profer-scroll-region')
    expect(html).toContain('group-focus-within:flex')
    expect(html).toContain('group-focus-within:opacity-100')
    expect(html).toContain('删除书签 示例')
    expect(html).toContain('focus-visible:ring-2')
  })
})
