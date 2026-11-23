import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './button'

describe('共享按钮的键盘焦点', () => {
  for (const size of ['default', 'sm', 'lg', 'icon', 'icon-sm'] as const) {
    test(`Given ${size} 按钮 When 渲染 Then 保留统一焦点环`, () => {
      const html = renderToStaticMarkup(<Button size={size} aria-label="刷新">刷新</Button>)
      expect(html).toContain('focus-visible:ring-2')
      expect(html).toContain('focus-visible:ring-focus/40')
      expect(html).not.toContain('focus-visible:ring-0')
    })
  }

  test('Given 禁用按钮 When 渲染 Then 保留禁用语义与样式', () => {
    const html = renderToStaticMarkup(<Button size="icon-sm" disabled aria-label="刷新" />)
    expect(html).toContain('disabled=""')
    expect(html).toContain('disabled:pointer-events-none')
    expect(html).toContain('disabled:opacity-50')
  })
})
