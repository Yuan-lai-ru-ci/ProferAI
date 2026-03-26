/**
 * ContentBlock — 单个 SDKAssistantMessage 内容块渲染
 *
 * 支持三种内容块类型：
 * - text: 通过 MessageResponse 渲染 Markdown
 * - tool_use: 简洁单行（图标 + 工具名 + 摘要），可展开详情
 * - thinking: 默认展开，左上角 "Thinking" 标签 + 虚线边框内容区
 */

import * as React from 'react'
import {
  ChevronRight,
  XCircle,
  Loader2,
  Brain,
  MessageSquareText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MessageResponse } from '@/components/ai-elements/message'
import { getToolIcon, getToolDisplayName, getInputSummary } from './tool-utils'
import type {
  SDKContentBlock,
  SDKMessage,
  SDKTextBlock,
  SDKToolUseBlock,
  SDKThinkingBlock,
  SDKUserMessage,
  SDKToolResultBlock,
} from '@proma/shared'

// ===== useToolResult Hook =====

interface ToolResultData {
  result?: string
  isError?: boolean
}

/** 在 allMessages 中查找匹配 toolUseId 的工具结果 */
function useToolResult(toolUseId: string, allMessages: SDKMessage[]): ToolResultData | null {
  return React.useMemo(() => {
    for (const msg of allMessages) {
      if (msg.type !== 'user') continue
      const userMsg = msg as SDKUserMessage
      const contentBlocks = userMsg.message?.content
      if (!Array.isArray(contentBlocks)) continue

      for (const block of contentBlocks) {
        if (block.type === 'tool_result') {
          const resultBlock = block as SDKToolResultBlock
          if (resultBlock.tool_use_id === toolUseId) {
            let result: string | undefined
            if (typeof resultBlock.content === 'string') {
              result = resultBlock.content
            } else if (Array.isArray(resultBlock.content)) {
              result = (resultBlock.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text)
                .join('\n')
            }
            return { result, isError: resultBlock.is_error }
          }
        }
      }
    }
    return null
  }, [toolUseId, allMessages])
}

// ===== ContentBlock Props =====

export interface ContentBlockProps {
  /** 内容块数据 */
  block: SDKContentBlock
  /** 所有消息（用于查找工具结果） */
  allMessages: SDKMessage[]
  /** 相对路径解析基准（文件链接用） */
  basePath?: string
  /** 是否启用入场动画 */
  animate?: boolean
  /** 在父级中的索引（用于动画延迟） */
  index?: number
  /** 当 turn 中已有主要内容（text）时，非主要块（tool/thinking）颜色变淡 */
  dimmed?: boolean
  /** 子代理的内容块（Agent/Task 工具调用的嵌套子块） */
  childBlocks?: SDKContentBlock[]
}

// ===== 工具调用块（简洁单行风格） =====

interface ToolUseBlockProps {
  block: SDKToolUseBlock
  allMessages: SDKMessage[]
  animate?: boolean
  index?: number
  dimmed?: boolean
  /** 子代理的内容块（Agent/Task 嵌套） */
  childBlocks?: SDKContentBlock[]
  basePath?: string
}

