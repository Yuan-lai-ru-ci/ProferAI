/**
 * CreditsSettings — 积分与用量页面
 *
 * 显示积分余额、用量统计、按模型分布、请求历史。
 * 统一使用"积分"作为展示单位（与侧栏积分条一致）。
 */
import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { RefreshCw, Zap, BarChart3, Gift, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SettingsSection, SettingsCard } from './primitives'
import {
  creditsPointsAtom,
  creditsLifetimeConsumedAtom,
  creditsLifetimeConsumedPointsAtom,
  creditsLoadingAtom,
  creditsLowAtom,
  creditsExhaustedAtom,
  quotaToPoints,
  subscriptionAtom,
  dripAvailablePointsAtom,
  dripClaimedTodayAtom,
  dailyDripRateAtom,
  balancePackagePointsAtom,
  balanceReferralPointsAtom,
  balancePurchasedPointsAtom,
  isInOverdraftAtom,
  isVipAtom,
  membershipTierAtom,
} from '@/atoms/credits-atoms'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'

interface RequestLog {
  id: string; model: string; prompt_tokens: number; completion_tokens: number
  total_tokens: number; cost_credits: number; duration_ms: number
  success: number; stream: number; created_at: number
}

interface ModelUsage {
  model: string; requests: number; total_tokens: number
  prompt_tokens: number; completion_tokens: number; total_cost: number
}

/** 格式化积分（保留最多 1 位小数，用于单次消耗等小数值；小于 0.001 时显示 <0.001） */
function fmtPointsDecimal(n: number): string {
  if (n < 0.001 && n > 0) return '<0.001 积分'
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + ' 积分'
}

/** 格式化积分值（无"积分"后缀，用于卡片大数字） */
function fmtPointsNum(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 })
}

