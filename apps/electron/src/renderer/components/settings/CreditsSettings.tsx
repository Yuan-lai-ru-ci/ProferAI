/**
 * CreditsSettings — 积分与用量页面
 *
 * 显示积分余额、用量统计、按模型分布、请求历史。
 * 统一使用"积分"作为展示单位（与侧栏积分条一致）。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { RefreshCw, Zap, BarChart3, Gift, Clock } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import { SettingsSection, SettingsCard } from './primitives'
import {
  creditsPointsAtom,
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
  creditCycleSummaryAtom,
  isInOverdraftAtom,
  isVipAtom,
  membershipTierAtom,
} from '@/domains/credits/credits-state'
import type { CreditsModelUsage, CreditsUsageLog } from '@/domains/credits/credits-types'
import { claimCreditsDrip, requestCreditsUsage } from '@/domains/credits/credits-api'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'

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
  const lifetimeConsumedPoints = useAtomValue(creditsLifetimeConsumedPointsAtom)
  const loading = useAtomValue(creditsLoadingAtom)
  const isLow = useAtomValue(creditsLowAtom)
  const isExhausted = useAtomValue(creditsExhaustedAtom)
  const [requestLogs, setRequestLogs] = React.useState<CreditsUsageLog[]>([])
  const [modelUsage, setModelUsage] = React.useState<CreditsModelUsage[]>([])
  const [usageLoading, setUsageLoading] = React.useState(true)
  const [usageError, setUsageError] = React.useState(false)
  const [claiming, setClaiming] = React.useState(false)
  const claimRef = React.useRef(false)
  const usageRequest = React.useRef(0)
  // 订阅 + Drip + 分桶
  const subscription = useAtomValue(subscriptionAtom)
  const dripAvailable = useAtomValue(dripAvailablePointsAtom)
  const dripClaimed = useAtomValue(dripClaimedTodayAtom)
  const dripRate = useAtomValue(dailyDripRateAtom)
  const pkgPts = useAtomValue(balancePackagePointsAtom)
  const refPts = useAtomValue(balanceReferralPointsAtom)
  const purPts = useAtomValue(balancePurchasedPointsAtom)
  const cycleSummary = useAtomValue(creditCycleSummaryAtom)
  const isOverdraft = useAtomValue(isInOverdraftAtom)
  const isVip = useAtomValue(isVipAtom)
  const tier = useAtomValue(membershipTierAtom)

  const loadAll = React.useCallback(async () => {
    const request = ++usageRequest.current
    setUsageLoading(true)
    setUsageError(false)
    try {
      const usage = await requestCreditsUsage()
      if (request !== usageRequest.current) return
      if (usage.logs !== undefined) setRequestLogs(usage.logs)
      if (usage.modelUsage !== undefined) setModelUsage(usage.modelUsage)
      setUsageError(usage.logs === undefined || usage.modelUsage === undefined)
    } catch {
      if (request === usageRequest.current) setUsageError(true)
    } finally {
      if (request === usageRequest.current) setUsageLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadAll()
    return () => { usageRequest.current += 1 }
  }, [loadAll])

  // ---- 派生值 ----
  // 分母必须来自服务端按账期汇总，不能混入全历史累计消耗。
  const cycleTotalPoints = cycleSummary ? Math.round(cycleSummary.totalAllocated * 100) / 10 : null
  const remainingPct = cycleTotalPoints && cycleTotalPoints > 0
    ? Math.max(0, Math.min(100, Math.round(((points ?? 0) / cycleTotalPoints) * 100)))
    : 0
  const packagePeriodEndsAt = cycleSummary?.packagePeriodEndsAt
  const cycleEndsLabel = packagePeriodEndsAt
    ? new Date(packagePeriodEndsAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
    : cycleSummary
      ? new Date(cycleSummary.monthEndsAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
      : ''
  const balanceLoaded = points !== null

  const currentTierName = subscription?.hasSubscription ? (subscription.plan || 'free') : (tier || 'free')

  // Drip 领取
  const handleClaimDrip = React.useCallback(async () => {
    if (dripAvailable <= 0 || claimRef.current) return
    claimRef.current = true
    setClaiming(true)
    try {
      const result = await claimCreditsDrip()
      if (!result) {
        toast.info('请先登录团队工作区')
        return
      }
      if (result.claimed) {
        toast.success(result.message)
        await reloadCredits()
      } else {
        toast.info(result.message || '暂无待领取的 drip')
      }
    } catch {
      toast.error('领取失败，请重试')
    } finally {
      claimRef.current = false
      setClaiming(false)
    }
  }, [dripAvailable, reloadCredits])

  return (
    <div className="min-w-0 space-y-8">
      {/* ---- 余额总览卡 ---- */}
      <SettingsSection title="积分概览" description="账户余额与当前结算周期" action={
        <Button variant="outline" size="sm" onClick={() => void Promise.all([reloadCredits(), loadAll()])} disabled={loading || usageLoading}>
          <RefreshCw size={14} className={loading || usageLoading ? 'animate-spin' : ''} />刷新账户
        </Button>
      }>
        <div className="border-y border-border py-5" aria-busy={loading} aria-live="polite">
          <div>
            {/* 订阅状态行 */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground mb-3">
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
                <span>{balanceLoaded ? currentTierName.toUpperCase() : '账户状态待同步'}{isVip && <span className="ml-1 font-medium">（VIP 已激活）</span>}</span>
              )}
            </div>

            {/* 总余额 */}
            <div className="mb-2">
              <div className="text-[10px] text-muted-foreground tracking-wide">总可用额度</div>
              <div className={cn('break-words text-3xl font-semibold leading-tight tabular-nums', isOverdraft && 'text-destructive')}>
                {points === null ? (loading ? '同步中…' : '暂不可用') : fmtPointsNum(points)}
                <span className="text-sm font-normal text-muted-foreground ml-1.5">积分</span>
              </div>
            </div>

            {/* 分桶明细 */}
            {balanceLoaded && <div className="grid grid-cols-3 gap-x-4 gap-y-2 pt-3">
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
            </div>}

            {/* 透支告警 */}
            {isOverdraft && (
              <div className="mt-2 text-xs text-red-500 font-medium">已透支，请尽快充值（上限 -50 积分）</div>
            )}
          </div>
        </div>

        {/* 进度条按当前结算周期计算；历史累计消耗不参与分母。 */}
        {balanceLoaded && (
        <SettingsCard className="mt-3">
          <div className="px-4 py-2 space-y-2.5">
            {cycleSummary && cycleTotalPoints !== null ? (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">本周期剩余</span>
                  <span className="font-semibold tabular-nums">{remainingPct}%</span>
                </div>
                <div className="relative h-2 bg-muted rounded-full">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${isExhausted ? 'bg-destructive' : isLow ? 'bg-yellow-500' : 'bg-primary'}`}
                    style={{ width: `${remainingPct}%` }}
                  />
                </div>
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>剩余 {fmtPointsNum(points ?? 0)} / {fmtPointsNum(cycleTotalPoints)} 积分</span>
                  <span>本周期至 {cycleEndsLabel}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  套餐额度按订阅周期结算；充值和返利余额按月结转。
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">本周期额度汇总暂不可用</div>
            )}
            <div className="pt-0.5 text-[11px] text-muted-foreground tabular-nums">
              历史累计消耗 {fmtPointsNum(lifetimeConsumedPoints ?? 0)} 积分
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
        {!balanceLoaded && !loading && (
          <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>余额未获取，请确认登录状态后重试。</span>
            <Button variant="outline" size="sm" onClick={() => void reloadCredits()}>重试余额</Button>
          </div>
        )}
      </SettingsSection>

      {/* ---- Drip 领取卡（仅活跃订阅显示）---- */}
      {subscription?.status === 'active' && dripRate > 0 && (
        <div className="border-y border-border py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
              <Gift size={20} className="text-green-600" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                本周可领 <span className="text-green-600">{fmtPointsNum(dripAvailable)}</span> 积分
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                本周待领取 · 每日 +{dripRate} 积分 · {dripClaimed ? '今日已领' : '今日未领'} · 未领取额度下周一清零
              </div>
            </div>
          </div>
          <button
            onClick={handleClaimDrip}
            disabled={dripAvailable <= 0 || claiming}
            className={cn(
              'rounded-lg px-5 py-2 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-100',
              dripAvailable > 0
                ? 'bg-green-600 text-white hover:bg-green-700 shadow-sm'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {claiming ? '领取中…' : dripAvailable > 0 ? `领取本周 ${fmtPointsNum(dripAvailable)} 积分` : '暂无待领取额度'}
          </button>
        </div>
      )}

      {/* 按模型用量统计 */}
      <div aria-live="polite" aria-busy={usageLoading} className="text-sm text-muted-foreground">
        {usageLoading && '正在加载用量明细…'}
        {!usageLoading && !usageError && modelUsage.length === 0 && requestLogs.length === 0 && '近 30 天暂无用量记录'}
      </div>
      {usageError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-destructive pl-3 text-sm">
          <span className="text-destructive">部分用量明细无法获取，已保留上次结果。</span>
          <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={usageLoading}>重试用量</Button>
        </div>
      )}
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
                      <div className="flex flex-wrap justify-between gap-1 text-sm mb-1">
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
                  <div key={log.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
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

    </div>
  )
}
