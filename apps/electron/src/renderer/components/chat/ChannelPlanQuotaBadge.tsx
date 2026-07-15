import * as React from 'react'
import type { Channel, ChannelPlanQuotaResult, ChannelPlanQuotaWindow } from '@proma/shared'
import { cn } from '@/lib/utils'
import { supportsChannelPlanQuota } from '@/lib/channel-plan-quota'

const PLAN_QUOTA_CACHE_MS = 60 * 1000
const PLAN_QUOTA_ERROR_CACHE_MS = 15 * 1000

const quotaCache = new Map<string, ChannelPlanQuotaResult>()

function getCacheTtl(result: ChannelPlanQuotaResult): number {
  return result.supported ? PLAN_QUOTA_CACHE_MS : PLAN_QUOTA_ERROR_CACHE_MS
}

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

export function ChannelPlanQuotaBadge({ channel }: { channel: Channel }): React.ReactElement | null {
  const [quota, setQuota] = React.useState<ChannelPlanQuotaResult | null>(() => quotaCache.get(channel.id) ?? null)

  React.useEffect(() => {
    if (!supportsChannelPlanQuota(channel)) return

    const cached = quotaCache.get(channel.id)
    if (cached && Date.now() - cached.updatedAt < getCacheTtl(cached)) {
      setQuota(cached)
      return
    }

    let cancelled = false
    window.electronAPI.getChannelPlanQuota(channel.id)
      .then((result) => {
        if (cancelled) return
        quotaCache.set(channel.id, result)
        setQuota(result)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const result: ChannelPlanQuotaResult = {
          supported: false,
          provider: channel.provider,
          windows: [],
          updatedAt: Date.now(),
          message: error instanceof Error ? error.message : '订阅额度查询失败',
        }
        quotaCache.set(channel.id, result)
        setQuota(result)
      })

    return () => {
      cancelled = true
    }
  }, [channel])

  if (!supportsChannelPlanQuota(channel)) return null

  const isUsable = quota?.supported && quota.windows.length > 0
  if (!isUsable) return null

  const summary = buildSummary(quota)
  const title = quota ? buildTitle(quota) : '正在读取订阅额度'

  return (
    <span
      title={title}
      className={cn(
        'ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none',
        isUsable
          ? 'border-foreground/10 bg-background/70 text-foreground/70'
          : 'border-transparent bg-transparent text-muted-foreground/50',
      )}
    >
      {summary}
    </span>
  )
}
