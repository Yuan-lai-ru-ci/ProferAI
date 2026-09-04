/**
 * AskUserBanner — Agent AskUserQuestion 交互式问答横幅
 *
 * 多问题用顶部 Tab 切换，选项竖向排列。
 * 键盘：↑↓ 选择选项，Enter 确认当前问题（最后一题提交，否则翻页）。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Send, X } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { allPendingAskUserRequestsAtom, askUserAnswersAtom, type AskUserQuestionAnswer } from '@/atoms/agent-atoms'
import { isEditableTarget } from '@/lib/navigation-controller'
import type { AskUserQuestion } from '@profer/shared'

const EMPTY_ANSWER: AskUserQuestionAnswer = { selected: [], customText: '', showCustom: false }

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

function safeUrlTransform(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return defaultUrlTransform(url)
}

/** AskUserBanner 属性接口 */
interface AskUserBannerProps {
  sessionId: string
  onRequestStop: () => void
}

export function AskUserBanner({ sessionId, onRequestStop }: AskUserBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingAskUserRequestsAtom)
  const [answersByRequest, setAnswersByRequest] = useAtom(askUserAnswersAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [submitting, setSubmitting] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState(0)
  const [focusedOptIdx, setFocusedOptIdx] = React.useState(-1)

  const request = requests[0] ?? null
  const questions = request?.questions ?? []
  const requestId = request?.requestId ?? null
  const isLastTab = activeTab >= questions.length - 1

  // 当前请求的答案草稿：按 requestId 从 atom 读取（请求不存在则空）
  const answers = React.useMemo<Map<number, AskUserQuestionAnswer>>(
    () => (requestId ? (answersByRequest.get(requestId) ?? new Map()) : new Map()),
    [answersByRequest, requestId],
  )

  // 写入当前请求的答案草稿（支持函数式更新；无请求则不写）
  const setAnswers = React.useCallback(
    (update: Map<number, AskUserQuestionAnswer> | ((prev: Map<number, AskUserQuestionAnswer>) => Map<number, AskUserQuestionAnswer>)): void => {
      if (!requestId) return
      setAnswersByRequest((prev) => {
        const map = new Map(prev)
        const cur = map.get(requestId) ?? new Map<number, AskUserQuestionAnswer>()
        map.set(requestId, typeof update === 'function'
          ? (update as (p: Map<number, AskUserQuestionAnswer>) => Map<number, AskUserQuestionAnswer>)(cur)
          : update)
        return map
      })
    },
    [requestId, setAnswersByRequest],
  )

  // ===== Refs：确保 keydown handler 始终读取最新值，消除闭包过期问题 =====
  const activeTabRef = React.useRef(activeTab)
  activeTabRef.current = activeTab
  const questionsRef = React.useRef(questions)
  questionsRef.current = questions
  const focusedOptIdxRef = React.useRef(focusedOptIdx)
  focusedOptIdxRef.current = focusedOptIdx
  const submitRef = React.useRef<(() => void) | null>(null)
  const autoAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAutoAdvanceTimer = React.useCallback((): void => {
    if (autoAdvanceTimerRef.current != null) {
      clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
  }, [])

  // 组件卸载时清理未触发的跳转定时器
  React.useEffect(() => clearAutoAdvanceTimer, [clearAutoAdvanceTimer])

  // 请求变化时重置焦点并初始化答案草稿：仅当该 requestId 无持久化答案时写入默认值。
  // 切回同一请求时答案已持久化在 askUserAnswersAtom，保留不覆盖。
  React.useEffect(() => {
    clearAutoAdvanceTimer()
    setActiveTab(0)
    setFocusedOptIdx(-1)
    const rid = request?.requestId ?? null
    if (!rid) return
    setAnswersByRequest((prev) => {
      if (prev.has(rid)) return prev
      const map = new Map(prev)
      const firstOpt = questions[0]?.options[0]
      const initial = new Map<number, AskUserQuestionAnswer>()
      if (firstOpt) initial.set(0, { ...EMPTY_ANSWER, selected: [firstOpt.label] })
      map.set(rid, initial)
      return map
    })
  }, [request?.requestId, questions, setAnswersByRequest])

  // 切换 Tab 时重置焦点并默认选中第一个选项
  React.useEffect(() => {
    setFocusedOptIdx(-1)
    setAnswers((prev) => {
      if (prev.has(activeTab)) return prev
      const firstOpt = questions[activeTab]?.options[0]
      if (!firstOpt) return prev
      const map = new Map(prev)
      map.set(activeTab, { ...EMPTY_ANSWER, selected: [firstOpt.label] })
      return map
    })
  }, [activeTab])

  // 键盘导航：只在 requestId 变化时重建 handler，内部通过 ref 读取最新值
  React.useEffect(() => {
    if (!request || questions.length === 0) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const curTab = activeTabRef.current
      const qs = questionsRef.current
      const curFocusIdx = focusedOptIdxRef.current
      const q = qs[curTab]
      if (!q) return
      const itemCount = q.options.length + 1
      const lastTab = curTab >= qs.length - 1

      // 自由文本与富文本编辑器内：仅 Enter 生效（输入法组合中跳过）。
      // ProseMirror/contenteditable 必须保留箭头键给原生光标移动。
      if (isEditableTarget(e.target)) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (lastTab) submitRef.current?.()
          else setActiveTab((prev) => prev + 1)
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const nextIdx = curFocusIdx === -1
          ? (e.key === 'ArrowDown' ? 0 : itemCount - 1)
          : e.key === 'ArrowDown'
            ? (curFocusIdx + 1) % itemCount
            : (curFocusIdx - 1 + itemCount) % itemCount
        setFocusedOptIdx(nextIdx)
        // 移动焦点同时选中
        if (nextIdx < q.options.length) {
          const opt = q.options[nextIdx]
          if (opt) toggleOptionByState(curTab, q, opt.label)
        } else {
          toggleCustomByState(curTab)
        }
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        if (lastTab) submitRef.current?.()
        else setActiveTab((prev) => prev + 1)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  /** 关闭问题，并经统一入口请求停止 Agent。 */
  const handleDismiss = (): void => {
    // 清理当前请求的答案草稿（随请求关闭失效）
    if (requestId) {
      setAnswersByRequest((prev) => {
        if (!prev.has(requestId)) return prev
        const map = new Map(prev)
        map.delete(requestId)
        return map
      })
    }
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    onRequestStop()
  }

  if (!request) return null

  const getAnswer = (idx: number): AskUserQuestionAnswer => answers.get(idx) ?? EMPTY_ANSWER

  function toggleOptionByState(qIdx: number, q: AskUserQuestion, label: string): void {
    setAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      const selected = q.multiSelect
        ? (cur.selected.includes(label) ? cur.selected.filter((s) => s !== label) : [...cur.selected, label])
        : [label]
      map.set(qIdx, { ...cur, selected, showCustom: false, customText: '' })
      return map
    })
  }

  function toggleCustomByState(qIdx: number): void {
    setAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      map.set(qIdx, { ...cur, showCustom: !cur.showCustom, selected: cur.showCustom ? cur.selected : [] })
      return map
    })
  }

  const handleSubmit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const answersRecord: Record<string, string> = {}
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        if (!q) continue
        const answer = getAnswer(i)
        const key = q.question || String(i)
        if (answer.showCustom && answer.customText.trim()) {
          answersRecord[key] = answer.customText.trim()
        } else if (answer.selected.length > 0) {
          answersRecord[key] = answer.selected.join(', ')
        }
      }
      await window.electronAPI.respondAskUser({ requestId: request.requestId, answers: answersRecord })
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
      // 提交成功：清理该请求的答案草稿
      setAnswersByRequest((prev) => {
        if (!prev.has(request.requestId)) return prev
        const map = new Map(prev)
        map.delete(request.requestId)
        return map
      })
    } catch (error) {
      console.error('[AskUserBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  submitRef.current = handleSubmit

  const hasValidAnswers = questions.some((_, idx) => {
    const a = getAnswer(idx)
    return a.selected.length > 0 || (a.showCustom && a.customText.trim().length > 0)
  })

  const currentQuestion = questions[activeTab]
  if (!currentQuestion) return null

  const goNextTab = (): void => {
    if (!isLastTab) setActiveTab((prev) => prev + 1)
  }

  return (
    <div className="ask-user-banner mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
      {/* 头部 + Tab 栏 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">Profer Agent 需要你的输入</span>
          <div className="flex items-center gap-1.5">
            {requests.length > 1 && (
              <span className="text-xs text-muted-foreground">(+{requests.length - 1})</span>
            )}
            <button
              type="button"
              className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={handleDismiss}
              title="关闭并终止 Agent"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Tab 栏（多问题时显示） */}
        {questions.length > 1 && (
          <div className="flex gap-1">
            {questions.map((q, idx) => {
              const isActive = idx === activeTab
              const hasAnswer = getAnswer(idx).selected.length > 0
                || (getAnswer(idx).showCustom && getAnswer(idx).customText.trim().length > 0)
              return (
                <button
                  key={idx}
                  type="button"
                  className={`
                    px-2.5 py-1 rounded-lg text-xs font-medium transition-all outline-none
                    ${isActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : hasAnswer
                        ? 'ask-user-question-tab-answered bg-primary/15 text-primary'
                        : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }
                  `}
                  onClick={() => setActiveTab(idx)}
                >
                  {`${idx + 1}-${q.multiSelect ? '多选' : '单选'}：${q.header || `问题 ${idx + 1}`}`}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 当前问题内容 */}
      <div className="px-4 pb-2">
        <QuestionCard
          question={currentQuestion}
          questionIndex={activeTab}
          answer={getAnswer(activeTab)}
          focusedIndex={focusedOptIdx}
          showBadge={questions.length === 1}
          onToggleOption={(label) => {
            toggleOptionByState(activeTab, currentQuestion, label)
            if (!currentQuestion.multiSelect && !isLastTab) {
              clearAutoAdvanceTimer()
              autoAdvanceTimerRef.current = setTimeout(() => {
                autoAdvanceTimerRef.current = null
                setActiveTab((prev) => prev + 1)
              }, 150)
            }
          }}
          onToggleCustom={() => toggleCustomByState(activeTab)}
          onCustomTextChange={(text) => setAnswers((prev) => {
            const map = new Map(prev)
            const cur = map.get(activeTab) ?? EMPTY_ANSWER
            map.set(activeTab, { ...cur, customText: text })
            return map
          })}
          onSubmit={isLastTab ? handleSubmit : goNextTab}
        />
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-end gap-1.5 px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40 mr-auto">
          ↑↓ 选择 · Enter {isLastTab ? '确认' : '下一个'}
        </span>
        {isLastTab && (
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
        )}
      </div>
    </div>
  )
}

/** 单个问题卡片（竖向选项） */
function QuestionCard({
  question,
  questionIndex,
  answer,
  focusedIndex,
  showBadge,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onSubmit,
}: {
  question: AskUserQuestion
  questionIndex: number
  answer: AskUserQuestionAnswer
  focusedIndex: number
  showBadge: boolean
  onToggleOption: (label: string) => void
  onToggleCustom: () => void
  onCustomTextChange: (text: string) => void
  onSubmit: () => void
}): React.ReactElement {
  const optionCount = question.options.length
  const previewOption = focusedIndex >= 0 && focusedIndex < optionCount
    ? question.options[focusedIndex]
    : question.options.find((o) => answer.selected.includes(o.label))
  const previewContent = previewOption?.preview

  return (
    <div className="space-y-2">
      {/* 问题标签 + 文本（分行显示） */}
      <div className="space-y-1">
        {showBadge && (
          <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground shadow-sm">
            {`${questionIndex + 1}-${question.multiSelect ? '多选' : '单选'}${question.header ? `：${question.header}` : ''}`}
          </span>
        )}
        <p className="text-sm text-foreground">{question.question}</p>
      </div>

      {/* 竖向选项 */}
      <div className="flex flex-col gap-1">
        {question.options.map((option, idx) => {
          const isSelected = answer.selected.includes(option.label)
          const isFocused = focusedIndex === idx
          return (
            <button
              key={option.label}
              type="button"
              className={`
                flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all outline-none text-left
                ${isSelected
                  ? 'ask-user-option-selected bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted/50 text-foreground/80 hover:bg-muted'
                }
                ${isFocused ? 'ask-user-option-focused ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
              `}
              onClick={() => onToggleOption(option.label)}
            >
              <span className={`text-[10px] shrink-0 ${isSelected ? 'text-primary-foreground/60' : 'text-muted-foreground/50'}`}>
                {idx + 1}
              </span>
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <span className={`ask-user-option-description text-[11px] ${isSelected ? 'ask-user-option-description-selected text-primary-foreground/70' : ''} ${isFocused ? 'ask-user-option-description-focused' : 'text-muted-foreground'}`}>
                  {option.description}
                </span>
              )}
            </button>
          )
        })}

        {/* "其他" */}
        <button
          type="button"
          className={`
            flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all outline-none text-left
            ${answer.showCustom
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'bg-muted/50 text-foreground/80 hover:bg-muted'
            }
            ${focusedIndex === optionCount ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-card' : ''}
          `}
          onClick={onToggleCustom}
        >
          <span className={`text-[10px] shrink-0 ${answer.showCustom ? 'text-primary-foreground/60' : 'text-muted-foreground/50'}`}>
            {optionCount + 1}
          </span>
          <span className="font-medium">其他...</span>
        </button>
      </div>

      {/* 自由文本输入 */}
      {answer.showCustom && (
        <input
          type="text"
          className="w-full px-3 py-2 rounded-lg text-xs bg-muted/40 focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 transition-colors"
          placeholder="输入自定义答案..."
          value={answer.customText}
          onChange={(e) => onCustomTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.stopPropagation() // 阻止冒泡到 document handler，避免重复触发 setActiveTab
              onSubmit()
            }
          }}
          autoFocus
        />
      )}

      {/* 选项 Preview（聚焦或选中时展示） */}
      {previewContent && (
        <div className="mt-2 rounded-lg bg-muted/40 p-3 text-xs prose prose-sm dark:prose-invert max-w-none prose-p:my-0 prose-headings:my-0.5 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} urlTransform={safeUrlTransform}>
            {previewContent}
          </Markdown>
        </div>
      )}
    </div>
  )
}
