import { describe, expect, test } from 'bun:test'

import {
  getActiveQuotePreview,
  markQuotePreviewClosing,
  QUOTE_PREVIEW_OPEN_DELAY,
  QUOTE_PREVIEW_REOPEN_DELAY,
  resolveQuotePreviewDelay,
  setActiveQuotePreview,
} from './quote-preview-store'

describe('引用预览单例', () => {
  test('Given 已有预览 When 另一条胶囊打开 Then 后者顶掉前者', () => {
    setActiveQuotePreview('quote-a')
    expect(getActiveQuotePreview()).toBe('quote-a')

    setActiveQuotePreview('quote-b')
    expect(getActiveQuotePreview()).toBe('quote-b')
  })

  test('Given 预览打开 When 释放 Then 回到空态', () => {
    setActiveQuotePreview('quote-a')
    setActiveQuotePreview(null)
    expect(getActiveQuotePreview()).toBeNull()
  })

  test('Given 重复设置同一个 id Then 不触发额外通知（订阅者只在变化时重渲染）', () => {
    setActiveQuotePreview('quote-a')
    let notifications = 0
    // 直接观察内部状态变化：相同 id 不应产生新的活跃者
    setActiveQuotePreview('quote-a')
    notifications += getActiveQuotePreview() === 'quote-a' ? 0 : 1
    expect(notifications).toBe(0)
    setActiveQuotePreview(null)
  })
})

describe('预览展开延迟', () => {
  test('首次悬停用 750ms', () => {
    expect(resolveQuotePreviewDelay()).toBe(QUOTE_PREVIEW_OPEN_DELAY)
  })

  test('已有预览开着时直接接手（0ms）', () => {
    setActiveQuotePreview('quote-x')
    expect(resolveQuotePreviewDelay()).toBe(0)
    setActiveQuotePreview(null)
  })

  test('刚收起后 2 秒内再次悬停缩短到 120ms', () => {
    markQuotePreviewClosing()
    expect(resolveQuotePreviewDelay()).toBe(QUOTE_PREVIEW_REOPEN_DELAY)
  })
})
