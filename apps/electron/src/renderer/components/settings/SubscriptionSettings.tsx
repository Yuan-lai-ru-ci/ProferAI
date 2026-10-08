/**
 * SubscriptionSettings — 套餐订阅页
 *
 * 定价从服务端 /v1/account/config/plans 动态获取，Admin 操控面板可实时调整。
 * 价格未就绪时不展示兜底报价，不允许创建付费订单。
 *
 * 支持在线订单和管理员手动收款，支付完成后刷新套餐权益。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import { Check, Copy, Users, Gift, Crown, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'
import { SettingsSection } from './primitives'
import { cn } from '@/lib/utils'
import { RechargeSection } from './RechargeSection'
import {
  inviteCodeAtom,
} from '@/atoms/credits-atoms'
import {
  createSubscriptionPurchase,
  createSubscriptionStatusReader,
  openCreditsPaymentPage,
  redeemCredits,
  requestSubscriptionPricing,
} from '@/domains/credits/credits-api'
import type { PricingData, SubscriptionPurchaseInput } from '@/domains/credits/credits-types'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'


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

const FREE_PLAN: PlanDef = {
  id: 'free', name: 'Free', monthlyRmb: 0, yearlyRmb: 0,
  welcomeBonus: 0, dailyDrip: 0,
  features: ['已有账户权益以账户状态为准', '模型与工具以渠道、预设和权限配置为准'],
}

interface PurchaseState {
  orderId: string
  label: string
  qrcode: string
}

/** 将 API 返回的分值价格转换为元（API 返回人民币分） */
function rmbToYuan(fen: number): number {
  return fen / 100
}

/** 只采用完整、有限的服务端报价，避免损坏响应进入购买界面。 */
function buildPlans(data: PricingData): PlanDef[] {
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!data.vip || !finite(data.vip.price) || !finite(data.vip.discount) || data.vip.discount > 1 || !finite(data.vip.extraDrip)) throw new Error('无效的 VIP 报价')
  const paid = (['standard', 'plus', 'pro'] as const).map((id) => {
    const plan = data.plans?.[id]
    if (!plan || ![plan.monthlyRmb, plan.yearlyRmb, plan.welcomeBonus, plan.dailyDrip].every(finite)) throw new Error('无效的套餐报价')
    return {
      id, name: id[0]!.toUpperCase() + id.slice(1),
      monthlyRmb: rmbToYuan(plan.monthlyRmb), yearlyRmb: rmbToYuan(plan.yearlyRmb),
      welcomeBonus: plan.welcomeBonus, dailyDrip: plan.dailyDrip,
      features: [`首购红包 ${plan.welcomeBonus} 积分`, `每日 drip ${plan.dailyDrip} 积分`, '模型与工具以渠道、预设和权限配置为准'],
      featured: id === 'plus',
    }
  })
  return [FREE_PLAN, ...paid]
}

