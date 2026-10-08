/**
 * SettingsSecretInput - API Key 专用密码输入控件
 *
 * 内置密码显隐切换，适用于 API Key 等敏感信息输入。
 */

import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@profer/ui/primitives/input'
import { LABEL_CLASS, DESCRIPTION_CLASS } from './SettingsUIConstants'
import { cn } from '@/lib/utils'

interface SettingsSecretInputProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选） */
  description?: string
  /** 输入值 */
  value: string
  /** 变更回调 */
  onChange: (value: string) => void
  /** 占位符 */
  placeholder?: string
  /** 是否必填 */
  required?: boolean
  /** 是否禁用 */
  disabled?: boolean
}

export function SettingsSecretInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  required,
  disabled,
}: SettingsSecretInputProps): React.ReactElement {
  const [visible, setVisible] = React.useState(false)
  const id = React.useId()
  const descriptionId = `${id}-description`

  return (
    <div className="px-4 py-3 space-y-2">
      <div>
        <label htmlFor={id} className={LABEL_CLASS}>{label}</label>
        {description && (
          <div id={descriptionId} className={cn(DESCRIPTION_CLASS, 'mt-0.5')}>{description}</div>
        )}
      </div>
      <div className="relative">
        <Input
          id={id}
          aria-describedby={description ? descriptionId : undefined}
          autoComplete="off"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((previous) => !previous)}
          disabled={disabled}
          aria-label={`${visible ? '隐藏' : '显示'}${label}`}
          aria-pressed={visible}
          title={`${visible ? '隐藏' : '显示'}${label}`}
          className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  )
}
