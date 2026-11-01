import * as React from 'react'
import { cn } from '@/lib/utils'

/** 时间线提示卡共用正文排版；外缘从消息列起点开始，与模型头像左缘对齐。 */
export function TimelineNoticeCard({ children, className, tone = 'neutral', ...props }: React.ComponentProps<'div'> & { tone?: 'neutral' | 'warning' }): React.ReactElement {
  return (
    <div className={cn('my-3 mx-2.5 min-w-0 text-[length:var(--md-preview-font-size,15px)] leading-[1.6]', className)} {...props}>
      <div className={cn('rounded-md px-3 py-2.5 text-foreground/80', tone === 'warning' ? 'border border-amber-500/20 bg-amber-500/5' : 'bg-muted/40')}>
        {children}
      </div>
    </div>
  )
}
