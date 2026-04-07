/**
 * ModeSwitcher - Chat/Agent 模式切换（带滑动指示器）
 *
 * 切换模式时自动恢复上一次在该模式下查看的对话/会话：
 * 1. 优先恢复上次选中的对话 ID
 * 2. 其次查找已打开的同类型 Tab
 * 3. 兜底打开最近的对话/会话（列表首项）
 * 4. 都没有则仅切换模式
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'
import { conversationsAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import { agentSessionsAtom, currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { tabsAtom } from '@/atoms/tab-atoms'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'

const modes: { value: AppMode; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'agent', label: 'Agent' },
]

export function ModeSwitcher(): React.ReactElement {
  const [mode, setMode] = useAtom(appModeAtom)
  const openSession = useOpenSession()
  const conversations = useAtomValue(conversationsAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentConversationId = useAtomValue(currentConversationIdAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const tabs = useAtomValue(tabsAtom)

  /** 切换模式并恢复对应模式下的上一个对话/会话 */
  const handleModeSwitch = React.useCallback((targetMode: AppMode) => {
    if (targetMode === mode) return

    if (targetMode === 'chat') {
      // 恢复 Chat 模式的上一个对话
      // 1. 上次选中的对话仍存在 → 恢复
      if (currentConversationId) {
        const conv = conversations.find((c) => c.id === currentConversationId)
        if (conv) {
          openSession('chat', conv.id, conv.title)
          return
        }
      }
      // 2. 已打开的 Chat Tab → 聚焦
      const chatTab = tabs.find((t) => t.type === 'chat')
      if (chatTab) {
        openSession('chat', chatTab.sessionId, chatTab.title)
        return
      }
      // 3. 最近的未归档对话 → 打开
      const recentConv = conversations.find((c) => !c.archived)
      if (recentConv) {
        openSession('chat', recentConv.id, recentConv.title)
        return
      }
      // 4. 无任何对话，仅切换模式
      setMode(targetMode)
    } else {
      // 恢复 Agent 模式的上一个会话
      if (currentAgentSessionId) {
        const session = agentSessions.find((s) => s.id === currentAgentSessionId)
        if (session) {
          openSession('agent', session.id, session.title)
          return
        }
      }
      const agentTab = tabs.find((t) => t.type === 'agent')
      if (agentTab) {
        openSession('agent', agentTab.sessionId, agentTab.title)
        return
      }
      const recentSession = agentSessions.find((s) => !s.archived)
      if (recentSession) {
        openSession('agent', recentSession.id, recentSession.title)
        return
      }
      setMode(targetMode)
    }
  }, [mode, openSession, conversations, agentSessions, currentConversationId, currentAgentSessionId, tabs, setMode])

  return (
    <div className="pt-2">
      <div className="relative flex rounded-lg bg-muted p-1">
        {/* 滑动背景指示器 */}
        <div
          className={cn(
            'mode-slider absolute top-1 bottom-1 w-[calc(50%-4px)] rounded bg-background shadow-sm transition-transform duration-300 ease-in-out',
            mode === 'chat' ? 'translate-x-0' : 'translate-x-full'
          )}
        />
        {modes.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => handleModeSwitch(value)}
            className={cn(
              'mode-btn relative z-[1] flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-200',
              mode === value
                ? 'mode-btn-selected text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
