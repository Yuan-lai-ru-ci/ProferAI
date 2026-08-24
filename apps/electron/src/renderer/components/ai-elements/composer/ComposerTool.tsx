import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Agent Composer 的唯一交互外壳。
 *
 * 领域组件只提供内容、业务状态和事件；尺寸、hover、焦点、禁用态、Tooltip、
 * Popover 定位与菜单行不允许在各工具内重复定义。
 */
export type AgentComposerToolState = 'default' | 'active' | 'warning' | 'muted' | 'destructive'
export type AgentComposerToolPlacement = 'toolbar' | 'overflow'

export const AGENT_COMPOSER_TOOL_BASE_CLASS = [
  'shrink-0 rounded-full transition-colors duration-150',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const STATE_CLASS: Record<AgentComposerToolState, string> = {
  default: 'text-foreground/60 hover:bg-accent hover:text-foreground',
  active: 'text-primary hover:bg-primary/10 hover:text-primary',
  warning: 'text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300',
  muted: 'text-muted-foreground hover:bg-accent hover:text-foreground',
  destructive: 'text-destructive hover:bg-destructive/10 hover:text-destructive',
}

export function getAgentComposerToolSize(tabletMode = false): string {
  return tabletMode ? 'size-11' : 'size-[36px]'
}

export function getAgentComposerToolTriggerClass(
  state: AgentComposerToolState = 'default',
  tabletMode = false,
  className?: string,
): string {
  return cn(
    AGENT_COMPOSER_TOOL_BASE_CLASS,
    getAgentComposerToolSize(tabletMode),
    STATE_CLASS[state],
    className,
  )
}

interface AgentComposerToolTooltipProps {
  label: React.ReactNode
  children: React.ReactElement
}

/** Popover 触发器与普通按钮共用的统一 Tooltip。 */
export function AgentComposerToolTooltip({ label, children }: AgentComposerToolTooltipProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {typeof label === 'string' ? <p>{label}</p> : label}
      </TooltipContent>
    </Tooltip>
  )
}

export interface AgentComposerToolTriggerProps extends Omit<React.ComponentPropsWithoutRef<typeof Button>, 'size' | 'variant'> {
  label: string
  tooltip?: React.ReactNode
  state?: AgentComposerToolState
  tabletMode?: boolean
  children: React.ReactNode
}

/**
 * 所有 Agent 输入工具的唯一按钮壳。forwardRef 是 Radix Tooltip/Popover asChild
 * 正确转发交互事件的必要条件，避免旧代码各工具不同的 hover/focus 行为。
 */
export const AgentComposerToolTrigger = React.forwardRef<HTMLButtonElement, AgentComposerToolTriggerProps>(function AgentComposerToolTrigger({
  label,
  tooltip,
  state = 'default',
  tabletMode = false,
  className,
  children,
  ...props
}, ref) {
  const button = (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      className={getAgentComposerToolTriggerClass(state, tabletMode, className)}
      {...props}
    >
      {children}
    </Button>
  )

  return tooltip ? <AgentComposerToolTooltip label={tooltip}>{button}</AgentComposerToolTooltip> : button
})

interface AgentComposerToolPopoverProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 未包 Tooltip 的单个、forwardRef 的 trigger。 */
  trigger: React.ReactElement
  tooltip?: React.ReactNode
  children: React.ReactNode
  className?: string
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}

/** 所有 Agent 输入工具从输入框上方展开，并采用同一 surface/focus 行为。 */
export function AgentComposerToolPopover({
  open,
  onOpenChange,
  trigger,
  tooltip,
  children,
  className,
  align = 'center',
  sideOffset = 8,
}: AgentComposerToolPopoverProps): React.ReactElement {
  const popoverTrigger = <PopoverTrigger asChild>{trigger}</PopoverTrigger>
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {tooltip ? <AgentComposerToolTooltip label={tooltip}>{popoverTrigger}</AgentComposerToolTooltip> : popoverTrigger}
      <PopoverContent
        side="top"
        align={align}
        sideOffset={sideOffset}
        className={cn('p-1.5', className)}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

export interface AgentComposerToolMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  children: React.ReactNode
}

/** Agent composer 弹层的唯一菜单行。 */
export function AgentComposerToolMenuItem({
  selected = false,
  className,
  children,
  ...props
}: AgentComposerToolMenuItemProps): React.ReactElement {
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors',
        'hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
        selected && 'bg-accent font-medium',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
