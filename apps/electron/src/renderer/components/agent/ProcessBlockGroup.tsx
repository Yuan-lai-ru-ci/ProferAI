import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToolDisplayName, getToolIcon } from './tool-utils'
import type {
  SDKContentBlock,
  SDKToolUseBlock,
} from '@profer/shared'
import { isGoalUpdateToolName } from '@profer/shared'

interface ProcessBlockGroupProps {
  blocks: SDKContentBlock[]
  isStreaming?: boolean
  scrollAnchorId?: string
  keepExpandedAfterComplete: boolean
  // 该过程组是否为整条消息的末尾项：是则流式中保留最后一段为正常显示，
  // 否则（最终答案已作为后续兄弟块外置）整组统一弱化。
  isMessageTail?: boolean
  /**
   * 过程内容挂载状态变化。
   *
   * 上层据此决定何时推进渲染窗口的折叠边界：折叠会移走已渲染的段，
   * 只有内容真正不在 DOM 里（收起完成后）才推进才不会造成可见重排。
   */
  onContentVisibilityChange?: (visible: boolean) => void
  children: React.ReactNode
}

const MAX_PROCESS_GROUP_ICONS = 4
const PROCESS_GROUP_COLLAPSE_DURATION_MS = 500
const PROCESS_GROUP_AUTO_COLLAPSE_SOUND_DELAY_MS = 900
const PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS = 3

export { buildAssistantTurnRenderItems, buildCompletedToolResultIds } from './render-block-derivation'
export type { AssistantTurnRenderItem, IndexedContentBlock } from './render-block-derivation'

