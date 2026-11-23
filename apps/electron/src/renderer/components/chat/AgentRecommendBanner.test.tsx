import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { pendingAgentRecommendationAtom } from '@/atoms/chat-atoms'
import { AgentRecommendBanner } from './AgentRecommendBanner'

describe('Agent 推荐展示', () => {
  test('有推荐时保留行动理由并为关闭提供可访问名称', () => {
    const store = createStore()
    store.set(pendingAgentRecommendationAtom, { reason: '需要读取项目文件', suggestedPrompt: '检查项目', conversationId: 'chat-1' })
    const html = renderToStaticMarkup(<Provider store={store}><AgentRecommendBanner /></Provider>)
    expect(html).toContain('需要读取项目文件')
    expect(html).toContain('aria-label="关闭 Agent 模式推荐"')
    expect(html).toContain('切换到 Agent 模式')
    expect(html).toContain('bg-muted/40')
    expect(html).not.toContain('shadow-lg')
  })
  test('没有推荐时不显示提示', () => {
    expect(renderToStaticMarkup(<Provider store={createStore()}><AgentRecommendBanner /></Provider>)).toBe('')
  })
})
