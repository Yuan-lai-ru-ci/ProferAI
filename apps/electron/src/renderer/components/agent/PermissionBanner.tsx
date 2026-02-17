/**
 * PermissionBanner — Agent 权限请求横幅
 *
 * 内联在 Agent 对话流底部，当有待处理的权限请求时显示。
 * 显示工具名、命令内容、危险等级，提供允许/拒绝/总是允许操作。
 * 支持队列模式：多个并发请求按 FIFO 逐个展示。
 *
 * 设计参考 Craft Agents OSS 的内联权限 UI。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Shield, ShieldAlert, Check, X, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { pendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import type { DangerLevel } from '@proma/shared'

/** 危险等级对应的样式 */
const DANGER_STYLES: Record<DangerLevel, { border: string; icon: string; bg: string }> = {
  safe: {
    border: 'border-green-500/30',
    icon: 'text-green-500',
    bg: 'bg-green-500/5',
  },
  normal: {
    border: 'border-primary/20',
    icon: 'text-primary',
    bg: 'bg-primary/5',
  },
  dangerous: {
    border: 'border-amber-500/40',
    icon: 'text-amber-500',
    bg: 'bg-amber-500/5',
  },
}

export function PermissionBanner(): React.ReactElement | null {
  const [requests, setRequests] = useAtom(pendingPermissionRequestsAtom)
  const [showAlwaysAllow, setShowAlwaysAllow] = React.useState(false)
  const [responding, setResponding] = React.useState(false)

  // 展示队列中的第一个请求
  const request = requests[0] ?? null

  // 当请求变化时重置"总是允许"展开状态
  React.useEffect(() => {
    setShowAlwaysAllow(false)
  }, [request?.requestId])

  if (!request) return null

  const styles = DANGER_STYLES[request.dangerLevel]
  const isDangerous = request.dangerLevel === 'dangerous'
  const IconComponent = isDangerous ? ShieldAlert : Shield

  /** 响应权限请求 */
  const respond = async (behavior: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (responding) return
    setResponding(true)

    try {
      await window.electronAPI.respondPermission({
        requestId: request.requestId,
        behavior,
        alwaysAllow,
      })
      // 移除已响应的请求（FIFO 出队）
      setRequests((prev) => prev.filter((r) => r.requestId !== request.requestId))
    } catch (error) {
      console.error('[PermissionBanner] 响应失败:', error)
    } finally {
      setResponding(false)
    }
  }

  return (
    <div
      className={`mx-4 mb-3 rounded-lg border ${styles.border} ${styles.bg} overflow-hidden animate-in slide-in-from-bottom-2 duration-200`}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <IconComponent className={`size-4 ${styles.icon}`} />
          <span className="text-sm font-medium">
            {isDangerous ? '危险操作需要确认' : '需要确认'}
          </span>
          {requests.length > 1 && (
            <span className="text-xs text-muted-foreground">
              (+{requests.length - 1})
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground font-mono">
          {request.toolName}
        </span>
      </div>

      {/* 命令/操作内容 */}
      <div className="px-3 pb-2">
        {request.command ? (
          <pre className="text-xs font-mono bg-background/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
            {request.command}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">
            {request.description}
          </p>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center justify-end gap-1.5 px-3 pb-2.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => respond('deny')}
          disabled={responding}
          className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
        >
          <X className="size-3 mr-1" />
          拒绝
        </Button>

        {/* 总是允许（折叠，避免误触） */}
        {showAlwaysAllow ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => respond('allow', true)}
            disabled={responding}
            className="h-7 px-3 text-xs"
          >
            本次会话总是允许
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAlwaysAllow(true)}
            disabled={responding}
            className="h-7 px-1 text-xs text-muted-foreground"
          >
            <ChevronDown className="size-3" />
          </Button>
        )}

        <Button
          variant="default"
          size="sm"
          onClick={() => respond('allow')}
          disabled={responding}
          className="h-7 px-3 text-xs"
        >
          <Check className="size-3 mr-1" />
          允许
        </Button>
      </div>
    </div>
  )
}
