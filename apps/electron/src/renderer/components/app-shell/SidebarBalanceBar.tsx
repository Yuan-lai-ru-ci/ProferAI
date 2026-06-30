/**
 * SidebarBalanceBar — 侧栏底部余额条
 *
 * 仅在代管模式（commercialMode）且已加载到余额时显示。
 * 随主题变化：正常态用 primary，低额度用琥珀色，耗尽用 destructive。
 * 点击进入「额度与用量」设置页。
 */
import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import {
  creditsBalanceAtom,
  creditsLifetimeConsumedAtom,
  creditsLowAtom,
  creditsExhaustedAtom,
} from '@/atoms/credits-atoms'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'

interface SidebarBalanceBarProps {
  /** 侧栏是否折叠 */
  collapsed?: boolean
}

/** 余额显示：货币单位，保留 2 位小数（去掉无意义的末尾 0） */
function formatBalance(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export function SidebarBalanceBar({ collapsed = false }: SidebarBalanceBarProps): React.ReactElement | null {
  // 登录后加载 + 60s 轮询；非代管模式下 loader 会把余额置 null
  useCreditsLoader(60_000)

  const balance = useAtomValue(creditsBalanceAtom)
  const lifetimeConsumed = useAtomValue(creditsLifetimeConsumedAtom)
  const isLow = useAtomValue(creditsLowAtom)
  const isExhausted = useAtomValue(creditsExhaustedAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)

  // 未加载到余额（非代管 / 未登录 / 拉取失败）不显示
  if (balance === null) return null

  const openCredits = (): void => {
    setSettingsTab('credits')
    setSettingsOpen(true)
  }

  // 消耗占比（用于进度条）：consumed / (balance + consumed)
  const total = balance + lifetimeConsumed
  const consumedPct = total > 0 ? Math.min(100, Math.round((lifetimeConsumed / total) * 100)) : 0
  const remainingPct = 100 - consumedPct

  // 主题感知配色
  const tone = isExhausted
    ? { text: 'text-destructive', bar: 'bg-destructive', track: 'bg-destructive/15', ring: 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10' }
    : isLow
      ? { text: 'text-yellow-600 dark:text-yellow-400', bar: 'bg-yellow-500', track: 'bg-yellow-500/15', ring: 'border-yellow-500/30 bg-yellow-500/5 hover:bg-yellow-500/10' }
      : { text: 'text-foreground/80', bar: 'bg-primary', track: 'bg-primary/15', ring: 'border-border bg-foreground/[0.02] hover:bg-foreground/[0.05]' }

  // 折叠态：只显示一个带颜色的小钱包图标，点击进充值
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={openCredits}
        aria-label={`平台额度 ${formatBalance(balance)}`}
        title={`平台共享额度 ${formatBalance(balance)}${isExhausted ? '（已耗尽）' : isLow ? '（偏低）' : ''}`}
        className={cn(
          'w-full flex items-center justify-center py-2 rounded-[10px] border transition-colors titlebar-no-drag',
          tone.ring,
        )}
      >
        <Wallet className={cn('size-4', tone.text)} />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={openCredits}
      aria-label={`平台共享额度 ${formatBalance(balance)}，点击查看`}
      title={`平台共享额度 ${formatBalance(balance)}`}
      className={cn(
        'w-full flex flex-col gap-1.5 px-3 py-2 rounded-[10px] border transition-colors titlebar-no-drag text-left',
        tone.ring,
      )}
    >
      <div className="flex items-center gap-2">
        <Wallet className={cn('size-3.5 shrink-0', tone.text)} />
        <span className="text-[11px] text-foreground/50 flex-1">
          {isExhausted ? '平台额度已耗尽' : isLow ? '平台额度偏低' : '平台额度'}
        </span>
        <span className={cn('text-xs font-semibold tabular-nums', tone.text)}>
          {formatBalance(balance)}
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
