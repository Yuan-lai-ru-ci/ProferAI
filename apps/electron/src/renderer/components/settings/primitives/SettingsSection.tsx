/**
 * SettingsSection - 设置区块容器
 *
 * 提供区块标题、描述和可选的操作按钮插槽。
 * 用于将相关的设置项分组显示。
 */

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@profer/ui/primitives/collapsible'
import { SECTION_TITLE_CLASS, SECTION_DESCRIPTION_CLASS } from './SettingsUIConstants'

interface SettingsSectionProps {
  /** 区块标题 */
  title: React.ReactNode
  /** 区块描述（可选） */
  description?: string
  /** 右侧操作按钮插槽（可选） */
  action?: React.ReactNode
  /** 子内容 */
  children: React.ReactNode
  /** 是否将区块内容折叠；默认收起时只保留标题和操作区。 */
  collapsible?: boolean
  /** 可折叠区块的初始状态。 */
  defaultOpen?: boolean
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  collapsible = false,
  defaultOpen = true,
}: SettingsSectionProps): React.ReactElement {
  const header = (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1">
        {collapsible ? (
          <CollapsibleTrigger
            className="group flex max-w-full items-start gap-2 text-left"
            aria-label={`展开或收起${typeof title === 'string' ? title : '设置区块'}`}
          >
            <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            <span className="min-w-0">
              <span role="heading" aria-level={3} className={SECTION_TITLE_CLASS}>{title}</span>
              {description && <span className={SECTION_DESCRIPTION_CLASS}>{description}</span>}
            </span>
          </CollapsibleTrigger>
        ) : (
          <>
            <h3 className={SECTION_TITLE_CLASS}>{title}</h3>
            {description && <p className={SECTION_DESCRIPTION_CLASS}>{description}</p>}
          </>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  )

  if (!collapsible) {
    return (
      <section className="settings-section space-y-3">
        {header}
        {children}
      </section>
    )
  }

  return (
    <Collapsible defaultOpen={defaultOpen} className="settings-section space-y-3">
      <section>
        {header}
        <CollapsibleContent className="mt-3">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}
