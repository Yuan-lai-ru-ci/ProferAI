import { expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@profer/shared'
import { SCRATCH_PAD_ID, type TabItem } from '@/atoms/tab-atoms'
import { selectContextTabs } from './tab-context'

const scratch: TabItem = {
  id: SCRATCH_PAD_ID,
  type: 'scratch',
  sessionId: SCRATCH_PAD_ID,
  title: 'Scratch Pad',
}
const agentTab = (id: string, extra: Partial<TabItem> = {}): TabItem => ({
  id,
  type: 'agent',
  sessionId: id,
  title: id,
  ...extra,
})
const chatTab = (id: string): TabItem => ({ id, type: 'chat', sessionId: id, title: id })
const session = (id: string, extra: Partial<AgentSessionMeta> = {}): AgentSessionMeta =>
  ({ id, title: id, createdAt: 1, updatedAt: 1, ...extra }) as AgentSessionMeta

test('草稿是全局固定入口：Agent 会话激活时仍在首位，只过滤会话 Tab', () => {
  const tabs = [scratch, agentTab('root'), agentTab('child', { parentSessionId: 'root' }), agentTab('other')]
  const sessions = [session('root'), session('child', { parentSessionId: 'root' }), session('other')]
  expect(selectContextTabs(tabs, 'root', sessions).map((tab) => tab.id)).toEqual([
    SCRATCH_PAD_ID,
    'root',
    'child',
  ])
})

test('Chat 会话激活时草稿仍在首位', () => {
  const tabs = [scratch, chatTab('c1'), agentTab('a1')]
  expect(selectContextTabs(tabs, 'c1', []).map((tab) => tab.id)).toEqual([SCRATCH_PAD_ID, 'c1'])
})

test('草稿激活时沿用进入前的会话 rail，不带入其他会话', () => {
  const tabs: TabItem[] = [
    scratch,
    agentTab('agent-a'),
    chatTab('chat-b'),
    { id: 'preview-a', type: 'preview', sessionId: 'agent-a', title: '预览' },
    { id: 'browser-b', type: 'browser', sessionId: 'chat-b', title: '浏览器' },
    agentTab('agent-c'),
  ]

  expect(selectContextTabs(tabs, SCRATCH_PAD_ID, [], 'agent-a').map((tab) => tab.id)).toEqual([
    SCRATCH_PAD_ID,
    'agent-a',
    'preview-a',
  ])
})

test('从 Chat 会话进入草稿时保留该 Chat，隐藏其他会话', () => {
  const tabs = [scratch, chatTab('chat-a'), chatTab('chat-b'), agentTab('agent-c')]
  expect(selectContextTabs(tabs, SCRATCH_PAD_ID, [], 'chat-a').map((tab) => tab.id)).toEqual([
    SCRATCH_PAD_ID,
    'chat-a',
  ])
})

test('直接打开草稿时不把其他会话放进 rail', () => {
  const tabs = [scratch, agentTab('agent-a'), chatTab('chat-b')]
  expect(selectContextTabs(tabs, SCRATCH_PAD_ID, []).map((tab) => tab.id)).toEqual([SCRATCH_PAD_ID])
})

test('文档类单页只显示自身，不往顶栏塞草稿', () => {
  const tutorial: TabItem = { id: '__tutorial__', type: 'tutorial', sessionId: '__tutorial__', title: '教程' }
  const tabs = [scratch, tutorial, agentTab('a1')]
  expect(selectContextTabs(tabs, '__tutorial__', []).map((tab) => tab.id)).toEqual(['__tutorial__'])
})

test('没有激活 Tab 时保留全部 Tab，草稿仍在首位', () => {
  const tabs = [agentTab('a1'), scratch]
  expect(selectContextTabs(tabs, null, []).map((tab) => tab.id)).toEqual([SCRATCH_PAD_ID, 'a1'])
})
