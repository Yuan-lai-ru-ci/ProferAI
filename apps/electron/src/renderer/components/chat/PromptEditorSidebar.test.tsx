import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { PromptEditorSidebar } from './PromptEditorSidebar'

test('提示词列表和编辑区都使用统一滚动容器，保留字段与保存状态', () => {
  const html = renderToStaticMarkup(<Provider store={createStore()}><PromptEditorSidebar /></Provider>)
  expect(html.match(/profer-scroll-region/g)).toHaveLength(2)
  expect(html).toContain('max-h-[200px]')
  expect(html).toContain('已保存')
  expect(html).toContain('名称')
  expect(html).toContain('内容')
  expect(html).toContain('追加日期时间和用户名')
  expect(html).not.toContain('data-radix-scroll-area-viewport')
})