export function CreditsSettings(): React.ReactElement {
  // 余额 / 订阅 / Drip 数据由 useCreditsLoader 统一驱动
  const { reload: reloadCredits } = useCreditsLoader(60_000)
  const points = useAtomValue(creditsPointsAtom)
  const [lifetimeConsumed, setLifetimeConsumed] = useAtom(creditsLifetimeConsumedAtom)
  const lifetimeConsumedPoints = useAtomValue(creditsLifetimeConsumedPointsAtom)
  const [loading, setLoading] = useAtom(creditsLoadingAtom)
  const isLow = useAtomValue(creditsLowAtom)
  const isExhausted = useAtomValue(creditsExhaustedAtom)
  const [requestLogs, setRequestLogs] = React.useState<RequestLog[]>([])
  const [modelUsage, setModelUsage] = React.useState<ModelUsage[]>([])
  // 订阅 + Drip + 分桶
  const subscription = useAtomValue(subscriptionAtom)
  const dripAvailable = useAtomValue(dripAvailablePointsAtom)
  const dripClaimed = useAtomValue(dripClaimedTodayAtom)
  const dripRate = useAtomValue(dailyDripRateAtom)
  const pkgPts = useAtomValue(balancePackagePointsAtom)
  const refPts = useAtomValue(balanceReferralPointsAtom)
  const purPts = useAtomValue(balancePurchasedPointsAtom)
  const isOverdraft = useAtomValue(isInOverdraftAtom)
  const isVip = useAtomValue(isVipAtom)
  const tier = useAtomValue(membershipTierAtom)

  const fetchAuth = React.useCallback(async () => {
    return window.electronAPI.auth.getTeamAuth()
  }, [])

  const loadAll = React.useCallback(async () => {
    setLoading(true)
    try {
      const auth = await fetchAuth()
      if (!auth) return

      // 请求日志（最近30条）
      const rl = await fetch(`${auth.baseUrl}/v1/account/credits/usage?limit=30`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (rl.ok) {
        const d = await rl.json()
        setRequestLogs(d.logs ?? [])
      }

      // 按模型用量统计（近30天）
      const mu = await fetch(`${auth.baseUrl}/v1/account/credits/usage-by-model?days=30`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (mu.ok) {
        const d = await mu.json()
        setModelUsage(d ?? [])
      }
    } catch { /* 静默 */ }
    finally { setLoading(false) }
  }, [fetchAuth])

  React.useEffect(() => { loadAll() }, [loadAll])

  // ---- 派生值 ----
  const totalPoints = (points ?? 0) + (lifetimeConsumedPoints ?? 0)
  const remainingPct = totalPoints > 0 ? Math.round(((points ?? 0) / totalPoints) * 100) : 0
  const balanceLoaded = points !== null

  // 水印色（与 SubscriptionSettings 一致）
  const watermarkColors: Record<string, string> = {
    free: 'text-gray-100 dark:text-gray-800',
    standard: 'text-blue-100 dark:text-blue-950',
    plus: 'text-violet-100 dark:text-violet-950',
    pro: 'text-amber-100 dark:text-amber-950',
  }
  const currentTierName = subscription?.hasSubscription ? (subscription.plan || 'free') : (tier || 'free')
  const watermarkColor = watermarkColors[currentTierName] || watermarkColors.free

  // Drip 领取
  const handleClaimDrip = React.useCallback(async () => {
    try {
      const auth = await window.electronAPI.auth.getTeamAuth()
      if (!auth) return
      const resp = await fetch(`${auth.baseUrl}/v1/account/subscription/claim-drip`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      const d = await resp.json()
      if (d.claimed) {
        toast.success(d.message)
        await reloadCredits()
      } else {
        toast.info(d.message || '暂无待领取的 drip')
      }
    } catch {
      toast.error('领取失败，请重试')
    }
  }, [reloadCredits])

  return (
    <div className="space-y-8">
      {/* ---- 余额总览卡 ---- */}
      <SettingsSection title="积分概览" description="我的账户积分余额，按实际用量实时扣减">
        {/* 富余额卡：tier 水印 + 总额 + 分桶 + 透支 */}
        <div className="relative rounded-xl border border-border bg-card px-5 py-4 overflow-hidden">
          {/* 水印 */}
          <span
            className={cn(
              'absolute top-0 right-0 z-0 select-none pointer-events-none font-black tracking-[0.1em] leading-none',
              watermarkColor,
            )}
            style={{ fontSize: 'clamp(56px, 14vw, 110px)', padding: '0.15em 0.25em 0 0' }}
          >
            {currentTierName.toUpperCase()}
          </span>

          <div className="relative z-10">
            {/* 订阅状态行 */}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
              {subscription?.hasSubscription ? (
                <>
                  <span>{subscription.cycle === 'yearly' ? '年付' : '月付'}</span>
                  {subscription.expiresAt && (
                    <span className="flex items-center gap-1">
                      <Clock size={11} />
                      {subscription.expiresAt > Date.now()
                        ? `${Math.ceil((subscription.expiresAt - Date.now()) / 86400000)} 天后到期`
                        : '已到期'}
                    </span>
                  )}
                  {subscription.isVip && (
                    <span className="font-medium text-rose-600 dark:text-rose-300">VIP</span>
                  )}
                </>
              ) : (
                <span>免费版 · 购买套餐解锁更多能力{isVip && <span className="ml-1 font-medium text-rose-600 dark:text-rose-300">（VIP 已激活）</span>}</span>
              )}
            </div>

            {/* 总余额 */}
            <div className="mb-2">
              <div className="text-[10px] text-muted-foreground tracking-wide">总可用额度</div>
              <div className={cn('text-[34px] font-bold leading-none tracking-tight tabular-nums', isOverdraft && 'text-red-500')}>
                {fmtPointsNum(points ?? 0)}
                <span className="text-sm font-normal text-muted-foreground ml-1.5">积分</span>
              </div>
            </div>

            {/* 分桶明细 */}
            <div className="flex items-center gap-5">
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">套餐积分</div>
                <div className="text-sm font-semibold tabular-nums">{fmtPointsNum(pkgPts)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">返利积分</div>
                <div className="text-sm font-semibold tabular-nums">{fmtPointsNum(refPts)}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground mb-0.5">充值积分</div>
                <div className="text-sm font-semibold tabular-nums">{fmtPointsNum(purPts)}</div>
              </div>
            </div>

            {/* 透支告警 */}
            {isOverdraft && (
              <div className="mt-2 text-xs text-red-500 font-medium">已透支，请尽快充值（上限 -50 积分）</div>
            )}
          </div>
        </div>

        {/* 进度条 + 累计消耗 */}
        {balanceLoaded && (
        <SettingsCard className="mt-3">
          <div className="px-1 py-2 space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">剩余</span>
              <span className="font-semibold tabular-nums">{remainingPct}%</span>
            </div>
            <div className="relative h-2 bg-muted rounded-full">
              <div
                className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${isExhausted ? 'bg-destructive' : isLow ? 'bg-yellow-500' : 'bg-primary'}`}
                style={{ width: `${Math.min(remainingPct, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>剩余 {fmtPointsNum(points ?? 0)} 积分</span>
              <span>累计消耗 {fmtPointsNum(lifetimeConsumedPoints ?? 0)} 积分</span>
            </div>
          </div>
        </SettingsCard>
        )}

        {/* 告警 */}
        {isExhausted && (
          <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive flex items-center gap-2">
            <Zap size={14} /> 积分已耗尽，请联系管理员充值
          </div>
        )}
        {isLow && !isExhausted && (
          <div className="mt-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-600 flex items-center gap-2">
            <Zap size={14} /> 积分偏低，建议尽快联系管理员充值
          </div>
        )}
      </SettingsSection>

      {/* ---- Drip 领取卡（仅活跃订阅显示）---- */}
      {subscription?.status === 'active' && dripRate > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
              <Gift size={20} className="text-green-600" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                本周可领 <span className="text-green-600">{fmtPointsNum(dripAvailable)}</span> 积分
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                每日 +{dripRate} 积分 · {dripClaimed ? '今日已领' : '今日未领'} · 周日清零
              </div>
            </div>
          </div>
          <button
            onClick={handleClaimDrip}
            className={cn(
              'rounded-lg px-5 py-2 text-sm font-medium transition-all',
              dripAvailable > 0
                ? 'bg-green-600 text-white hover:bg-green-700 shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            {dripAvailable > 0 ? `领取 ${fmtPointsNum(dripAvailable)} 积分` : '领取今日积分'}
          </button>
        </div>
      )}

      {/* 按模型用量统计 */}
      {modelUsage.length > 0 && (
        <SettingsSection title="用量分布" description={`近 30 天按模型统计 · 共 ${modelUsage.reduce((s, m) => s + m.requests, 0)} 次请求`}>
          <SettingsCard divided={false}>
            <div className="space-y-1">
              {modelUsage.map((m) => {
                // total_cost 来自服务端是原始 quota，需转换为积分
                const costPoints = quotaToPoints(m.total_cost)
                const maxPoints = Math.max(...modelUsage.map(x => quotaToPoints(x.total_cost)), 0.1)
                const barW = Math.round((costPoints / maxPoints) * 100)
                return (
                  <div key={m.model} className="flex items-center gap-3 py-2 px-2 rounded hover:bg-foreground/[0.02]">
                    <BarChart3 size={14} className="text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium truncate">{m.model}</span>
                        <span className="text-muted-foreground shrink-0 ml-2">{fmtPointsDecimal(costPoints)}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary/60 rounded-full transition-all" style={{ width: `${barW}%` }} />
                      </div>
                      <div className="flex justify-between text-[11px] text-muted-foreground mt-1">
                        <span>{m.requests} 次请求</span>
                        <span>{(m.total_tokens / 1000).toFixed(1)}K tokens</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 请求历史 */}
      {requestLogs.length > 0 && (
        <SettingsSection title="请求历史" description={`最近 ${requestLogs.length} 次 API 请求`}>
          <SettingsCard>
            <div className="divide-y divide-border">
              {requestLogs.map((log) => {
                // cost_credits 来自服务端是原始 quota，需转换为积分
                const costPoints = quotaToPoints(log.cost_credits)
                return (
                  <div key={log.id} className="flex items-center justify-between py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{log.model}</span>
                        {log.stream === 1 && <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">流式</span>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {new Date(log.created_at).toLocaleString('zh-CN')}
                        {' · '}
                        {log.total_tokens > 0
                          ? `${(log.total_tokens / 1000).toFixed(1)}K tokens`
                          : 'tokens 未统计'}
                        {log.duration_ms > 0 && ` · ${(log.duration_ms / 1000).toFixed(1)}s`}
                      </div>
                    </div>
                    <div className="text-sm font-medium text-muted-foreground shrink-0 ml-4">
                      -{fmtPointsDecimal(costPoints)}
                    </div>
                  </div>
                )
              })}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 刷新 */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          <span>刷新</span>
        </Button>
      </div>
    </div>
  )
}
