/**
 * SubscriptionSettings — 套餐订阅页
 *
 * 定价从服务端 /v1/account/config/plans 动态获取，Admin 操控面板可实时调整。
 * 加载失败时回退到硬编码默认值。
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

/** 联系管理员微信号（默认值，从 API 动态获取） */
const ADMIN_WECHAT_DEFAULT = 'CYBER_YLRC'

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

/** 硬编码兜底套餐（API 加载失败时使用） */
const PLANS_FALLBACK: PlanDef[] = [
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

/** VIP 兜底值 */
const VIP_PRICE_DEFAULT = 698
const VIP_DISCOUNT_DEFAULT = 0.9
const VIP_EXTRA_DRIP_DEFAULT = 20

interface PricingData {
  plans: Record<'standard' | 'plus' | 'pro', { id: string; name: string; monthlyRmb: number; yearlyRmb: number; welcomeBonus: number; dailyDrip: number }>
  vip: { price: number; discount: number; extraDrip: number }
  adminWechat: string
}

/** 从 API 获取定价数据，失败时返回 null（由调用方回退默认值） */
async function fetchPricing(): Promise<PricingData | null> {
  try {
    const auth = await window.electronAPI.auth.getTeamAuth()
    if (!auth) return null
    const resp = await fetch(`${auth.baseUrl}/v1/account/config/plans`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

/** 将 API 返回的分值价格转换为元（API 返回人民币分） */
function rmbToYuan(fen: number): number {
  return Math.round(fen / 100)
}

/** 从 API 数据构建 PLAN_DEF 数组，features 从兜底值合并 */
function buildPlans(data: PricingData): PlanDef[] {
  const apiPlans = data.plans
  const standard = apiPlans.standard
  const plus = apiPlans.plus
  const pro = apiPlans.pro
  return [
    {
      id: 'free', name: 'Free', monthlyRmb: 0, yearlyRmb: 0,
      welcomeBonus: 0, dailyDrip: 0,
      features: PLANS_FALLBACK[0]!.features,
    },
    {
      id: 'standard', name: 'Standard',
      monthlyRmb: rmbToYuan(standard.monthlyRmb),
      yearlyRmb: rmbToYuan(standard.yearlyRmb),
      welcomeBonus: standard.welcomeBonus,
      dailyDrip: standard.dailyDrip,
      features: PLANS_FALLBACK[1]!.features,
    },
    {
      id: 'plus', name: 'Plus',
      monthlyRmb: rmbToYuan(plus.monthlyRmb),
      yearlyRmb: rmbToYuan(plus.yearlyRmb),
      welcomeBonus: plus.welcomeBonus,
      dailyDrip: plus.dailyDrip,
      features: PLANS_FALLBACK[2]!.features,
      featured: true,
    },
    {
      id: 'pro', name: 'Pro',
      monthlyRmb: rmbToYuan(pro.monthlyRmb),
      yearlyRmb: rmbToYuan(pro.yearlyRmb),
      welcomeBonus: pro.welcomeBonus,
      dailyDrip: pro.dailyDrip,
      features: PLANS_FALLBACK[3]!.features,
    },
  ]
}

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

  const [plans, setPlans] = React.useState<PlanDef[]>(PLANS_FALLBACK)
  const [vipPrice, setVipPrice] = React.useState(VIP_PRICE_DEFAULT)
  const [vipDiscount, setVipDiscount] = React.useState(VIP_DISCOUNT_DEFAULT)
  const [vipExtraDrip, setVipExtraDrip] = React.useState(VIP_EXTRA_DRIP_DEFAULT)
  const [adminWechat, setAdminWechat] = React.useState(ADMIN_WECHAT_DEFAULT)
  const [pricingLoaded, setPricingLoaded] = React.useState(false)

  // 加载服务端定价
  React.useEffect(() => {
    let cancelled = false
    fetchPricing().then((data) => {
      if (cancelled || !data) return
      setPlans(buildPlans(data))
      setVipPrice(rmbToYuan(data.vip.price))
      setVipDiscount(data.vip.discount)
      setVipExtraDrip(data.vip.extraDrip)
      if (data.adminWechat) setAdminWechat(data.adminWechat)
      setPricingLoaded(true)
    }).catch(() => {
      if (!cancelled) setPricingLoaded(true) // 用兜底值
    })
    return () => { cancelled = true }
  }, [])

  const vipFeatures = React.useMemo(() => [
    '终身买断，一次付费永久有效',
    `模型消耗 ${(1 / 0.8).toFixed(1)}x 倍率（八折）`,
    `套餐购买 ${Math.round(vipDiscount * 100)} 折`,
    `每日额外 +${vipExtraDrip} drip`,
    '需另购套餐（VIP 不替代套餐）',
  ], [vipDiscount, vipExtraDrip])

  const copyWechat = React.useCallback(async (note?: string) => {
    try {
      await navigator.clipboard.writeText(adminWechat)
      toast.success(`已复制微信号 ${adminWechat}${note ? `，备注「${note}」` : ''}`)
    } catch {
      toast.error('复制失败，请手动复制微信号 ' + adminWechat)
    }
  }, [adminWechat])

  const handleSubscribe = React.useCallback((plan: PlanDef, cycle: 'monthly' | 'yearly') => {
    const price = cycle === 'yearly' ? plan.yearlyRmb : plan.monthlyRmb
    void copyWechat(`${plan.name} ${cycle === 'yearly' ? '年付' : '月付'} ¥${price}`)
  }, [copyWechat])

  const handleBuyVip = React.useCallback(() => {
    void copyWechat(`VIP 终身 ¥${vipPrice}`)
  }, [copyWechat, vipPrice])

  return (
    <div className="space-y-5">
      {/* ---- 四档定价卡 ---- */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Zap size={16} className="text-primary" />
          <h3 className="text-sm font-semibold">选择套餐</h3>
        </div>
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {plans.map((plan) => (
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
              <span className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">¥{vipPrice}</span>
            </div>
            <ul className="space-y-1">
              {vipFeatures.map((f) => (
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
              团队额度共享，联系微信号 {adminWechat} 开通
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
