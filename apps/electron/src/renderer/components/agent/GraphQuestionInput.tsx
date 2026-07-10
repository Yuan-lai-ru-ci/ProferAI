/**
 * GraphQuestionInput — 画板底部紧凑追问输入条
 *
 * 用户在画板上点击 Task 节点后，底部浮出此输入条。
 * 左侧显示节点信息，右侧是输入框 + 发送按钮。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { CornerDownLeft, X, MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  graphQuestionAtom,
  currentAgentSessionIdAtom,
  agentStreamingStatesAtom,
  agentSessionChannelMapAtom,
  agentSessionModelMapAtom,
  agentChannelIdAtom,
  agentModelIdAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { currentGraphAtom } from '@/atoms/graph-atoms'
import { formatTaskContext } from '@profer/project-core'
import type { AgentSendInput } from '@profer/shared'

export function GraphQuestionInput(): React.ReactElement | null {
  const question = useAtomValue(graphQuestionAtom)
  const setQuestion = useSetAtom(graphQuestionAtom)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const graph = useAtomValue(currentGraphAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const sessionChannelMap = useAtomValue(agentSessionChannelMapAtom)
  const sessionModelMap = useAtomValue(agentSessionModelMapAtom)
  const defaultChannelId = useAtomValue(agentChannelIdAtom)
  const defaultModelId = useAtomValue(agentModelIdAtom)
  const workspaceId = useAtomValue(currentAgentWorkspaceIdAtom)

  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // 显示时自动聚焦
  React.useEffect(() => {
    if (question) {
      setText('')
      const timer = setTimeout(() => inputRef.current?.focus(), 100)
      return () => clearTimeout(timer)
    }
  }, [question?.taskId])

  if (!question) return null

  const handleSend = async () => {
    const trimmed = text.trim()
    if (!trimmed || !sessionId || !graph || sending) return

    setSending(true)

    try {
      const node = graph.nodes[question.taskId]
      if (!node) {
        console.warn('[GraphQuestionInput] 未找到 Task 节点:', question.taskId)
        return
      }

      const context = formatTaskContext(node, graph)
      const fullMessage = context + '\n\n用户的反馈：' + trimmed

      const state = streamingStates.get(sessionId)
      const isRunning = state?.running ?? false

      if (isRunning) {
        // Agent 运行中 → 排队发送
        await window.electronAPI.queueAgentMessage({
          sessionId,
          userMessage: fullMessage,
          uuid: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
          interrupt: true,
        })
      } else {
        // Agent 未运行 → 发送新消息
        const channelId = sessionChannelMap.get(sessionId) ?? defaultChannelId
        const modelId = sessionModelMap.get(sessionId) ?? defaultModelId
        if (!channelId) {
          console.warn('[GraphQuestionInput] 无可用渠道，无法发送消息')
          return
        }
        const input: AgentSendInput = {
          sessionId,
          userMessage: fullMessage,
          channelId,
          modelId: modelId ?? undefined,
          workspaceId: workspaceId ?? undefined,
          startedAt: Date.now(),
        }
        await window.electronAPI.sendAgentMessage(input)
      }
    } catch (error) {
      console.error('[GraphQuestionInput] 发送失败:', error)
    } finally {
      setSending(false)
      setText('')
      setQuestion(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') {
      setQuestion(null)
    }
  }

  const isRunning = streamingStates.get(sessionId ?? '')?.running ?? false

  return (
    <div
      className={cn(
        'mx-3 mb-3 rounded-xl',
        'flex items-center gap-3 px-4 py-2.5',
        'bg-card/80 backdrop-blur-md border border-border/30 shadow-lg',
        'animate-in slide-in-from-bottom-2 duration-200',
      )}
    >
      {/* 左侧：节点信息 */}
      <div className="flex items-center gap-2 flex-shrink-0 max-w-[220px]">
        <MessageCircle className="size-4 text-blue-400 flex-shrink-0" />
        <span className="text-sm text-muted-foreground truncate">
          回复：{question.taskSubject}
        </span>
      </div>

      {/* 右侧：输入框 + 按钮 */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? '输入反馈，Agent 将自动调整任务…' : '输入反馈，启动 Agent 调整任务…'}
          disabled={sending}
          className={cn(
            'flex-1 min-w-0 h-9 px-3 text-sm',
            'bg-muted/50 rounded-lg border border-border/40',
            'placeholder:text-muted-foreground/40',
            'focus:outline-none focus:border-blue-400/50 focus:bg-muted/80',
            'transition-colors',
            sending && 'opacity-50',
          )}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className={cn(
            'flex-shrink-0 size-9 flex items-center justify-center rounded-lg',
            'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25',
            'transition-all duration-150',
            'disabled:opacity-30 disabled:cursor-not-allowed',
            sending && 'animate-pulse',
          )}
        >
          {sending ? (
            <div className="size-3.5 border-2 border-blue-400/40 border-t-blue-400 rounded-full animate-spin" />
          ) : (
            <CornerDownLeft className="size-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setQuestion(null)}
          className="flex-shrink-0 size-9 flex items-center justify-center rounded-lg
            text-muted-foreground/40 hover:text-foreground hover:bg-muted/50
            transition-all duration-150"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
