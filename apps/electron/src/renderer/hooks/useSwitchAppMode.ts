/**
 * useSwitchAppMode — 统一的「切到 Chat / Agent」入口
 *
 * 背景：模式切换曾在 ModeSwitcher（顶部开关、⌘⇧M、Alt+←/→）和左侧栏 rail
 * （收起态的两个模式按钮）里各写一份几乎逐字重复的 fallback 逻辑，细节还有漂移
 * （rail 版本会排除 draft 会话，ModeSwitcher 版本不会）。两份逻辑的兜底分支都是
 * 「找不到可打开的会话 → 只改模式」，这正是「模式显示 Agent、标签页却是 Chat」
 * 这类撕裂态的成因。
 *
 * 现在收敛到一处，兜底不再只改模式：
 *  1. 上次在该模式下看的会话仍在 → 打开它
 *  2. 已打开的同类型标签 → 聚焦它
 *  3. 最近的未归档会话 → 打开它
 *  4. 都没有 → 建一个草稿会话（不属于任何工作区数据），保证「模式」始终有对应的标签页
 *
 * 模式本身仍写一次 appModeAtom（作为用户意图），但界面显示的模式由活动标签页
 * 派生（见 atoms/app-mode.ts），因此两者不会再分叉。
 */

import * as React from 'react'
import { toast } from 'sonner'
import { coreSessionNavigationPhaseAtom } from '@/atoms/core-target-atoms'
import { useAtomValue } from 'jotai'
import type { AppMode } from '@/atoms/app-mode'
import { conversationsAtom, currentConversationIdAtom } from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  currentAgentSessionIdAtom,
} from '@/atoms/agent-atoms'
import { tabsAtom } from '@/atoms/tab-atoms'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms'
import { useOpenSession } from './useOpenSession'
import { useCreateSession } from './useCreateSession'
import { isVisibleAgentSession } from '@profer/shared'

/** 目标模式下可用于恢复的会话条目形状（Chat 对话与 Agent 会话的公共子集）。 */
interface RestorableSession {
  id: string
  title: string
  archived?: boolean
  draft?: boolean
}

export interface SwitchAppModeResult {
  switched: boolean
  /** 兜底创建了新草稿会话（调用方可据此提示或做额外处理） */
  createdDraft: boolean
}

export function useSwitchAppMode(): (target: AppMode) => Promise<SwitchAppModeResult> {
  const phase = useAtomValue(coreSessionNavigationPhaseAtom)
  const openSession = useOpenSession({ localOnly: true })
  const { createChat, createAgent } = useCreateSession()
  const conversations = useAtomValue(conversationsAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentConversationId = useAtomValue(currentConversationIdAtom)
  const currentAgentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const tabs = useAtomValue(tabsAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)

  return React.useCallback(
    async (target: AppMode): Promise<SwitchAppModeResult> => {
      if (phase === 'loading' || phase === 'error') {
        toast.error(phase === 'loading' ? '正在加载 Core 会话，请稍候' : 'Core 会话加载失败，请检查连接后重试')
        return { switched: false, createdDraft: false }
      }
      if (target === 'scratch') {
        // 草稿本由标签页 ID 表达，不在本 hook 的会话恢复范围内。
        return { switched: false, createdDraft: false }
      }

      const isChat = target === 'chat'
      const sessions: RestorableSession[] = isChat
        ? conversations
        : agentSessions.filter(isVisibleAgentSession)

      // 1. 上次在该模式下查看的会话仍在 → 直接恢复
      const lastId = isChat ? currentConversationId : currentAgentSessionId
      if (lastId) {
        const remembered = sessions.find((session) => session.id === lastId)
        if (remembered) {
          openSession(target, remembered.id, remembered.title)
          return { switched: true, createdDraft: false }
        }
      }

      // 2. 已打开的同类型标签 → 聚焦（用户明确打开过，比"最近"更贴近意图）
      const openTabForMode = tabs.find((tab) => tab.type === target)
      if (openTabForMode) {
        openSession(target, openTabForMode.sessionId, openTabForMode.title)
        return { switched: true, createdDraft: false }
      }

      // 3. 最近的未归档、非内存草稿会话 → 打开
      const recent = sessions.find(
        (session) => !session.archived && !session.draft && !draftSessionIds.has(session.id),
      )
      if (recent) {
        openSession(target, recent.id, recent.title)
        return { switched: true, createdDraft: false }
      }

      // 4. 一个会话都没有 → 建草稿会话，而不是留一个没有标签页的模式
      const createdId = isChat ? await createChat({ draft: true }) : await createAgent({ draft: true })
      return { switched: createdId !== undefined, createdDraft: createdId !== undefined }
    },
    [
      phase,
      openSession,
      createChat,
      createAgent,
      conversations,
      agentSessions,
      currentConversationId,
      currentAgentSessionId,
      tabs,
      draftSessionIds,
    ],
  )
}
