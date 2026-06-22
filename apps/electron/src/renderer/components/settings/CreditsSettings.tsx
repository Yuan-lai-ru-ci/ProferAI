/**
 * CreditsSettings — 额度与用量页面
 *
 * 显示当前余额、累计消耗、进度条、最近交易记录。
 * 仅在商业模式下可见。
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import { RefreshCw, Zap, TrendingDown, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsSection, SettingsCard } from './primitives'
import { creditsBalanceAtom, creditsLifetimeConsumedAtom, creditsLoadingAtom, creditsLowAtom, creditsExhaustedAtom } from '@/atoms/credits-atoms'

interface Transaction {
  id: string
  amount: number
  type: string
  description: string
  created_at: number
}

export function CreditsSettings(): React.ReactElement {
  const [balance, setBalance] = useAtom(creditsBalanceAtom)
  const [lifetimeConsumed, setLifetimeConsumed] = useAtom(creditsLifetimeConsumedAtom)
  const [loading, setLoading] = useAtom(creditsLoadingAtom)
  const isLow = useAtom(creditsLowAtom)[0]
  const isExhausted = useAtom(creditsExhaustedAtom)[0]
  const [transactions, setTransactions] = React.useState<Transaction[]>([])

  const loadCredits = React.useCallback(async () => {
    setLoading(true)
    try {
      const auth = await window.electronAPI.team?.getTeamAuth?.()
      if (!auth) return
      const resp = await fetch(`${auth.baseUrl}/v1/account/credits`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (resp.ok) {
        const data = await resp.json()
        setBalance(data.balance ?? 0)
        setLifetimeConsumed(data.lifetimeConsumed ?? 0)
      }
      const txResp = await fetch(`${auth.baseUrl}/v1/account/credits/transactions?limit=20`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (txResp.ok) {
        const data = await txResp.json()
        setTransactions(data.transactions ?? [])
      }
    } catch {
      // 加载失败静默处理
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { loadCredits() }, [loadCredits])

  const totalGranted = (balance ?? 0) + (lifetimeConsumed ?? 0)
  const pct = totalGranted > 0 ? Math.round(((lifetimeConsumed ?? 0) / totalGranted) * 100) : 0

  return (
    <div className="space-y-8">
      {/* 余额卡片 */}
      <SettingsSection title="额度与用量" description="查看当前额度余额和消耗记录">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className={`
            rounded-xl border p-4
            ${isExhausted ? 'border-destructive/30 bg-destructive/5' : ''}
            ${isLow && !isExhausted ? 'border-yellow-500/30 bg-yellow-500/5' : ''}
            ${!isLow && !isExhausted ? 'border-border bg-card' : ''}
          `}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Zap size={14} />
              当前余额
            </div>
            <div className={`text-2xl font-bold ${isExhausted ? 'text-destructive' : isLow ? 'text-yellow-500' : 'text-foreground'}`}>
              {loading ? '...' : (balance ?? 0).toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground mt-1">credits</div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <TrendingDown size={14} />
              累计消耗
            </div>
            <div className="text-2xl font-bold text-foreground">
              {(lifetimeConsumed ?? 0).toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground mt-1">credits</div>
          </div>
        </div>

        {/* 进度条 */}
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
              <span>总获得: {(totalGranted ?? 0).toLocaleString()}</span>
              <span>剩余: {(balance ?? 0).toLocaleString()}</span>
            </div>
          </div>
        </SettingsCard>

        {isExhausted && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
            额度已耗尽，请联系管理员充值。充值后即可恢复使用。
          </div>
        )}
        {isLow && !isExhausted && (
          <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-600">
            额度偏低，建议尽快联系管理员充值。
          </div>
        )}

        {/* 刷新按钮 */}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={loadCredits} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>刷新</span>
          </Button>
        </div>
      </SettingsSection>

      {/* 最近交易 */}
      <SettingsSection title="最近交易" description="最近 20 笔额度变动记录">
        <SettingsCard>
          {transactions.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">暂无交易记录</div>
          ) : (
            <div className="divide-y divide-border">
              {transactions.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between py-2.5">
                  <div className="flex items-center gap-3">
                    <History size={14} className="text-muted-foreground" />
                    <div>
                      <div className="text-sm">{tx.description || tx.type}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(tx.created_at).toLocaleString('zh-CN')}
                      </div>
                    </div>
                  </div>
                  <div className={`text-sm font-medium ${tx.amount >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    {tx.amount >= 0 ? '+' : ''}{tx.amount.toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
