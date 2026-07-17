/**
 * SubscriptionSettings — 套餐订阅页
 *
 * 新定价方案（2026-07-15 定稿）：
 *   Free → Standard(¥29) → Plus(¥49) → Pro(¥99) + VIP 叠加(¥698 终身)
 *   年付 = 月费×12×0.85，红包×12 一次性到账
 *   Drip 领取制：每日累加到可领池，周日清零
 *
 * 手动收款期：订阅按钮 = 复制微信号联系管理员开通。在线支付后续接入。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Check, Copy, Users, Zap, Gift, Crown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  inviteCodeAtom,
} from '@/atoms/credits-atoms'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'

/** 联系管理员微信号 */
const ADMIN_WECHAT = 'CYBER_YLRC'

/** 套餐定义 */
interface PlanDef {
  id: string
  name: string
  monthlyRmb: number
  yearlyRmb: number
  welcomeBonus: number
  dailyDrip: number
  features: string[]
  featured?: boolean
}

const PLANS: PlanDef[] = [
  {
    id: 'free', name: 'Free', monthlyRmb: 0, yearlyRmb: 0,
    welcomeBonus: 0, dailyDrip: 0,
    features: ['50 积分/月试用', '国内模型（DeepSeek / 通义千问）', 'Agent / Skill / MCP / 自动化全开'],
  },
  {
    id: 'standard', name: 'Standard', monthlyRmb: 29, yearlyRmb: 296,
    welcomeBonus: 60, dailyDrip: 8,
    features: ['首购红包 60 积分', '每日 drip 8 积分', '国内模型（DeepSeek / 通义千问）', 'Agent / Skill / MCP / 自动化全开'],
  },
  {
    id: 'plus', name: 'Plus', monthlyRmb: 49, yearlyRmb: 500,
    welcomeBonus: 200, dailyDrip: 20,
    features: ['首购红包 200 积分', '每日 drip 20 积分', '国际模型（Claude / GPT / Gemini）', 'Agent / Skill / MCP / 自动化全开'],
    featured: true,
  },
  {
    id: 'pro', name: 'Pro', monthlyRmb: 99, yearlyRmb: 1010,
    welcomeBonus: 450, dailyDrip: 40,
    features: ['首购红包 450 积分', '每日 drip 40 积分', '全部模型 + 自配 API Key', 'Agent / Skill / MCP / 自动化全开'],
  },
]

/** VIP 详情 */
const VIP_PRICE = 698
const VIP_FEATURES = [
  '终身买断，一次付费永久有效',
  '模型消耗 0.8x 倍率（八折）',
  '套餐购买 9 折',
  '每日额外 +20 drip',
  '需另购套餐（VIP 不替代套餐）',
]

/** 兑换码输入组件 */
function RedeemInput(): React.ReactElement {
  const [code, setCode] = React.useState('')
  const [loading, setLoading] = React.useState(false)

  const handleRedeem = React.useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed) {
      toast.error('请输入兑换码')
      return
    }
    setLoading(true)
    try {
      const auth = await window.electronAPI.auth.getTeamAuth()
      if (!auth) {
        toast.error('未登录，请先登录')
        return
      }
      const resp = await fetch(`${auth.baseUrl}/v1/account/redeem`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ code: trimmed }),
      })
      const d = await resp.json()
      if (!resp.ok) {
        toast.error(d.error || '兑换失败')
        return
      }
      toast.success(d.description || '兑换成功！')
      setCode('')
    } catch {
      toast.error('兑换失败，请检查网络后重试')
    } finally {
      setLoading(false)
    }
  }, [code])

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleRedeem() }}
        placeholder="输入兑换码"
        className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
        disabled={loading}
      />
      <button
        onClick={handleRedeem}
        disabled={loading || !code.trim()}
        className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? '兑换中...' : '兑换'}
      </button>
    </div>
  )
}

