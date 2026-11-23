import * as React from 'react'
import { cn } from '../lib/cn'

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}

/** 列表与工作台共用的空态；各页面只提供内容和下一步操作。 */
export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps): React.ReactElement {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-4 px-6 py-16 text-center', className)} {...props}>
      {icon && <div aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-6">{icon}</div>}
      <div className="max-w-sm space-y-1.5">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}
