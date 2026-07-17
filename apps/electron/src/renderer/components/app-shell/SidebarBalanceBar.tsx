/**
 * SidebarBalanceBar — 侧栏底部积分条
 *
 * 仅在代管模式（commercialMode）且已加载到余额时显示。
 * 积分 = 美元余额 × 10，纯展示层换算。
 * 随主题变化：正常态用 primary，低积分用琥珀色，耗尽用 destructive。
 * 点击进入「积分与用量」设置页。
 */
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Coins } from 'lucide-react'
import { cn } from '@/lib/utils'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import {
  creditsPointsAtom,
  creditsLifetimeConsumedAtom,
  creditsLowAtom,
  creditsExhaustedAtom,
  isInOverdraftAtom,
  balancePackagePointsAtom,
  balanceReferralPointsAtom,
  balancePurchasedPointsAtom,
} from '@/atoms/credits-atoms'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'

interface SidebarBalanceBarProps {
  collapsed?: boolean
}

/** 积分显示（保留 1 位小数） */
function formatPoints(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' 积分'
}

export function SidebarBalanceBar({ collapsed = false }: SidebarBalanceBarProps): React.ReactElement | null {
  useCreditsLoader(60_000)

  const points = useAtomValue(creditsPointsAtom)
  const lifetimeConsumed = useAtomValue(creditsLifetimeConsumedAtom)
  const isLow = useAtomValue(creditsLowAtom)
  const isExhausted = useAtomValue(creditsExhaustedAtom)
  const isOverdraft = useAtomValue(isInOverdraftAtom)
  const pkgPts = useAtomValue(balancePackagePointsAtom)
  const refPts = useAtomValue(balanceReferralPointsAtom)
  const purPts = useAtomValue(balancePurchasedPointsAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)

  // 未加载到余额（非代管 / 未登录 / 拉取失败）不显示
  if (points === null) return null

  const openCredits = (): void => {
    setSettingsTab('credits')
    setSettingsOpen(true)
  }

  // 消耗占比（用于进度条）
  const consumed = Math.round(lifetimeConsumed * 100) / 10
  const total = points + consumed
  const consumedPct = total > 0 ? Math.min(100, Math.round((consumed / total) * 100)) : 0
  const remainingPct = 100 - consumedPct

  const tone = isOverdraft
    ? { text: 'text-red-500', bar: 'bg-red-500', track: 'bg-red-500/15', ring: 'border-red-500/30 bg-red-500/5 hover:bg-red-500/10' }
    : isExhausted
      ? { text: 'text-destructive', bar: 'bg-destructive', track: 'bg-destructive/15', ring: 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10' }
      : isLow
        ? { text: 'text-yellow-600 dark:text-yellow-400', bar: 'bg-yellow-500', track: 'bg-yellow-500/15', ring: 'border-yellow-500/30 bg-yellow-500/5 hover:bg-yellow-500/10' }
        : { text: 'text-foreground/80', bar: 'bg-primary', track: 'bg-primary/15', ring: 'border-border bg-foreground/[0.02] hover:bg-foreground/[0.05]' }

  const bucketTooltip = `套餐: ${pkgPts} | 返利: ${refPts} | 充值: ${purPts}`

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openCredits}
        aria-label={`我的积分 ${formatPoints(points)}`}
        title={`我的积分 ${formatPoints(points)}\n${bucketTooltip}${isOverdraft ? '\n已透支！' : isExhausted ? '（已耗尽）' : isLow ? '（偏低）' : ''}`}
        className={cn(
          'w-full flex items-center justify-center py-2 rounded-[10px] border transition-colors titlebar-no-drag',
          tone.ring,
        )}
      >
        <Coins className={cn('size-4', tone.text)} />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={openCredits}
      aria-label={`我的积分 ${formatPoints(points)}，点击查看`}
      title={`我的积分 ${formatPoints(points)}\n${bucketTooltip}${isOverdraft ? '\n已透支！请尽快充值' : ''}`}
      className={cn(
        'w-full flex flex-col gap-1.5 px-3 py-2 rounded-[10px] border transition-colors titlebar-no-drag text-left',
        tone.ring,
      )}
    >
      <div className="flex items-center gap-2">
        <Coins className={cn('size-3.5 shrink-0', tone.text)} />
        <span className="text-[11px] text-foreground/50 flex-1">
          {isOverdraft ? '积分已透支' : isExhausted ? '积分已耗尽' : isLow ? '积分偏低' : '我的积分'}
        </span>
        <span className={cn('text-xs font-semibold tabular-nums', tone.text)}>
          {formatPoints(points)}
        </span>
      </div>
      <div className={cn('h-1 rounded-full overflow-hidden', tone.track)}>
        <div
          className={cn('h-full rounded-full transition-all duration-500', tone.bar)}
          style={{ width: `${Math.max(2, remainingPct)}%` }}
        />
      </div>
    </button>
  )
}
