/**
 * AskUserBanner — Agent AskUserQuestion 交互式问答横幅
 *
 * 内联在 Agent 对话流底部，当 Agent 调用 AskUserQuestion 工具时显示。
 * 展示问题 + 选项按钮 + 自由文本"其他"输入，收集答案后回传给主进程。
 * 支持队列模式：多个并发请求按 FIFO 逐个展示。
 *
 * 设计参考 PermissionBanner 的同架构模式。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { MessageCircleQuestion, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { pendingAskUserRequestsAtom } from '@/atoms/agent-atoms'
import type { AskUserQuestion } from '@proma/shared'

/** 单个问题的答案状态 */
interface QuestionAnswer {
  /** 已选择的选项 label 列表 */
  selected: string[]
  /** 自由文本输入（"其他"选项） */
  customText: string
  /** 是否展示自由文本输入 */
  showCustom: boolean
}

export function AskUserBanner(): React.ReactElement | null {
  const [requests, setRequests] = useAtom(pendingAskUserRequestsAtom)
  const [answers, setAnswers] = React.useState<Map<number, QuestionAnswer>>(new Map())
  const [submitting, setSubmitting] = React.useState(false)

  // 展示队列中的第一个请求
  const request = requests[0] ?? null

  // 当请求变化时重置答案
  React.useEffect(() => {
    setAnswers(new Map())
  }, [request?.requestId])

  if (!request) return null

  /** 获取问题的答案状态 */
  const getAnswer = (idx: number): QuestionAnswer => {
    return answers.get(idx) ?? { selected: [], customText: '', showCustom: false }
  }

  /** 更新问题答案 */
  const updateAnswer = (idx: number, updater: (prev: QuestionAnswer) => QuestionAnswer): void => {
    setAnswers((prev) => {
      const map = new Map(prev)
      map.set(idx, updater(getAnswer(idx)))
      return map
    })
  }

  /** 切换选项选择 */
  const toggleOption = (questionIdx: number, question: AskUserQuestion, label: string): void => {
    updateAnswer(questionIdx, (prev) => {
      if (question.multiSelect) {
        const exists = prev.selected.includes(label)
        return {
          ...prev,
          selected: exists
            ? prev.selected.filter((s) => s !== label)
            : [...prev.selected, label],
          showCustom: false,
          customText: '',
        }
      }
      return {
        ...prev,
        selected: [label],
        showCustom: false,
        customText: '',
      }
    })
  }

  /** 切换"其他"自由文本输入 */
  const toggleCustom = (questionIdx: number): void => {
    updateAnswer(questionIdx, (prev) => ({
      ...prev,
      showCustom: !prev.showCustom,
      selected: prev.showCustom ? prev.selected : [],
    }))
  }

  /** 提交答案 */
  const handleSubmit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)

    try {
      // 构建答案 Record
      const answersRecord: Record<string, string> = {}
      for (let i = 0; i < request.questions.length; i++) {
        const answer = getAnswer(i)
        if (answer.showCustom && answer.customText.trim()) {
          answersRecord[String(i)] = answer.customText.trim()
        } else if (answer.selected.length > 0) {
          answersRecord[String(i)] = answer.selected.join(', ')
        }
      }

      await window.electronAPI.respondAskUser({
        requestId: request.requestId,
        answers: answersRecord,
      })

      // 移除已响应的请求（FIFO 出队）
      setRequests((prev) => prev.filter((r) => r.requestId !== request.requestId))
    } catch (error) {
      console.error('[AskUserBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  /** 检查是否有有效答案 */
  const hasValidAnswers = request.questions.some((_, idx) => {
    const answer = getAnswer(idx)
    return answer.selected.length > 0 || (answer.showCustom && answer.customText.trim().length > 0)
  })

  return (
    <div className="mx-4 mb-3 rounded-lg border border-blue-500/30 bg-blue-500/5 overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-blue-500" />
          <span className="text-sm font-medium">Agent 需要你的输入</span>
          {requests.length > 1 && (
            <span className="text-xs text-muted-foreground">
              (+{requests.length - 1})
            </span>
          )}
        </div>
      </div>

      {/* 问题列表 */}
      <div className="px-3 pb-2 space-y-3">
        {request.questions.map((question, qIdx) => (
          <QuestionCard
            key={qIdx}
            question={question}
            answer={getAnswer(qIdx)}
            onToggleOption={(label) => toggleOption(qIdx, question, label)}
            onToggleCustom={() => toggleCustom(qIdx)}
            onCustomTextChange={(text) => updateAnswer(qIdx, (prev) => ({ ...prev, customText: text }))}
            onSubmit={handleSubmit}
          />
        ))}
      </div>

      {/* 提交按钮 */}
      <div className="flex items-center justify-end gap-1.5 px-3 pb-2.5">
        <Button
          variant="default"
          size="sm"
          onClick={handleSubmit}
          disabled={submitting || !hasValidAnswers}
          className="h-7 px-3 text-xs"
        >
          <Send className="size-3 mr-1" />
          确认
        </Button>
      </div>
    </div>
  )
}

/** 单个问题卡片 */
function QuestionCard({
  question,
  answer,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onSubmit,
}: {
  question: AskUserQuestion
  answer: QuestionAnswer
  onToggleOption: (label: string) => void
  onToggleCustom: () => void
  onCustomTextChange: (text: string) => void
  onSubmit: () => void
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      {/* 问题文本 */}
      <div className="flex items-start gap-2">
        {question.header && (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
            {question.header}
          </span>
        )}
        <p className="text-sm text-foreground leading-relaxed">
          {question.question}
        </p>
      </div>

      {/* 选项按钮 */}
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option) => {
          const isSelected = answer.selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              className={`
                px-2.5 py-1 rounded-md text-xs transition-colors border
                ${isSelected
                  ? 'bg-blue-500/15 border-blue-500/40 text-blue-600 dark:text-blue-400'
                  : 'bg-background/50 border-border/50 text-muted-foreground hover:border-blue-500/30 hover:text-foreground'
                }
              `}
              onClick={() => onToggleOption(option.label)}
            >
              {option.label}
              {option.description && (
                <span className="ml-1 text-[10px] opacity-60">— {option.description}</span>
              )}
            </button>
          )
        })}

        {/* "其他"按钮 */}
        <button
          type="button"
          className={`
            px-2.5 py-1 rounded-md text-xs transition-colors border
            ${answer.showCustom
              ? 'bg-blue-500/15 border-blue-500/40 text-blue-600 dark:text-blue-400'
              : 'bg-background/50 border-border/50 text-muted-foreground hover:border-blue-500/30 hover:text-foreground'
            }
          `}
          onClick={onToggleCustom}
        >
          其他...
        </button>
      </div>

      {/* 自由文本输入 */}
      {answer.showCustom && (
        <input
          type="text"
          className="w-full px-2.5 py-1.5 rounded-md text-xs bg-background/50 border border-border/50 focus:border-blue-500/40 focus:outline-none placeholder:text-muted-foreground/50"
          placeholder="输入自定义答案..."
          value={answer.customText}
          onChange={(e) => onCustomTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
          autoFocus
        />
      )}
    </div>
  )
}
