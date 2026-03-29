/**
 * useCreateSession — 共享的创建 Chat 对话 / Agent 会话逻辑
 *
 * 从 LeftSidebar 提取，供 WelcomeView 模式切换和侧边栏共同使用。
 */

import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  conversationsAtom,
  currentConversationIdAtom,
  selectedModelAtom,
} from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  agentChannelIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import {
  tabsAtom,
  splitLayoutAtom,
  openTab,
} from '@/atoms/tab-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { promptConfigAtom, selectedPromptIdAtom } from '@/atoms/system-prompt-atoms'

interface CreateSessionActions {
  /** 创建新 Chat 对话并打开标签页 */
  createChat: () => Promise<void>
  /** 创建新 Agent 会话并打开标签页 */
  createAgent: () => Promise<void>
}

export function useCreateSession(): CreateSessionActions {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [layout, setLayout] = useAtom(splitLayoutAtom)
  const setActiveView = useSetAtom(activeViewAtom)

  // Chat
  const setConversations = useSetAtom(conversationsAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const selectedModel = useAtomValue(selectedModelAtom)
  const promptConfig = useAtomValue(promptConfigAtom)
  const setSelectedPromptId = useSetAtom(selectedPromptIdAtom)

  // Agent
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentChannelId = useAtomValue(agentChannelIdAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)

  const createChat = async (): Promise<void> => {
    try {
      const meta = await window.electronAPI.createConversation(
        undefined,
        selectedModel?.modelId,
        selectedModel?.channelId,
      )
      setConversations((prev) => [meta, ...prev])
      const result = openTab(tabs, layout, { type: 'chat', sessionId: meta.id, title: meta.title })
      setTabs(result.tabs)
      setLayout(result.layout)
      setCurrentConversationId(meta.id)
      setActiveView('conversations')
      if (promptConfig.defaultPromptId) {
        setSelectedPromptId(promptConfig.defaultPromptId)
      }
    } catch (error) {
      console.error('[创建会话] 创建 Chat 对话失败:', error)
    }
  }

  const createAgent = async (): Promise<void> => {
    try {
      const meta = await window.electronAPI.createAgentSession(
        undefined,
        agentChannelId || undefined,
        currentWorkspaceId || undefined,
      )
      setAgentSessions((prev) => [meta, ...prev])
      const result = openTab(tabs, layout, { type: 'agent', sessionId: meta.id, title: meta.title })
      setTabs(result.tabs)
      setLayout(result.layout)
      setCurrentAgentSessionId(meta.id)
      setActiveView('conversations')
    } catch (error) {
      console.error('[创建会话] 创建 Agent 会话失败:', error)
    }
  }

  return { createChat, createAgent }
}
