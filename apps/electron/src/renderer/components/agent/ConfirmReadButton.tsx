/**
 * ConfirmReadButton — 「确认已读」核心按钮（与插件系统无关）。
 *
 * 位置：该会话最新一轮 assistant 回复的操作栏，在「回退到此处」按钮右侧。
 * 可见性由 `shouldShowConfirmReadButton` 决定，调用点（`AssistantTurnRenderer`）负责判据；
 * 本组件只在被渲染时执行点击行为。
 *
 * 点击效果（清同一套三处状态）：
 * 1. 持久化字段 `completedButUnconfirmed`（走 IPC，主进程唯一写入口 `setAgentSessionUnread`）；
 * 2. 侧边栏绿标 / 未读角标（`agentSessionIndicatorMapAtom` ← 未读集合）；
 * 3. 任务栏 / Dock 角标（`dockBadgeCountAtom` ← 未读集合）。
 *
 * 第 2、3 项都派生自未读集合，因此用 IPC 返回的最新 meta 乐观刷新 `agentSessionsAtom`，
 * 开启态下派生集合与角标同一帧清空，按钮随之消失。
 *
 * 交互口径：**不弹二次确认**，只给轻提示（toast）。等待期间禁用，避免重复触发。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { CheckCheck } from 'lucide-react'
import { toast } from 'sonner'
import { MessageAction } from '@/components/ai-elements/message'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { upsertAgentSession } from '@/lib/agent-session-list'
import { noteExplicitUnreadRead } from '@/lib/agent-unread-transition'

export interface ConfirmReadButtonProps {
  /** 目标会话 ID（必填：按钮只挂在具体会话的最新一轮上） */
  sessionId: string
}

export function ConfirmReadButton({ sessionId }: ConfirmReadButtonProps): React.ReactElement {
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const [pending, setPending] = React.useState(false)

  const handleConfirm = React.useCallback(async (): Promise<void> => {
    if (pending) return
    setPending(true)
    // 显式确认已读：撤销「补写持久化未读未确认」的保护，避免陈旧内存副本在切回关闭态时复活。
    noteExplicitUnreadRead(sessionId)
    try {
      const meta = await window.electronAPI.clearAgentCompletionState(sessionId)
      setAgentSessions((prev) => upsertAgentSession(prev, meta))
      toast.success('已确认已读')
    } catch (error) {
      console.error('[确认已读] 清除未读失败:', error)
      toast.error('确认已读失败')
    } finally {
      setPending(false)
    }
  }, [pending, sessionId, setAgentSessions])

  return (
    <MessageAction
      tooltip="确认已读"
      disabled={pending}
      onClick={() => { void handleConfirm() }}
    >
      <CheckCheck className="size-3.5" />
    </MessageAction>
  )
}
