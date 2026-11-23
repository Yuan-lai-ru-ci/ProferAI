import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from './button'
import { EmptyState } from './empty-state'

describe('共享列表空态', () => {
  test('Given 内容与下一步 When 渲染 Then 统一层级且操作仍可命名', () => {
    const html = renderToStaticMarkup(<EmptyState icon={<svg />} title="暂无待办" description="新建待办并设置完成时间" action={<Button>新建待办</Button>} />)
    expect(html).toContain('<h3 class="text-base font-medium text-foreground">暂无待办</h3>')
    expect(html).toContain('新建待办并设置完成时间')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('<button')
    expect(html).toContain('新建待办</button>')
  })

  test('Given 只有标题 When 渲染 Then 不产生空说明或操作占位', () => {
    const html = renderToStaticMarkup(<EmptyState title="没有匹配结果" />)
    expect(html).not.toContain('<p')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('aria-hidden')
  })
})