export function SubscriptionSettings(): React.ReactElement {
  useCreditsLoader(60_000)
  const inviteCode = useAtomValue(inviteCodeAtom)

  const copyWechat = React.useCallback(async (note?: string) => {
    try {
      await navigator.clipboard.writeText(ADMIN_WECHAT)
      toast.success(`已复制微信号 ${ADMIN_WECHAT}${note ? `，备注「${note}」` : ''}`)
    } catch {
      toast.error('复制失败，请手动复制微信号 ' + ADMIN_WECHAT)
    }
  }, [])

  const handleSubscribe = React.useCallback((plan: PlanDef, cycle: 'monthly' | 'yearly') => {
    const price = cycle === 'yearly' ? plan.yearlyRmb : plan.monthlyRmb
    void copyWechat(`${plan.name} ${cycle === 'yearly' ? '年付' : '月付'} ¥${price}`)
  }, [copyWechat])

  const handleBuyVip = React.useCallback(() => {
    void copyWechat(`VIP 终身 ¥${VIP_PRICE}`)
  }, [copyWechat])

  return (
    <div className="space-y-5">
      {/* ---- 四档定价卡 ---- */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Zap size={16} className="text-primary" />
          <h3 className="text-sm font-semibold">选择套餐</h3>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={cn(
                'rounded-xl border p-4 flex flex-col',
                plan.featured
                  ? 'bg-primary text-primary-foreground border-primary shadow-lg'
                  : 'bg-card border-border',
              )}
            >
              <div className="mb-2">
                <div className="text-base font-bold">{plan.name}</div>
                {plan.id !== 'free' && (
                  <div className={cn('text-[11px]', plan.featured ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                    红包 {plan.welcomeBonus} · 日领 {plan.dailyDrip} 积分
                  </div>
                )}
              </div>
              {plan.id === 'free' ? (
                <div className="mb-3">
                  <span className="text-2xl font-bold">免费</span>
                </div>
              ) : (
                <div className="mb-1">
                  <span className="text-2xl font-bold">¥{plan.monthlyRmb}</span>
                  <span className={cn('text-xs ml-1', plan.featured ? 'text-primary-foreground/70' : 'text-muted-foreground')}>/月</span>
                </div>
              )}
              {plan.id !== 'free' && (
                <div className={cn('text-[11px] mb-3', plan.featured ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                  年付 ¥{plan.yearlyRmb}/年（85 折）
                </div>
              )}
              {plan.id === 'free' && <div className="mb-3" />}

              <ul className="space-y-1.5 mb-4 flex-1">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-1.5 text-xs">
                    <Check size={12} className={cn('mt-0.5 shrink-0', plan.featured ? 'text-primary-foreground' : 'text-primary')} />
                    <span className={plan.featured ? 'text-primary-foreground/90' : 'text-foreground/75'}>{feat}</span>
                  </li>
                ))}
              </ul>

              {plan.id !== 'free' && (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => handleSubscribe(plan, 'monthly')}
                    className={cn(
                      'w-full rounded-lg py-2 text-xs font-medium transition-colors',
                      plan.featured
                        ? 'bg-primary-foreground text-primary hover:bg-primary-foreground/90'
                        : 'bg-muted text-foreground hover:bg-muted/70',
                    )}
                  >
                    月付 · ¥{plan.monthlyRmb}
                  </button>
                  <button
                    onClick={() => handleSubscribe(plan, 'yearly')}
                    className={cn(
                      'w-full rounded-lg py-2 text-xs font-medium transition-colors',
                      plan.featured
                        ? 'bg-primary-foreground/85 text-primary hover:bg-primary-foreground'
                        : 'bg-muted/70 text-muted-foreground hover:bg-muted',
                    )}
                  >
                    年付 · ¥{plan.yearlyRmb}（85折）
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ---- VIP 叠加层 ---- */}
      <div className="rounded-xl border border-yellow-400/40 bg-yellow-50/30 dark:bg-yellow-950/10 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Crown size={18} className="text-yellow-600" />
              <span className="text-base font-bold">VIP 终身会员</span>
              <span className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">¥{VIP_PRICE}</span>
            </div>
            <ul className="space-y-1">
              {VIP_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-1.5 text-xs text-foreground/70">
                  <Check size={12} className="mt-0.5 shrink-0 text-yellow-600" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
          <button
            onClick={handleBuyVip}
            className="shrink-0 rounded-lg bg-yellow-600 text-white px-5 py-2 text-sm font-medium hover:bg-yellow-700 transition-colors"
          >
            购买 VIP
          </button>
        </div>
      </div>

      {/* ---- 兑换码 ---- */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Gift size={16} className="text-primary" />
          <h3 className="text-sm font-semibold">兑换码</h3>
          <span className="text-[11px] text-muted-foreground">输入管理员发放的兑换码</span>
        </div>
        <RedeemInput />
      </div>

      {/* ---- 团队版 banner ---- */}
      <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
            <Users size={18} className="text-green-600" />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">Profer 团队版</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              团队额度共享，联系微信号 {ADMIN_WECHAT} 开通
            </div>
          </div>
        </div>
        <button
          onClick={() => void copyWechat()}
          className="shrink-0 rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Copy size={15} />
        </button>
      </div>

      {/* ---- 邀请码 ---- */}
      {inviteCode && (
        <div className="rounded-xl border border-border bg-muted/20 p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-muted-foreground" />
            <span className="text-sm">你的邀请码：<span className="font-mono font-bold">{inviteCode}</span></span>
          </div>
          <button
            onClick={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(inviteCode)
                  toast.success('已复制邀请码')
                } catch {
                  toast.error('复制失败')
                }
              })()
            }}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            <Copy size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
