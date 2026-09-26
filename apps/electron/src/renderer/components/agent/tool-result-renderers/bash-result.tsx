/**
 * 命令类工具（Bash / PowerShell）结果渲染器 — 终端风格
 *
 * 深色背景、等宽字体、stderr 红色高亮
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CollapsibleResult } from './collapsible-result'

interface BashResultRendererProps {
  result: string
  isError: boolean
  input: Record<string, unknown>
}

/** 简单检测 stderr 行（常见模式） */
function classifyLine(line: string): 'stderr' | 'normal' {
  const lower = line.toLowerCase()
  if (
    lower.startsWith('error:') ||
    lower.startsWith('error ') ||
    lower.startsWith('fatal:') ||
    lower.startsWith('warning:') ||
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.startsWith('stderr:')
  ) {
    return 'stderr'
  }
  return 'normal'
}

export function BashResultRenderer({ result, isError, input }: BashResultRendererProps): React.ReactElement {
  const command = typeof input.command === 'string' ? input.command : undefined

  const renderTerminal = React.useCallback((text: string): React.ReactNode => {
    // Windows 命令（尤其 PowerShell）输出常为 CRLF；按 \n 切会残留行尾 \r，
    // 在 white-space: pre-wrap 下会被当作换行符而多出空行。
    const lines = text.split(/\r?\n/)
    return (
      <div className={cn(
        'rounded-md font-mono text-[12px] leading-relaxed overflow-x-auto',
        'bg-code text-code-foreground border border-surface-border/60',
        'p-3',
      )}>
        {/* 命令回显 */}
        {command && (
          <div className="mb-2 select-none whitespace-pre-wrap break-all text-muted-foreground">
            <span className="text-success">$</span> {command}
          </div>
        )}
        {/* 输出行 */}
        {lines.map((line, i) => {
          const type = isError ? 'stderr' : classifyLine(line)
          return (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-all min-h-[1.25em]',
                type === 'stderr' && 'text-destructive',
              )}
            >
              {line || '\u200B'}
            </div>
          )
        })}
      </div>
    )
  }, [command, isError])

  return (
    <CollapsibleResult
      content={result}
      renderContent={renderTerminal}
    />
  )
}
