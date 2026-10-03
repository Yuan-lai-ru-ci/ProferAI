/**
 * AI Elements - 对话容器原语
 *
 * 由共享视口控制器管理跟随、阅读锚点与导航。
 *
 * 包含：
 * - Conversation — 根容器与滚动 context
 * - ConversationContent — 内容区域
 * - ConversationEmptyState — 空状态
 * - ConversationScrollButton — 滚动到底部按钮
 */

import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { ArrowDownIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { useCallback } from 'react'
import { ConversationScrollProvider, useConversationScroll, type ConversationScrollActions } from './conversation-scroll'

// ===== Conversation 根容器 =====

export interface ConversationProps extends Omit<ComponentProps<'div'>, 'children'> {
  resize?: 'instant' | 'smooth'
  children: React.ReactNode | ((context: ConversationScrollActions) => React.ReactNode)
}

export function Conversation({ className, children, resize = 'smooth', ...props }: ConversationProps): React.ReactElement {
  return (
    <div className={cn('relative flex-1 overflow-y-hidden scrollbar-none', className)} role="log" {...props}>
      <ConversationScrollProvider smoothResize={resize === 'smooth'}>{children}</ConversationScrollProvider>
    </div>
  )
}

// ===== ConversationContent 内容区域 =====

export type ConversationContentProps = ComponentProps<'div'> & { scrollClassName?: string }

export function ConversationContent({ className, scrollClassName, ...props }: ConversationContentProps): React.ReactElement {
  const { scrollRef, contentRef } = useConversationScroll()
  return (
    <div ref={scrollRef} className={cn('profer-scroll-region overflow-y-auto', scrollClassName)}
      style={{ height: '100%', width: '100%', scrollbarGutter: 'stable both-edges', overflowAnchor: 'none', scrollBehavior: 'auto' }}>
      <div ref={contentRef} className={cn('flex flex-col gap-1 py-4 px-8', className)} {...props} />
    </div>
  )
}

// ===== ConversationEmptyState 空状态 =====

export interface ConversationEmptyStateProps extends ComponentProps<'div'> {
  title?: string
  description?: string
  icon?: React.ReactNode
}

export function ConversationEmptyState({
  className,
  title = '暂无消息',
  description = '在下方输入框开始对话',
  icon,
  children,
  ...props
}: ConversationEmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex size-full flex-col items-center justify-center gap-3 p-8 text-center',
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-muted-foreground">{icon}</div>}
          <div className="space-y-1">
            <h3 className="font-medium text-sm">{title}</h3>
            {description && (
              <p className="text-muted-foreground text-sm">{description}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ===== ConversationScrollButton 滚动到底部 =====

export type ConversationScrollButtonProps = ComponentProps<typeof Button>

export function ConversationScrollButton({
  className,
  ...props
}: ConversationScrollButtonProps): React.ReactElement | null {
  const { following, follow } = useConversationScroll()

  const handleScrollToBottom = useCallback(() => {
    follow()
  }, [follow])

  if (following) return null

  return (
    <Button
      data-scroll-to-bottom
      aria-label="回到最新消息"
      title="回到最新消息"
      className={cn(
        'absolute bottom-[26px] left-1/2 z-50 -translate-x-1/2 rounded-[17px] size-9',
        'border-[0.5px] border-border bg-background/95 shadow-md backdrop-blur-sm',
        className
      )}
      onClick={handleScrollToBottom}
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  )
}
