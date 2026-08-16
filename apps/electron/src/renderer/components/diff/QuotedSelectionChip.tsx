/**
 * QuotedSelectionChip — 引用选中文本 / 中断说明 的 Chip 标签
 *
 * 显示在 Agent 输入框上方：
 * - quote（默认）：展示预览面板中选中的文本片段及来源文件（primary 视觉，两行：主文案 + 来源路径）
 * - interruption：展示任务中断原因说明（按中断类型配色，单行），悬停提示「向 Agent 说明中断原因」
 * 点击 X 按钮可移除。
 */

import * as React from 'react'
import { X, Quote, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getFileBaseName } from '@/lib/file-utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AgentInterruptionTone } from '@/atoms/preview-atoms'

interface QuotedSelectionChipProps {
  /** 选中的文本（截断显示） */
  text: string
  /** 来源文件路径（截断显示）；interruption 变体不渲染此副文案 */
  filePath: string
  /** 移除回调 */
  onRemove: () => void
  /** 视觉变体：quote=用户引用（默认）；interruption=中断说明 */
  variant?: 'quote' | 'interruption'
  /** 中断类型 → 视觉基调（仅 interruption 变体生效，默认 amber） */
  interruptionTone?: AgentInterruptionTone
  /** 悬停提示文案；有值时用 Tooltip 包裹 */
  tooltip?: string
  className?: string
}

/** 中断类型 → 色调样式映射（容器 / 图标 / 主文案） */
const INTERRUPTION_TONE_STYLES: Record<
  AgentInterruptionTone,
  { container: string; icon: string; text: string }
> = {
  amber: {
    container: 'bg-amber-500/10 border-amber-500/25 hover:bg-amber-500/15',
    icon: 'text-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  red: {
    container: 'bg-red-500/10 border-red-500/25 hover:bg-red-500/15',
    icon: 'text-red-500',
    text: 'text-red-600 dark:text-red-400',
  },
  muted: {
    container: 'bg-muted/20 border-muted/30 hover:bg-muted/30',
    icon: 'text-muted-foreground/70',
    text: 'text-muted-foreground',
  },
}

function truncateText(text: string, maxLen: number = 80): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLen
    ? singleLine.slice(0, maxLen - 3) + '...'
    : singleLine
}

function truncatePath(filePath: string, maxLen: number = 40): string {
  if (filePath.length <= maxLen) return filePath
  const name = getFileBaseName(filePath)
  return '.../' + name
}

export function QuotedSelectionChip({
  text,
  filePath,
  onRemove,
  variant = 'quote',
  interruptionTone = 'amber',
  tooltip,
  className,
}: QuotedSelectionChipProps): React.ReactElement {
  const handleRemoveClick = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onRemove()
  }, [onRemove])

  const isInterruption = variant === 'interruption'
  const toneStyles = INTERRUPTION_TONE_STYLES[interruptionTone]

  const chip = (
    <div
      className={cn(
        'group/chip relative flex items-start gap-2 shrink-0 max-w-[33%]',
        'rounded-lg border pl-2.5 pr-7 py-1.5 text-[13px]',
        'transition-colors',
        isInterruption
          ? toneStyles.container
          : 'bg-primary/8 border-primary/20 hover:bg-primary/12',
        className,
      )}
    >
      {isInterruption ? (
        <Info className={cn('size-4 shrink-0 mt-0.5', toneStyles.icon)} />
      ) : (
        <Quote className="size-4 shrink-0 mt-0.5 rotate-180 -translate-y-[3px] text-primary/60" />
      )}
      <div className="flex flex-col min-w-0">
        <span className={cn('line-clamp-2 leading-snug', isInterruption ? toneStyles.text : 'text-foreground/80')}>
          {truncateText(text)}
        </span>
        {!isInterruption && (
          <span className="text-[11px] mt-0.5 text-muted-foreground/60">
            {truncatePath(filePath)}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={handleRemoveClick}
        className={cn(
          'absolute top-1 right-1 size-[18px] rounded-full',
          'bg-foreground/10 text-foreground/50',
          'flex items-center justify-center',
          'opacity-0 group-hover/chip:opacity-100 transition-opacity duration-200',
          'hover:bg-foreground/20 hover:text-foreground',
        )}
        aria-label={isInterruption ? '移除中断说明' : '移除引用'}
      >
        <X className="size-3" />
      </button>
    </div>
  )

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent side="top">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return chip
}