/** 兑换码输入组件 */
function RedeemInput({ onRedeemed }: { onRedeemed: () => Promise<void> }): React.ReactElement {
  const [code, setCode] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const redeemRef = React.useRef(false)

  const handleRedeem = React.useCallback(async () => {
    const trimmed = code.trim()
    if (redeemRef.current) return
    if (!trimmed) {
      toast.error('请输入兑换码')
      return
    }
    redeemRef.current = true
    setLoading(true)
    try {
      const result = await redeemCredits(trimmed)
      if (result.kind === 'unauthenticated') {
        toast.error('未登录，请先登录')
        return
      }
      if (result.kind === 'failed') {
        toast.error(result.message || '兑换失败')
        return
      }
      await onRedeemed()
      toast.success(result.data.description || '兑换成功！套餐与积分已刷新')
      setCode('')
    } catch {
      toast.error('兑换失败，请检查网络后重试')
    } finally {
      redeemRef.current = false
      setLoading(false)
    }
  }, [code, onRedeemed])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        aria-label="兑换码"
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleRedeem() }}
        placeholder="输入兑换码"
        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
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
  const { reload: reloadCredits } = useCreditsLoader(60_000)
  const inviteCode = useAtomValue(inviteCodeAtom)

  const [plans, setPlans] = React.useState<PlanDef[]>([FREE_PLAN])
  const [pricing, setPricing] = React.useState<PricingData | null>(null)
  const [adminWechat, setAdminWechat] = React.useState('')
  const [pricingLoading, setPricingLoading] = React.useState(true)
  const [pricingError, setPricingError] = React.useState(false)
  const [purchasing, setPurchasing] = React.useState(false)
  const purchasingRef = React.useRef(false)
  const alive = React.useRef(true)
  const pricingRequest = React.useRef(0)
  const [purchaseState, setPurchaseState] = React.useState<PurchaseState | null>(null)

  const loadPricing = React.useCallback(async () => {
    const request = ++pricingRequest.current
    setPricingLoading(true)
    setPricingError(false)
    try {
      const data = await requestSubscriptionPricing()
      if (request !== pricingRequest.current) return
      if (!data) throw new Error('价格未返回')
      const nextPlans = buildPlans(data)
      setPlans(nextPlans)
      setPricing(data)
      setAdminWechat(data.adminWechat || '')
    } catch {
      if (request === pricingRequest.current) {
        setPricingError(true)
        setPricing(null)
        setPlans([FREE_PLAN])
      }
    } finally {
      if (request === pricingRequest.current) setPricingLoading(false)
    }
  }, [])

  React.useEffect(() => {
    alive.current = true
    void loadPricing()
    return () => { alive.current = false; pricingRequest.current += 1 }
  }, [loadPricing])

  const vipFeatures = React.useMemo(() => [
    '终身买断，一次付费永久有效',
    `套餐购买 ${(pricing ? pricing.vip.discount * 10 : 0).toLocaleString()} 折`,
    `每日额外 +${pricing?.vip.extraDrip ?? 0} drip`,
    '需另购套餐（VIP 不替代套餐）',
  ], [pricing])

  const copyWechat = React.useCallback(async (note?: string) => {
    try {
      await navigator.clipboard.writeText(adminWechat)
      toast.success(`已复制微信号 ${adminWechat}${note ? `，备注「${note}」` : ''}`)
    } catch {
      toast.error('复制失败，请手动复制微信号 ' + adminWechat)
    }
  }, [adminWechat])

  const startPurchase = React.useCallback(async (input: Omit<SubscriptionPurchaseInput, 'payType'> & { label: string }) => {
    if (!pricing || pricingLoading || pricingError || purchasingRef.current || purchaseState) return
    purchasingRef.current = true
    setPurchasing(true)
    try {
      const result = await createSubscriptionPurchase({
        product: input.product, plan: input.plan, cycle: input.cycle, payType: 'wxpay',
      })
      if (result.kind === 'unauthenticated') {
        toast.error('未登录，请先登录')
        return
      }
      if (result.kind === 'failed') {
        toast.error(result.message || '创建订单失败，请稍后重试')
        return
      }
      if (!alive.current) return
      const data = result.data

      if (data.payInfo?.method === 'manual') {
        if (data.payInfo.adminWechat) {
          await navigator.clipboard.writeText(data.payInfo.adminWechat).catch(() => {})
          toast.success(`订单已创建，请联系管理员微信 ${data.payInfo.adminWechat} 完成支付`)
        } else {
          toast.info('订单已创建，请联系管理员完成支付')
        }
        return
      }

      if (!data.orderId) {
        toast.error('创建订单失败，请稍后重试')
        return
      }
      setPurchaseState({ orderId: data.orderId, label: input.label, qrcode: data.payInfo?.qrcode || '' })
      if (data.payInfo?.payUrl) {
        await openCreditsPaymentPage(data.payInfo.payUrl).catch(() => {
          toast.info('支付页已生成，请在浏览器中完成支付')
        })
      }

      const readStatus = await createSubscriptionStatusReader(data.orderId)
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5000))
        if (!alive.current) return
        const status = await readStatus?.()
        if (!alive.current) return
        if (status?.status === 'paid') {
          await reloadCredits()
          setPurchaseState(null)
          toast.success(`${input.label} 已开通`)
          return
        }
        if (status?.status === 'cancelled' || status?.status === 'expired') {
          setPurchaseState(null)
          toast.error('订单未完成支付')
          return
        }
      }
      toast.info('仍在等待支付结果，可稍后刷新额度查看')
    } catch {
      if (alive.current) toast.error('购买失败，请检查网络后重试')
    } finally {
      purchasingRef.current = false
      if (alive.current) setPurchasing(false)
    }
  }, [pricing, pricingLoading, pricingError, purchaseState, reloadCredits])

  const checkPendingOrder = async (): Promise<void> => {
    if (!purchaseState || purchasingRef.current) return
    purchasingRef.current = true
    setPurchasing(true)
    try {
      const read = await createSubscriptionStatusReader(purchaseState.orderId)
      const status = await read?.()
      if (!alive.current) return
      if (status?.status === 'paid') {
        await reloadCredits()
        setPurchaseState(null)
        toast.success('支付已确认，账户权益已刷新')
      } else if (status?.status === 'cancelled' || status?.status === 'expired') {
        setPurchaseState(null)
        toast.info('订单已结束，可重新购买')
      } else toast.info(status ? '订单仍待支付' : '订单状态暂不可用，请重试')
    } catch { toast.error('订单查询失败，请重试') }
    finally { purchasingRef.current = false; if (alive.current) setPurchasing(false) }
  }

  const handleSubscribe = React.useCallback(async (plan: PlanDef, cycle: 'monthly' | 'yearly') => {
    await startPurchase({ product: 'subscription', plan: plan.id, cycle, label: `${plan.name} ${cycle === 'yearly' ? '年付' : '月付'}` })
  }, [startPurchase])

  const handleBuyVip = React.useCallback(async () => {
    await startPurchase({ product: 'vip', label: 'VIP 终身会员' })
  }, [startPurchase])

  return (
    <div className="min-w-0 space-y-8">
      {/* ---- 四档定价卡 ---- */}
      <SettingsSection title="选择套餐" description="价格与积分权益来自当前服务端配置" action={
        <Button variant="outline" size="sm" onClick={() => void loadPricing()} disabled={pricingLoading || purchasing}>
          <RefreshCw size={14} className={pricingLoading ? 'animate-spin' : ''} />刷新价格
        </Button>
      }>
        {pricingLoading && <p role="status" className="text-sm text-muted-foreground">正在获取套餐价格…</p>}
        {pricingError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-destructive pl-3 text-sm">
            <span className="text-destructive">价格加载失败，套餐和 VIP 购买暂不可用。</span>
            <Button variant="outline" size="sm" onClick={() => void loadPricing()}>重试价格</Button>
          </div>
        )}
        <div aria-busy={pricingLoading} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={cn(
                'min-w-0 rounded-lg border p-4 flex flex-col',
                plan.featured
                  ? 'bg-primary/5 text-foreground border-primary/40'
                  : 'bg-card border-border',
              )}
            >
              <div className="mb-2">
                <div className="text-base font-bold">{plan.name}</div>
                {plan.id !== 'free' && (
                  <div className="text-xs text-muted-foreground">
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
                  <span className="text-xs ml-1 text-muted-foreground">/月</span>
                </div>
              )}
              {plan.id !== 'free' && (
                <div className="text-xs mb-3 text-muted-foreground">
                  年付 ¥{plan.yearlyRmb}/年
                </div>
              )}
              {plan.id === 'free' && <div className="mb-3" />}

              <ul className="space-y-1.5 mb-4 flex-1">
                {plan.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-1.5 text-xs">
                    <Check size={12} className="mt-0.5 shrink-0 text-primary" />
                    <span className="text-muted-foreground break-words">{feat}</span>
                  </li>
                ))}
              </ul>

              {plan.id !== 'free' && (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => handleSubscribe(plan, 'monthly')}
                    disabled={purchasing || !!purchaseState || pricingLoading || pricingError}
                    className="w-full rounded-md bg-primary py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    月付 · ¥{plan.monthlyRmb}
                  </button>
                  <button
                    onClick={() => handleSubscribe(plan, 'yearly')}
                    disabled={purchasing || !!purchaseState || pricingLoading || pricingError}
                    className="w-full rounded-md bg-muted py-2 text-xs font-medium hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    年付 · ¥{plan.yearlyRmb}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </SettingsSection>

      {/* ---- 待支付订单 ---- */}
      {purchaseState && (
        <div role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-4 flex flex-wrap items-center gap-4">
          {purchaseState.qrcode ? (
            <img src={purchaseState.qrcode} alt="支付二维码" className="size-28 rounded bg-white object-contain" />
          ) : (
            <Loader2 size={22} className="animate-spin text-primary" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold">等待支付：{purchaseState.label}</div>
            <div className="mt-1 text-xs text-muted-foreground">完成支付后，权益会自动刷新。订单号：{purchaseState.orderId.slice(0, 8)}…</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={purchasing} onClick={() => void checkPendingOrder()}>检查支付结果</Button>
              <Button size="sm" variant="ghost" disabled={purchasing} onClick={() => setPurchaseState(null)}>隐藏订单状态</Button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 充值积分块（用户自助充值） ---- */}
      <RechargeSection />

      {/* ---- VIP 叠加层 ---- */}
      <SettingsSection title="VIP 终身会员" description="VIP 为叠加权益，不替代套餐">
        <div className="flex flex-wrap items-start justify-between gap-4 border-y border-border py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Crown size={18} className="text-muted-foreground" />
              <span className="text-base font-bold">VIP 终身会员</span>
              <span className="text-lg font-semibold">{pricing ? `¥${rmbToYuan(pricing.vip.price)}` : '价格暂不可用'}</span>
            </div>
            {pricing && <ul className="space-y-1">
              {vipFeatures.map((f) => (
                <li key={f} className="flex items-start gap-1.5 text-xs text-foreground/70">
                  <Check size={12} className="mt-0.5 shrink-0 text-primary" />
                  {f}
                </li>
              ))}
            </ul>}
          </div>
          <button
            onClick={handleBuyVip}
            disabled={!pricing || pricingLoading || pricingError || purchasing || !!purchaseState}
            className="shrink-0 rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            购买 VIP
          </button>
        </div>
      </SettingsSection>

      {/* ---- 兑换码 ---- */}
      <SettingsSection title={<span className="flex items-center gap-2"><Gift size={16} />兑换码</span>} description="管理员发放的套餐或积分兑换码">
        <RedeemInput onRedeemed={reloadCredits} />
      </SettingsSection>

      {/* ---- 团队版 banner ---- */}
      {adminWechat && <div className="border-y border-border py-4 flex items-center justify-between gap-4">
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
          aria-label="复制管理员微信号" title="复制管理员微信号"
          className="shrink-0 rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Copy size={15} />
        </button>
      </div>}

      {/* ---- 邀请码 ---- */}
      {inviteCode && (
        <div className="border-b border-border pb-4 flex items-center justify-between gap-3">
          <div className="min-w-0 flex flex-wrap items-center gap-2 break-all">
            <Users size={16} className="text-muted-foreground" />
            <span className="text-sm">你的邀请码：<span className="font-mono font-bold">{inviteCode}</span></span>
          </div>
          <button
            aria-label="复制我的邀请码" title="复制我的邀请码"
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
