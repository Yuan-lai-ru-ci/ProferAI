/**
 * 额度加载 — 把服务端余额拉进 jotai atoms
 *
 * 统一三处对额度的读取：
 *   - 侧栏余额条（登录后展示 + 定时刷新）
 *   - 额度不足（402）后的即时刷新
 *   - 设置页额度概览
 *
 * 仅在代管模式（commercialMode）下有效；非代管模式直接清空余额。
 */
import * as React from 'react'
import { useSetAtom, useStore } from 'jotai'
import {
  creditsBalanceAtom,
  creditsLifetimeConsumedAtom,
  creditsLoadingAtom,
  creditsBalancePackageAtom,
  creditsBalanceReferralAtom,
  creditsBalancePurchasedAtom,
  membershipTierAtom,
  isVipAtom,
  multiplierAtom,
  inviteCodeAtom,
  subscriptionAtom,
} from '@/atoms/credits-atoms'

/** jotai store（useStore() / createStore() 的返回类型） */
type JotaiStore = ReturnType<typeof useStore>

/** 拉取一次余额并写入指定 store。供组件外（如全局错误监听）调用。 */
export async function refreshCreditsInto(store: JotaiStore): Promise<void> {
  try {
    const commercial = await window.electronAPI.getCommercialMode().catch(() => false)
    if (!commercial) {
      store.set(creditsBalanceAtom, null)
      return
    }
    const auth = await window.electronAPI.auth.getTeamAuth()
    if (!auth) return
    const resp = await fetch(`${auth.baseUrl}/v1/account/credits`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    if (!resp.ok) return
    const d = await resp.json()
    // 当前用户本地账本余额：balance 可能为 null（非代管或查询失败）
    store.set(creditsBalanceAtom, d.balance ?? null)
    store.set(creditsLifetimeConsumedAtom, d.lifetimeConsumed ?? 0)
    // 积分分账 + 会员
    store.set(creditsBalancePackageAtom, d.balancePackage ?? 0)
    store.set(creditsBalanceReferralAtom, d.balanceReferral ?? 0)
    store.set(creditsBalancePurchasedAtom, d.balancePurchased ?? 0)
    store.set(membershipTierAtom, d.membershipTier ?? 'free')
    store.set(isVipAtom, !!d.isVip)
    store.set(multiplierAtom, d.multiplier ?? 1.0)
    store.set(inviteCodeAtom, d.inviteCode ?? null)
    // 订阅状态
    if (d.subscription) {
      store.set(subscriptionAtom, d.subscription)
    }
  } catch {
    /* 静默：余额拉取失败不打扰用户 */
  }
}

/**
 * 在组件中加载并定时刷新余额。
 * @param pollMs 轮询间隔，默认 60s；传 0 关闭轮询
 */
export function useCreditsLoader(pollMs = 60_000): { reload: () => Promise<void> } {
  const store = useStore()
  const setLoading = useSetAtom(creditsLoadingAtom)

  const reload = React.useCallback(async () => {
    setLoading(true)
    try {
      await refreshCreditsInto(store)
    } finally {
      setLoading(false)
    }
  }, [store, setLoading])

  React.useEffect(() => {
    void reload()
    if (pollMs <= 0) return
    const timer = setInterval(() => { void reload() }, pollMs)
    return () => clearInterval(timer)
  }, [reload, pollMs])

  return { reload }
}
