/**
 * CreditsSettings — 额度与用量页面
 *
 * 显示余额、用量统计、按模型分布、请求历史。
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import { RefreshCw, Zap, TrendingDown, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard } from './primitives'
import { creditsBalanceAtom, creditsLifetimeConsumedAtom, creditsLoadingAtom, creditsLowAtom, creditsExhaustedAtom } from '@/atoms/credits-atoms'

interface RequestLog {
  id: string; model: string; prompt_tokens: number; completion_tokens: number
  total_tokens: number; cost_credits: number; duration_ms: number
  success: number; stream: number; created_at: number
}

interface ModelUsage {
  model: string; requests: number; total_tokens: number
  prompt_tokens: number; completion_tokens: number; total_cost: number
}

export function CreditsSettings(): React.ReactElement {
  const [balance, setBalance] = useAtom(creditsBalanceAtom)
  const [lifetimeConsumed, setLifetimeConsumed] = useAtom(creditsLifetimeConsumedAtom)
  const [loading, setLoading] = useAtom(creditsLoadingAtom)
  const isLow = useAtom(creditsLowAtom)[0]
  const isExhausted = useAtom(creditsExhaustedAtom)[0]
  const [requestLogs, setRequestLogs] = React.useState<RequestLog[]>([])
  const [modelUsage, setModelUsage] = React.useState<ModelUsage[]>([])

  const fetchAuth = React.useCallback(async () => {
    return window.electronAPI.auth.getTeamAuth()
  }, [])

  const loadAll = React.useCallback(async () => {
    setLoading(true)
    try {
      const auth = await fetchAuth()
      if (!auth) return

      // 余额（当前用户本地账本，balance 可能为 null）
      const cr = await fetch(`${auth.baseUrl}/v1/account/credits`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (cr.ok) {
        const d = await cr.json()
        setBalance(d.balance ?? null)
        setLifetimeConsumed(d.lifetimeConsumed ?? 0)
      }

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

  const totalGranted = (balance ?? 0) + (lifetimeConsumed ?? 0)
  const pct = totalGranted > 0 ? Math.round(((lifetimeConsumed ?? 0) / totalGranted) * 100) : 0
  const fmt = (n: number): string => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  const balanceLoaded = balance !== null

  return (
    <div className="space-y-8">
      {/* 余额卡片 */}
      <SettingsSection title="额度概览" description="我的账户余额，按实际用量实时扣减">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className={`
            rounded-xl border p-4
            ${isExhausted ? 'border-destructive/30 bg-destructive/5' : ''}
            ${isLow && !isExhausted ? 'border-yellow-500/30 bg-yellow-500/5' : ''}
            ${!isLow && !isExhausted ? 'border-border bg-card' : ''}
          `}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Zap size={14} /> 我的剩余额度
            </div>
            <div className={`text-2xl font-bold ${isExhausted ? 'text-destructive' : isLow ? 'text-yellow-500' : 'text-foreground'}`}>
              {loading ? '...' : balanceLoaded ? fmt(balance!) : '--'}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{balanceLoaded ? '账户余额' : '未配置余额查询'}</div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <TrendingDown size={14} /> 累计消耗
            </div>
            <div className="text-2xl font-bold text-foreground">
              {fmt(lifetimeConsumed ?? 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-1">历史用量</div>
          </div>
        </div>
        {balanceLoaded && (
        <SettingsCard>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">已使用</span>
              <span className="font-medium">{pct}%</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${isExhausted ? 'bg-destructive' : isLow ? 'bg-yellow-500' : 'bg-primary'}`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>总额度: {fmt(totalGranted ?? 0)}</span>
              <span>剩余: {fmt(balance ?? 0)}</span>
            </div>
          </div>
        </SettingsCard>
        )}
        {isExhausted && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
            余额已耗尽，请联系管理员充值。
          </div>
        )}
        {isLow && !isExhausted && (
          <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-600">
            余额偏低，建议尽快联系管理员充值。
          </div>
        )}
      </SettingsSection>

      {/* 按模型用量统计 */}
      {modelUsage.length > 0 && (
        <SettingsSection title="用量分布" description={`近 30 天按模型统计 · 共 ${modelUsage.reduce((s, m) => s + m.requests, 0)} 次请求`}>
          <SettingsCard divided={false}>
            <div className="space-y-1">
              {modelUsage.map((m) => {
                const maxCost = Math.max(...modelUsage.map(x => x.total_cost), 1)
                const barW = Math.round((m.total_cost / maxCost) * 100)
                return (
                  <div key={m.model} className="flex items-center gap-3 py-2 px-2 rounded hover:bg-foreground/[0.02]">
                    <BarChart3 size={14} className="text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium truncate">{m.model}</span>
                        <span className="text-muted-foreground shrink-0 ml-2">{m.total_cost.toLocaleString()} cr</span>
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
              {requestLogs.map((log) => (
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
                    -{log.cost_credits.toLocaleString()}
                  </div>
                </div>
              ))}
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