export function buildProcessGroupSummary(blocks: SDKContentBlock[]): string {
  let toolCount = 0
  let thinkingCount = 0
  let messageCount = 0

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      if (isGoalUpdateToolName((block as SDKToolUseBlock).name)) continue
      toolCount += 1
    } else if (block.type === 'thinking') {
      // 思考与正文分开计数：思考是可读 CoT 时的主内容，笼统写「消息」会让用户
      // 在过程组里找不到自己期待的思考块（历史上就出现过「N 条消息」展开却空无一物）。
      thinkingCount += 1
    } else if (block.type === 'text') {
      messageCount += 1
    }
  }

  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} 次工具调用`)
  if (thinkingCount > 0) parts.push(`${thinkingCount} 段思考`)
  if (messageCount > 0) parts.push(`${messageCount} 条消息`)
  const summary = parts.join('，') || '过程'
  return `执行过程：${summary}`
}

export function buildProcessGroupToolNames(blocks: SDKContentBlock[]): string[] {
  const toolNames: string[] = []
  const seen = new Set<string>()

  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const toolBlock = block as SDKToolUseBlock
    if (isGoalUpdateToolName(toolBlock.name)) continue
    if (seen.has(toolBlock.name)) continue
    seen.add(toolBlock.name)
    toolNames.push(toolBlock.name)
  }

  return toolNames
}

export function ProcessBlockGroup({ blocks, isStreaming, scrollAnchorId, keepExpandedAfterComplete, isMessageTail = false, onContentVisibilityChange, children }: ProcessBlockGroupProps): React.ReactElement {
  const shouldExpandByDefault = !!isStreaming || keepExpandedAfterComplete
  const [expanded, setExpanded] = React.useState(shouldExpandByDefault)
  const [shouldRenderContent, setShouldRenderContent] = React.useState(shouldExpandByDefault)
  const [collapseCountdown, setCollapseCountdown] = React.useState<number | null>(null)
  const userToggledRef = React.useRef(false)
  const wasStreamingRef = React.useRef(!!isStreaming)
  const autoCollapseTimersRef = React.useRef<number[]>([])
  // 1.7.2 折叠自锁：上一轮结束已调度折叠倒计时；折叠完成后不再被 streaming 分支重新展开。
  // 队列无缝衔接时 streaming false 窗口极短，新一轮 true 分支会 clearAutoCollapseTimers() + 重新展开，
  // 导致上一轮折叠被取消——用这两个 ref 锁住「已调度的折叠」不被撤销。
  const collapseScheduledRef = React.useRef(false)
  const collapseDoneRef = React.useRef(false)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [measuredHeight, setMeasuredHeight] = React.useState<number | undefined>(undefined)

  const clearAutoCollapseTimers = React.useCallback(() => {
    for (const timer of autoCollapseTimersRef.current) window.clearTimeout(timer)
    autoCollapseTimersRef.current = []
  }, [])

  React.useEffect(() => {
    // 1.7.2：已完成一次自动折叠——此后不参与 streaming 驱动的展开/折叠（除非用户手动展开）
    if (collapseDoneRef.current) return

    if (isStreaming || keepExpandedAfterComplete) {
      // 新一轮 streaming 开始：若上一轮已调度折叠，不取消它、也不重新展开
      if (collapseScheduledRef.current) {
        wasStreamingRef.current = true
        return
      }
      clearAutoCollapseTimers()
      setCollapseCountdown(null)
      if (isStreaming && !wasStreamingRef.current) {
        userToggledRef.current = false
      }
      if (!userToggledRef.current) {
        setExpanded(true)
      }
      wasStreamingRef.current = !!isStreaming
      return
    }

    const shouldAutoCollapseAfterCompletion = wasStreamingRef.current && !userToggledRef.current
    wasStreamingRef.current = false

    if (!shouldAutoCollapseAfterCompletion) {
      if (!userToggledRef.current) {
        setExpanded(false)
      }
      return
    }
    if (collapseScheduledRef.current) return  // 已在调度，勿重复

    collapseScheduledRef.current = true
    const soundDelayTimer = window.setTimeout(() => {
      setCollapseCountdown(PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS)

      for (let second = PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - 1; second >= 1; second--) {
        const elapsed = (PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS - second) * 1000
        autoCollapseTimersRef.current.push(window.setTimeout(() => setCollapseCountdown(second), elapsed))
      }

      autoCollapseTimersRef.current.push(window.setTimeout(() => {
        setCollapseCountdown(null)
        setExpanded(false)
        // 折叠完成：释放调度锁、置完成锁，后续不再被 streaming 分支重新展开
        collapseScheduledRef.current = false
        collapseDoneRef.current = true
      }, PROCESS_GROUP_AUTO_COLLAPSE_COUNTDOWN_SECONDS * 1000))
    }, PROCESS_GROUP_AUTO_COLLAPSE_SOUND_DELAY_MS)
    autoCollapseTimersRef.current.push(soundDelayTimer)
  }, [clearAutoCollapseTimers, isStreaming, keepExpandedAfterComplete])

  // 组件卸载时清理全部折叠定时器。effect 内不再注册 cleanup，
  // 避免新一轮 streaming 重跑 effect 时把上一轮已调度的折叠倒计时误清掉。
  React.useEffect(() => {
    return clearAutoCollapseTimers
  }, [clearAutoCollapseTimers])

  // 上报内容是否真的在 DOM 里。用 shouldRenderContent 而不是 expanded：
  // 折叠动画期间内容还挂着，动画跑完（约 500ms）卸载后才算不可见。
  React.useEffect(() => {
    onContentVisibilityChange?.(shouldRenderContent)
  }, [shouldRenderContent, onContentVisibilityChange])

  // 折叠前测量实际高度，用于丝滑的 height 过渡（子元素不 reflow，只裁剪边界）
  React.useEffect(() => {
    if (expanded) {
      setShouldRenderContent(true)
      setMeasuredHeight(undefined)
      return
    }

    // 折叠时：先测量当前高度，触发 height 过渡动画，动画结束后卸载 DOM
    const el = contentRef.current
    let frame: number | undefined
    if (el) {
      const h = el.scrollHeight
      setMeasuredHeight(h)
      // 展开/卸载会取消旧帧，避免迟到的折叠写入覆盖新状态。
      frame = requestAnimationFrame(() => setMeasuredHeight(0))
    }

    const timer = window.setTimeout(() => setShouldRenderContent(false), PROCESS_GROUP_COLLAPSE_DURATION_MS)
    return () => {
      window.clearTimeout(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [expanded])

  const summary = React.useMemo(
    () => buildProcessGroupSummary(blocks),
    [blocks],
  )
  const toolNames = React.useMemo(() => buildProcessGroupToolNames(blocks), [blocks])
  const visibleToolNames = toolNames.slice(0, MAX_PROCESS_GROUP_ICONS)
  const hiddenToolCount = Math.max(0, toolNames.length - visibleToolNames.length)

  // 内容区子项渲染策略：
  // - 流式中：每个新块有入场动画，最新一段（消息末尾过程组的最后一个 child）保持正常显示，
  //   其余步骤轻微弱化以引导视觉重心到最下方。
  // - 流式结束后用户展开：所有内容以正常颜色显示，无动画。
  const childArray = React.Children.toArray(children)
  const renderContentChildren = (): React.ReactNode =>
    childArray.map((child, i) => {
      const isLast = i === childArray.length - 1
      const dimmed = isStreaming && !(isMessageTail && isLast)
      return (
        <div
          key={React.isValidElement(child) ? child.key : i}
          className={cn(
            dimmed && 'opacity-80',
            isStreaming && 'animate-in fade-in slide-in-from-top-1 duration-200',
          )}
        >
          {child}
        </div>
      )
    })

  return (
    <div className="space-y-1.5">
      <button
        data-scroll-anchor={scrollAnchorId}
        type="button"
        className={cn(
          'flex max-w-full items-center gap-2 py-0.5 text-left transition-opacity group',
          'hover:opacity-70',
        )}
        onClick={() => {
          userToggledRef.current = true
          // 1.7.2：手动展开/收起后重置自锁，后续按 streaming 规则重新参与折叠
          collapseScheduledRef.current = false
          collapseDoneRef.current = false
          clearAutoCollapseTimers()
          setCollapseCountdown(null)
          setExpanded((prev) => !prev)
        }}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/40 transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        <span className="min-w-0 truncate text-[14px] text-muted-foreground">{summary}</span>
        {collapseCountdown !== null && (
          <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground/50">
            （{collapseCountdown}）
          </span>
        )}
        {visibleToolNames.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground/60">
            {visibleToolNames.map((toolName) => {
              const ToolIcon = getToolIcon(toolName)
              return (
                <ToolIcon
                  key={toolName}
                  className="size-3.5"
                  aria-label={getToolDisplayName(toolName)}
                />
              )
            })}
            {hiddenToolCount > 0 && (
              <span className="text-[11px] tabular-nums text-muted-foreground/60">
                +{hiddenToolCount}
              </span>
            )}
          </span>
        )}
      </button>

      {shouldRenderContent && (
        <div
          ref={contentRef}
          className="overflow-hidden"
          style={{
            height: measuredHeight !== undefined ? `${measuredHeight}px` : 'auto',
            opacity: expanded ? 1 : 0,
            transition: measuredHeight !== undefined
              ? `height ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out, opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out`
              : `opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-in-out`,
          }}
        >
          <div className="space-y-2">
            {renderContentChildren()}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="flex shrink-0 items-center gap-1 text-xs text-foreground/40 hover:text-foreground/70 transition-colors"
                onClick={() => {
                  userToggledRef.current = true
                  // 1.7.2：手动收起后重置自锁，后续按 streaming 规则重新参与折叠
                  collapseScheduledRef.current = false
                  collapseDoneRef.current = false
                  clearAutoCollapseTimers()
                  setCollapseCountdown(null)
                  setExpanded(false)
                }}
              >
                <ChevronRight className="size-3 -rotate-90" />
                <span>收起</span>
              </button>
              <div aria-hidden="true" className="min-w-0 flex-1 border-t-2 border-dashed border-border/60" />
            </div>
            </div>
          </div>
        )}
      </div>
  )
}
