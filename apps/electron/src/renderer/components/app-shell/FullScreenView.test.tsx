import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScrollRegion } from '../ai-elements/scroll-region'
import { ViewBody } from './FullScreenView'

describe('全屏内容区的共享滚动容器', () => {
  test('Given 整页滚动 When 创建内容区 Then 使用 ScrollRegion 而非只挂样式类', () => {
    const body = ViewBody({ scroll: true, children: <p>内容</p> })
    expect(body.type).toBe(ScrollRegion)
    const html = renderToStaticMarkup(body)
    expect(html).toContain('profer-scroll-region')
    expect(html).toContain('overflow-y-auto')
    expect(html).not.toContain('overflow-x-hidden')
  })

  test('Given 内部独立滚动 When 创建内容区 Then 不附加第二层滚动容器', () => {
    const body = ViewBody({ children: <p>内容</p> })
    expect(body.type).toBe('div')
    const html = renderToStaticMarkup(body)
    expect(html).not.toContain('profer-scroll-region')
    expect(html).not.toContain('overflow-y-auto')
  })
})
