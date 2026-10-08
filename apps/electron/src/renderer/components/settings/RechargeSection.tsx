/**
 * RechargeSection — 用户自助充值积分块
 *
 * 位于订阅设置页的套餐卡片之后。加载服务端充值配置（档位/汇率/是否在线支付/微信兜底），
 * 支持固定档位 + 自定义金额，在线支付时可选微信/支付宝并跳转易支付；
 * 未启用在线支付时降级为复制微信号联系管理员（manual）。
 *
 * 汇率：1 元 = rate 积分（默认 10）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Zap, Copy, ExternalLink, Loader2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  createRechargeOrder,
  createRechargeStatusReader,
  openCreditsPaymentPage,
  requestRechargeConfig,
} from '@/domains/credits/credits-api'
import type { RechargeConfig } from '@/domains/credits/credits-types'
import { useCreditsLoader } from '@/hooks/useCreditsLoader'

const DEFAULT_CONFIG: RechargeConfig = {
  enabled: false,
  manualFallback: true,
  rate: 10,
  presetsRmb: [10, 30, 50, 100, 300],
  customMinRmb: 1,
  customMaxRmb: 1000,
  currency: 'rmb',
  adminWechat: '',
}

export function RechargeSection(): React.ReactElement {
  const { reload: reloadCredits } = useCreditsLoader(0)
  const [config, setConfig] = React.useState<RechargeConfig>(DEFAULT_CONFIG)
  const [configLoaded, setConfigLoaded] = React.useState(false)
  const [configError, setConfigError] = React.useState('')
  const submittingRef = React.useRef(false)
  const pendingOrderRef = React.useRef<string | null>(null)
  const mountedRef = React.useRef(false)
  const pollGenerationRef = React.useRef(0)
  const pollWaitRef = React.useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null)
  const customAmountId = React.useId()

  const [amountYuan, setAmountYuan] = React.useState<number>(0)
  const [customAmount, setCustomAmount] = React.useState<string>('')
  const [payType, setPayType] = React.useState<'wxpay' | 'alipay'>('wxpay')
  const [submitting, setSubmitting] = React.useState(false)
  const [pendingOrderId, setPendingOrderId] = React.useState<string | null>(null)
  const [pendingQrcode, setPendingQrcode] = React.useState<string>('')
  const [orderMessage, setOrderMessage] = React.useState('')

  const loadConfig = React.useCallback(async (): Promise<void> => {
    setConfigLoaded(false)
    setConfigError('')
    try {
      const data = await requestRechargeConfig()
      if (!data || !Number.isFinite(data.rate) || data.rate <= 0 || !Number.isFinite(data.customMinRmb) || !Number.isFinite(data.customMaxRmb) || data.customMinRmb <= 0 || data.customMaxRmb < data.customMinRmb || !Array.isArray(data.presetsRmb) || data.presetsRmb.some((amount) => !Number.isFinite(amount) || amount <= 0)) {
        throw new Error('无效充值配置')
      }
      if (mountedRef.current && data) setConfig({ ...DEFAULT_CONFIG, ...data })
    } catch {
      if (mountedRef.current) setConfigError('充值配置读取失败，请重试；配置未确认前不能下单')
    } finally {
      if (mountedRef.current) setConfigLoaded(true)
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    void loadConfig()
    return () => {
      mountedRef.current = false
      pollGenerationRef.current++
      if (pollWaitRef.current) clearTimeout(pollWaitRef.current.timer)
      pollWaitRef.current?.resolve()
      pollWaitRef.current = null
    }
  }, [loadConfig])

  // 当前选中金额（元）
  const effectiveAmount = amountYuan > 0 ? amountYuan : Number(customAmount)
  // 等值积分
  const estimatedPoints = config.rate * effectiveAmount

  const choosePreset = React.useCallback((yuan: number) => {
    setAmountYuan(yuan)
    setCustomAmount('')
  }, [])

  const chooseCustom = React.useCallback((v: string) => {
    setCustomAmount(v)
    setAmountYuan(0)
  }, [])

  const payTypeOptions: { value: 'wxpay' | 'alipay'; label: string }[] = [
    { value: 'wxpay', label: '微信' },
    { value: 'alipay', label: '支付宝' },
  ]

  const copyWechat = React.useCallback(async () => {
    if (!config.adminWechat) {
      toast.error('暂未配置管理员微信号，请联系管理员')
      return
    }
    try {
      await navigator.clipboard.writeText(config.adminWechat)
      toast.success(`已复制微信号 ${config.adminWechat}，备注「积分充值 ¥${effectiveAmount}」`)
    } catch {
      toast.error('复制失败，请手动复制 ' + config.adminWechat)
    }
  }, [config.adminWechat, effectiveAmount])

  const openPay = React.useCallback(async (payUrl: string, qrcode: string) => {
    if (qrcode) {
      // 展示二维码并同时打开支付页（若可用）
      setPendingQrcode(qrcode)
    }
    if (payUrl) {
      await openCreditsPaymentPage(payUrl).catch(() => toast.info('请在浏览器中完成支付'))
    }
  }, [])

  const pollStatus = React.useCallback(async (orderId: string): Promise<boolean> => {
    const generation = ++pollGenerationRef.current
    const current = () => mountedRef.current && generation === pollGenerationRef.current
    setOrderMessage('订单已生成，等待付款确认')
    try {
      const readStatus = await createRechargeStatusReader(orderId)
      if (!current()) return false
      if (!readStatus) throw new Error('无法读取订单')
      for (let i = 0; i < 30; i++) {
        if (i > 0) await new Promise<void>((resolve) => {
          pollWaitRef.current = { timer: setTimeout(() => { pollWaitRef.current = null; resolve() }, 5000), resolve }
        })
        if (!current()) return false
        const d = await readStatus()
        if (!current()) return false
        if (d?.status === 'paid') {
          toast.success(`充值成功，已到账 ${Math.round(((d.amountRmb ?? 0) / 100) * config.rate)} 积分`)
          await reloadCredits()
          if (!current()) return false
          pendingOrderRef.current = null
          setPendingOrderId(null)
          setPendingQrcode('')
          setOrderMessage('充值已到账')
          return true
        }
        if (d?.status === 'cancelled' || d?.status === 'expired') {
          pendingOrderRef.current = null
          setPendingOrderId(null)
          setPendingQrcode('')
          setOrderMessage(d.status === 'expired' ? '充值订单已过期' : '充值订单已取消')
          return false
        }
      }
    } catch {
      if (current()) setOrderMessage('订单查询失败，可重试查询；请勿重复下单')
      return false
    }
    if (current()) setOrderMessage('暂未确认到账，可重试查询；请勿重复下单')
    return false
  }, [config.rate, reloadCredits])

  const handleRecharge = React.useCallback(async () => {
    if (submittingRef.current || !configLoaded || configError || pendingOrderRef.current) return
    const amount = effectiveAmount
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      toast.error('请选择充值金额')
      return
    }
    if (amount < config.customMinRmb || amount > config.customMaxRmb) {
      toast.error(`充值金额需在 ${config.customMinRmb}～${config.customMaxRmb} 元之间`)
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      const result = await createRechargeOrder(amount * 100, payType)
      if (!mountedRef.current) return
      if (result.kind === 'unauthenticated') {
        toast.error('未登录，请先登录团队工作区')
        return
      }
      if (result.kind === 'failed') {
        toast.error(result.message || '充值下单失败，请重试')
        return
      }
      const d = result.data
      if (d.payInfo?.method === 'online') {
        if (!d.orderId) {
          toast.error('充值订单响应无效，请重试')
          return
        }
        pendingOrderRef.current = d.orderId
        setPendingOrderId(d.orderId)
        await openPay(d.payInfo.payUrl || '', d.payInfo.qrcode || '')
        // 打开支付页后轮询到账
        void pollStatus(d.orderId)
      } else {
        // manual：复制微信账号
        toast.success(`已生成充值订单，请向管理员微信转账 ¥${amount}（${Math.round(amount * config.rate)} 积分）`)
        await copyWechat()
      }
    } catch {
      toast.error('充值下单失败，请检查网络后重试')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [pendingOrderId, configLoaded, configError, effectiveAmount, config.customMinRmb, config.customMaxRmb, config.rate, payType, openPay, pollStatus, copyWechat])

  if (!configLoaded) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 size={14} className="animate-spin" /> 加载充值配置…
      </div>
    )
  }

  const onlineEnabled = config.enabled

  if (configError) {
    return (
      <div className="rounded-lg border border-destructive/40 p-4 text-sm">
        <p role="alert" className="text-destructive">{configError}</p>
        <button type="button" onClick={() => void loadConfig()} className="mt-3 rounded-lg border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring">
          重试读取充值配置
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/[0.05] to-transparent p-5">
      <div className="flex items-center gap-2 mb-1">
        <Zap size={16} className="text-primary" />
        <h3 className="text-sm font-semibold">充值积分</h3>
        <span className="text-[11px] text-muted-foreground">1 元 = {config.rate} 积分 · 付款确认后到账</span>
      </div>

      {/* 档位 */}
      <div className="flex flex-wrap gap-2 my-3">
        {config.presetsRmb.map((p) => (
          <button
            key={p}
            onClick={() => choosePreset(p)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium border transition-colors',
              amountYuan === p
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-foreground border-border hover:border-primary/50',
            )}
          >
            ¥{p}
          </button>
        ))}
      </div>

      {/* 自定义金额 */}
      <div className="flex items-center gap-2 mb-3">
        <label htmlFor={customAmountId} className="text-sm text-muted-foreground">自定义</label>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 focus-within:border-primary">
          <span className="text-sm text-muted-foreground">¥</span>
          <input
            id={customAmountId}
            disabled={submitting || Boolean(pendingOrderId)}
            type="number"
            min={config.customMinRmb}
            max={config.customMaxRmb}
            placeholder={`${config.customMinRmb}~${config.customMaxRmb}`}
            value={customAmount}
            onChange={(e) => chooseCustom(e.target.value)}
            className="w-20 bg-transparent outline-none text-sm tabular-nums"
          />
        </div>
        {effectiveAmount > 0 && (
          <span className="text-xs text-muted-foreground">≈ {estimatedPoints} 积分</span>
        )}
      </div>

      {/* 支付方式 + 充值按钮 */}
      <div className="flex items-center gap-3">
        {onlineEnabled ? (
          <div className="flex rounded-lg border border-border overflow-hidden">
            {payTypeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPayType(opt.value)}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium transition-colors',
                  payType === opt.value ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">在线支付未启用，将复制管理员微信转账</span>
        )}

        <button
          onClick={handleRecharge}
          disabled={submitting || !Number.isFinite(effectiveAmount) || !Number.isInteger(effectiveAmount) || effectiveAmount <= 0 || Boolean(pendingOrderId)}
          className="ml-auto rounded-lg bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <span className="flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> 下单中…</span>
          ) : (
            `立即充值${effectiveAmount > 0 ? ` ¥${effectiveAmount}` : ''}`
          )}
        </button>
      </div>

      {/* 二维码（在线支付展示） */}
      {orderMessage && <p role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">{orderMessage}</p>}
      {pendingOrderId && <button type="button" onClick={() => {
        if (pollWaitRef.current) clearTimeout(pollWaitRef.current.timer)
        pollWaitRef.current?.resolve()
        pollWaitRef.current = null
        void pollStatus(pendingOrderId)
      }} className="mt-2 rounded-lg border border-border px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-ring">重试查询订单</button>}
      {pendingQrcode && (
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-border bg-card p-3">
          <img src={pendingQrcode} alt="收款二维码" className="w-32 h-32 object-contain rounded bg-white" />
          <div className="text-xs text-muted-foreground space-y-1.5">
            <div className="flex items-center gap-1 font-medium text-foreground">
              <Check size={13} className="text-green-600" /> 订单已生成，请扫码或打开链接支付
            </div>
            <div>支付完成后会自动到账，请勿关闭此页面</div>
            <button onClick={() => copyWechat()} className="inline-flex items-center gap-1 text-primary hover:underline">
              <Copy size={12} /> 复制支付信息
            </button>
          </div>
        </div>
      )}

      {/* 底部说明 */}
      <div className="mt-3 pt-3 border-t border-border/60 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
        <span>充值积分进入独立「充值积分」桶，套餐到期不清空</span>
        <span>扣费顺序：套餐 → 返利 → 充值</span>
        <span>充值区间 ¥{config.customMinRmb}～{config.customMaxRmb}</span>
      </div>
    </div>
  )
}