function ToolUseBlock({ block, allMessages, animate = false, index = 0, dimmed = false, childBlocks, basePath }: ToolUseBlockProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const toolResult = useToolResult(block.id, allMessages)
  const isAgentTool = block.name === 'Agent' || block.name === 'Task'
  const hasChildren = isAgentTool && childBlocks && childBlocks.length > 0

  // Agent/Task 子代理内容默认折叠
  const [childrenExpanded, setChildrenExpanded] = React.useState(false)

  const displayName = getToolDisplayName(block.name)
  const inputSummary = getInputSummary(block.name, block.input)
  const ToolIcon = getToolIcon(block.name)

  const isCompleted = toolResult !== null
  const isError = toolResult?.isError === true

  const delay = animate && index < 10 ? `${index * 30}ms` : '0ms'

  // Agent/Task: 提取 prompt 用于气泡展示
  const agentPrompt = isAgentTool
    ? (typeof block.input.prompt === 'string' ? block.input.prompt : undefined)
    : undefined

  // 子代理工具调用统计
  const childToolCount = childBlocks?.filter((b) => b.type === 'tool_use').length ?? 0

  // ===== Agent/Task 工具：特殊渲染 =====
  if (isAgentTool) {
    return (
      <div
        className={cn(
          animate && 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both',
        )}
        style={animate ? { animationDelay: delay } : undefined}
      >
        {/* 头部行：折叠箭头 + Spinner + 工具名 + 描述 */}
        <button
          type="button"
          className="w-full flex items-center gap-2 py-0.5 text-left hover:opacity-70 transition-opacity group"
          onClick={() => setChildrenExpanded(!childrenExpanded)}
        >
          <ChevronRight
            className={cn(
              'size-3 text-muted-foreground/50 transition-transform duration-150 shrink-0',
              childrenExpanded && 'rotate-90',
            )}
          />

          {/* Spinner / 完成状态 */}
          {!isCompleted ? (
            <Loader2 className="size-3.5 animate-spin text-primary/50 shrink-0" />
          ) : isError ? (
            <XCircle className="size-3.5 text-destructive/70 shrink-0" />
          ) : null}

          <ToolIcon className={cn('size-3.5 shrink-0', dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground')} />

          <span className={cn(
            'shrink-0 text-[14px]',
            dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground',
          )}>{displayName}</span>

          {inputSummary && (
            <span className={cn(
              'truncate text-[14px]',
              dimmed ? 'text-muted-foreground/50' : 'text-muted-foreground/60',
            )}>
              {inputSummary}
            </span>
          )}

          {/* 子工具计数（折叠时显示） */}
          {childToolCount > 0 && !childrenExpanded && (
            <span className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums">
              {childToolCount} 项工具调用
            </span>
          )}
        </button>

        {/* 展开内容 */}
        {childrenExpanded && (
          <div className="pl-5 mt-1.5 space-y-2 border-l-2 border-primary/20 ml-[5px] animate-in fade-in slide-in-from-top-1 duration-150">
            {/* Prompt 气泡 */}
            {agentPrompt && (
              <div className="flex items-start gap-2 py-1">
                <MessageSquareText className="size-3.5 text-primary/60 shrink-0 mt-0.5" />
                <p className="text-[13px] text-foreground/70 leading-relaxed whitespace-pre-wrap break-words">
                  {agentPrompt.length > 500 ? agentPrompt.slice(0, 500) + '…' : agentPrompt}
                </p>
              </div>
            )}

            {/* 子代理工具调用 */}
            {hasChildren && childBlocks.map((childBlock, ci) => (
              <ContentBlock
                key={ci}
                block={childBlock}
                allMessages={allMessages}
                basePath={basePath}
                animate
                index={ci}
                dimmed
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // ===== 普通工具：原有渲染 =====
  return (
    <div
      className={cn(
        animate && 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both',
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <button
        type="button"
        className="flex items-center gap-2 py-0.5 text-left hover:opacity-70 transition-opacity group"
        onClick={() => setExpanded(!expanded)}
      >
        {!isCompleted ? (
          <Loader2 className="size-3.5 animate-spin text-primary/50 shrink-0" />
        ) : isError ? (
          <XCircle className="size-3.5 text-destructive/70 shrink-0" />
        ) : null}

        <ToolIcon className={cn('size-3.5 shrink-0', dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground')} />

        <span className={cn(
          'shrink-0 text-[14px]',
          dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground',
        )}>{displayName}</span>

        {inputSummary && (
          <span className={cn(
            'truncate text-[14px] font-mono',
            dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground',
          )}>
            {inputSummary}
          </span>
        )}

        <ChevronRight
          className={cn(
            'shrink-0 size-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-all duration-150',
            expanded && 'rotate-90 opacity-100',
          )}
        />
      </button>

      {expanded && (
        <div className="ml-5.5 mt-1 mb-2 space-y-2 pl-3 border-l-2 border-border/30 animate-in fade-in slide-in-from-top-1 duration-150">
          {Object.keys(block.input).length > 0 && (
            <div>
              <div className="text-[11px] font-medium text-muted-foreground/50 mb-1">输入</div>
              <pre className="text-[11px] text-muted-foreground bg-muted/30 rounded p-2 overflow-x-auto max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          )}
          {toolResult?.result && (
            <div>
              <div className="text-[11px] font-medium text-muted-foreground/50 mb-1">结果</div>
              <pre
                className={cn(
                  'text-[11px] rounded p-2 overflow-x-auto max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all',
                  isError
                    ? 'text-destructive/80 bg-destructive/5'
                    : 'text-muted-foreground bg-muted/30',
                )}
              >
                {toolResult.result.length > 2000
                  ? toolResult.result.slice(0, 2000) + '\n… [截断]'
                  : toolResult.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ===== 思考块（默认展开，Thinking 标签 + 虚线边框） =====

interface ThinkingBlockProps {
  block: SDKThinkingBlock
  dimmed?: boolean
}

function ThinkingBlock({ block, dimmed = false }: ThinkingBlockProps): React.ReactElement {
  return (
    <div className="relative mb-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Brain className={cn('size-3.5', dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground')} />
        <span className={cn('text-[14px] uppercase tracking-wider', dimmed ? 'text-muted-foreground/70' : 'text-muted-foreground')}>
          Thinking
        </span>
      </div>
      <div
        className={cn(
          'rounded-lg px-3.5 py-2.5',
          dimmed ? 'bg-muted/30' : 'bg-muted/50',
        )}
        style={{
          border: 'none',
          backgroundImage: `url("data:image/svg+xml,%3csvg width='100%25' height='100%25' xmlns='http://www.w3.org/2000/svg'%3e%3crect width='100%25' height='100%25' fill='none' rx='8' ry='8' stroke='${dimmed ? 'rgba(128,128,128,0.3)' : 'rgba(128,128,128,0.5)'}' stroke-width='1.5' stroke-dasharray='8%2c 6' stroke-dashoffset='0' stroke-linecap='round'/%3e%3c/svg%3e")`,
        }}
      >
        <div className={cn(
          'prose prose-sm dark:prose-invert max-w-none prose-p:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 whitespace-pre-wrap text-[14px] leading-relaxed',
          dimmed ? 'text-muted-foreground' : 'text-foreground/90',
        )}>
          {block.thinking}
        </div>
      </div>
    </div>
  )
}

// ===== ContentBlock 主组件 =====

export function ContentBlock({ block, allMessages, basePath, animate = false, index = 0, dimmed = false, childBlocks }: ContentBlockProps): React.ReactElement | null {
  // text 块 — 主要内容，不受 dimmed 影响
  if (block.type === 'text') {
    const textBlock = block as SDKTextBlock
    if (!textBlock.text) return null
    return (
      <MessageResponse basePath={basePath}>{textBlock.text}</MessageResponse>
    )
  }

  // tool_use 块
  if (block.type === 'tool_use') {
    const toolBlock = block as SDKToolUseBlock
    return (
      <ToolUseBlock
        block={toolBlock}
        allMessages={allMessages}
        animate={animate}
        index={index}
        dimmed={dimmed}
        childBlocks={childBlocks}
        basePath={basePath}
      />
    )
  }

  // thinking 块
  if (block.type === 'thinking') {
    const thinkingBlock = block as SDKThinkingBlock
    if (!thinkingBlock.thinking) return null
    return <ThinkingBlock block={thinkingBlock} dimmed={dimmed} />
  }

  return null
}
