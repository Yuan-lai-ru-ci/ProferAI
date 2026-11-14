import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationMeta } from '@profer/shared'
import { TooltipProvider } from '@profer/ui/primitives/tooltip'
import { ConversationProvider } from '@/contexts/session-context'
import { chatTopBarHostAtom } from '@/atoms/chat-topbar-atoms'
import { activeTabIdAtom, tabsAtom } from '@/atoms/tab-atoms'
import { ChatHeader } from './ChatHeader'
import { TabBar } from '../tabs/TabBar'

// 服务端渲染只检查 Portal 内容和归属；真实 DOM 挂载由可见预览检查。
mock.module('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
const conversation: ConversationMeta = { id: 'chat-a', title: '唯一会话标题', channelId: 'c', modelId: 'm', createdAt: 1, updatedAt: 1 }

function renderHeader(hostId: string | null, standalone = false, meta: ConversationMeta | null = conversation): string {
  const store = createStore()
  if (hostId) store.set(chatTopBarHostAtom, { conversationId: hostId, element: {} as HTMLElement })
  return renderToStaticMarkup(<Provider store={store}><TooltipProvider><ConversationProvider conversationId={conversation.id}>
    <ChatHeader conversation={meta} standalone={standalone} onOpenHistory={() => {}} />
  </ConversationProvider></TooltipProvider></Provider>)
}

describe('Chat 操作归入顶栏', () => {
  test('主窗口不再输出重复标题或 48px 标题行', () => {
    const html = renderHeader('chat-a')
    expect(html).not.toContain(conversation.title)
    expect(html).not.toContain('48px')
    for (const label of ['对话节点树', '置顶对话', '并排模式']) expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('aria-label="提示词:')
  })
  test('只有匹配会话向顶栏输出操作；无插槽、非焦点和空 metadata 都安全', () => {
    expect(renderHeader(null)).toBe('')
    expect(renderHeader('chat-b')).toBe('')
    expect(renderHeader('chat-a', false, null)).toBe('')
  })
  test('独立窗口保留标题、重命名和操作', () => {
    const html = renderHeader(null, true)
    expect(html).toContain(conversation.title)
    expect(html).toContain('aria-label="编辑标题"')
    expect(html).toContain('aria-label="对话节点树"')
  })
  test('Chat Tab 提供重命名入口和带会话归属的操作插槽', () => {
    const store = createStore()
    store.set(tabsAtom, [{ id: 'chat-a', sessionId: 'chat-a', type: 'chat', title: conversation.title }])
    store.set(activeTabIdAtom, 'chat-a')
    const html = renderToStaticMarkup(<Provider store={store}><TooltipProvider><TabBar /></TooltipProvider></Provider>)
    expect(html).toContain('aria-label="重命名会话"')
    expect(html).toContain('data-conversation-id="chat-a"')
  })
})
