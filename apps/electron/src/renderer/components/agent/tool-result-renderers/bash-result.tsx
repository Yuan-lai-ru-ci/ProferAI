/**
 * Bash 工具结果渲染器 — 终端风格
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
    const lines = text.split('\n')
    return (
      <div className={cn(
        'rounded-md font-mono text-[12px] leading-relaxed overflow-x-auto',
        'bg-code text-code-foreground border border-surface-border/60',
        'p-3',
      )}>
        {/* 命令回显 */}
        {command && (
          <div className="mb-2 select-none text-muted-foreground">
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
