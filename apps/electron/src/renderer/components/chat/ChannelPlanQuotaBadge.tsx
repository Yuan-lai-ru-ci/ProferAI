import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import type { Channel, ChannelPlanQuotaResult, ChannelPlanQuotaWindow } from '@profer/shared'
import { cn } from '@/lib/utils'
import { supportsChannelPlanQuota } from '@/lib/channel-plan-quota'
import { usePlanQuota } from '@/hooks/use-plan-quota'

function formatWindow(window: ChannelPlanQuotaWindow): string {
  const label = window.type === '5h'
    ? '5H'
    : window.type === 'weekly'
      ? '周'
      : window.label.replace(/\s+/g, '')
  return `${label} ${window.remainingLabel ?? `${window.remainingPercent}%`}`
}

function buildSummary(result: ChannelPlanQuotaResult): string {
  const fiveHour = result.windows.find((window) => window.type === '5h')
  const weekly = result.windows.find((window) => window.type === 'weekly')
  const custom = result.windows.find((window) => window.type === 'custom')
  const primary = [fiveHour, weekly].filter(Boolean) as ChannelPlanQuotaWindow[]
  const windows = primary.length > 0 ? primary : result.windows.slice(0, 2)
  if (windows.length === 0 && custom) return formatWindow(custom)
  return windows.map(formatWindow).join(' · ')
}

function buildTitle(result: ChannelPlanQuotaResult): string {
  if (!result.supported) return result.message ?? '订阅额度不可用'
  const detail = result.windows.map((window) => {
    const reset = window.resetAt
      ? `，重置 ${new Intl.DateTimeFormat(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(window.resetAt))}`
      : ''
    return `${window.label}: 剩余 ${window.remainingLabel ?? `${window.remainingPercent}%`}${reset}`
  }).join('\n')
  return `${result.planName ?? '订阅额度'}\n${detail}`
}

/**
 * ChannelPlanQuotaBadge — 模型选择器里的渠道订阅额度徽章
 *
 * 手动刷新入口（方案 A+B 结合）：
 * - 空闲未悬停：只显示额度摘要。
 * - 空闲悬停：右侧浮现刷新图标。
 * - 刷新中：图标持续显示并转圈（不随鼠标移开消失）；重复点击由数据层 in-flight 锁兜底，刷新结束恢复「仅悬停显示」。
 * - 数据与刷新状态与上下文 Popover 共享（usePlanQuota + planQuotaStateAtomFamily），一处刷新各处同步转圈。
 */
export function ChannelPlanQuotaBadge({ channel }: { channel: Channel }): React.ReactElement | null {
  const { quota, refreshing, refresh } = usePlanQuota(channel.id)
  const [hovered, setHovered] = React.useState(false)

  if (!supportsChannelPlanQuota(channel)) return null

  const isUsable = quota?.supported && quota.windows.length > 0
  // 有可用摘要或正在刷新时才渲染徽章（刷新中至少展示转圈，避免闪烁消失）。
  if (!isUsable && !refreshing) return null

  const summary = isUsable ? buildSummary(quota) : undefined
  const title = quota ? buildTitle(quota) : undefined

  return (
    <span
      title={title}
      className={cn(
        'ml-auto inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] leading-none',
        isUsable
          ? 'border-foreground/10 bg-background/70 text-foreground/70'
          : 'border-transparent bg-transparent text-muted-foreground/50',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {summary}
      {refreshing ? (
        <RefreshCw className="size-2.5 animate-spin" aria-label="刷新中" />
      ) : hovered ? (
        <button
          type="button"
          title="刷新额度"
          aria-label="刷新额度"
          className="inline-flex cursor-pointer items-center text-current"
          onClick={(event) => {
            event.stopPropagation()
            refresh()
          }}
        >
          <RefreshCw className="size-2.5" />
        </button>
      ) : null}
    </span>
  )
}
