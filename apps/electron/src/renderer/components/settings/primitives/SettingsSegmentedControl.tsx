/**
 * SettingsSegmentedControl - 分段选择器
 *
 * 用于少量选项的快速切换（如外观主题选择）。
 * 水平排列的按钮组，高亮当前选中项。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { LABEL_CLASS, DESCRIPTION_CLASS } from './SettingsUIConstants'

/** 分段选项定义 */
interface SegmentOption {
  value: string
  label: string
}

interface SettingsSegmentedControlProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选） */
  description?: string
  /** 当前值 */
  value: string
  /** 变更回调 */
  onValueChange: (value: string) => void
  /** 选项列表 */
  options: SegmentOption[]
  /** 是否禁用 */
  disabled?: boolean
}

export function SettingsSegmentedControl({
  label,
  description,
  value,
  onValueChange,
  options,
  disabled,
}: SettingsSegmentedControlProps): React.ReactElement {
  const id = React.useId()
  const descriptionId = `${id}-description`
  return (
    <div className="px-4 py-3 space-y-2">
      <div>
        <div id={id} className={LABEL_CLASS}>{label}</div>
        {description && (
          <div id={descriptionId} className={cn(DESCRIPTION_CLASS, 'mt-0.5')}>{description}</div>
        )}
      </div>
      <div
        role="group"
        aria-labelledby={id}
        aria-describedby={description ? descriptionId : undefined}
        className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-1"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={value === option.value}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15',
              'disabled:cursor-not-allowed disabled:opacity-50',
              value === option.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
