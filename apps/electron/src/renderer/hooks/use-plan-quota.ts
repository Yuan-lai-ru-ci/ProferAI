/**
 * usePlanQuota — 渠道订阅 Plan 额度的共享查询 hook
 *
 * 统一「旧值优先 + 刷新状态」逻辑，供模型选择器徽章与上下文 Popover 复用：
 * - 挂载时读缓存作为初始值；缓存无效则静默拉取（refreshing 置位，UI 表现为刷新图标转圈）。
 * - `refresh()` 手动/定时强制刷新，跳过缓存；重复触发由数据层 in-flight 锁兜底（同一 Promise）。
 * - 状态存入 `planQuotaStateAtomFamily`，同一渠道多入口共享同一份数据与刷新态，
 *   一处触发刷新，所有入口的刷新图标同时转圈。
 */
import * as React from 'react'
import { useAtom } from 'jotai'
import type { ChannelPlanQuotaResult } from '@profer/shared'
import { planQuotaStateAtomFamily, type PlanQuotaUiState } from '@/atoms/plan-quota-atoms'
import {
  fetchChannelPlanQuota,
  getCachedPlanQuota,
  requestPlanQuotaRefresh,
  ensurePeriodicRefresh,
  releasePeriodicRefresh,
  subscribeChannelQuotaRefresh,
} from '@/lib/channel-plan-quota'

export interface UsePlanQuotaResult {
  /** 最近一次成功结果；刷新期间保持旧值（null = 从未成功获取）。 */
  quota: ChannelPlanQuotaResult | null
  /** 是否有额度请求在飞（手动 / 被动 / 定时刷新统一置位）。 */
  refreshing: boolean
  /** 手动刷新：跳过缓存强制拉取。刷新中重复调用由数据层 in-flight 锁兜底。 */
  refresh: () => void
}

/** channelId 为空时的占位 key——保证 useAtom 永远拿到稳定 atom。 */
const EMPTY_CHANNEL_KEY = '__plan-quota-empty__'

/** 统一请求入口：force=true 跳过缓存强制刷新；否则缓存有效直接返回（不发起请求）。 */
async function runPlanQuotaLoad(
  setState: (updater: (prev: PlanQuotaUiState) => PlanQuotaUiState) => void,
  channelId: string,
  force: boolean,
): Promise<void> {
  if (!force) {
    const cached = getCachedPlanQuota(channelId)
    if (cached) {
      setState((prev) => ({ ...prev, quota: cached }))
      return
    }
  }
  setState((prev) => ({ ...prev, refreshing: true }))
  const result = force
    ? await requestPlanQuotaRefresh(channelId)
    : await fetchChannelPlanQuota(channelId)
  // 旧值优先：请求完成才更新 quota，刷新期间旧值保持可见。
  setState((prev) => ({ ...prev, quota: result, refreshing: false }))
}

export function usePlanQuota(channelId?: string): UsePlanQuotaResult {
  const key = channelId ?? EMPTY_CHANNEL_KEY
  const stateAtom = planQuotaStateAtomFamily(key)
  const [state, setState] = useAtom(stateAtom)

  // 挂载/渠道变化：读缓存为初始值；缓存无效则静默预取。
  // 若另一入口已有请求在飞（refreshing 已 true），fetchChannelPlanQuota 命中 in-flight 锁复用同一 Promise，不产生重复请求。
  React.useEffect(() => {
    if (!channelId) return
    let cancelled = false
    void runPlanQuotaLoad((updater) => {
      if (cancelled) return
      setState(updater)
    }, channelId, false)
    return () => { cancelled = true }
  }, [channelId, setState])

  // 定时后台刷新：渠道存在活跃入口时每 5 分钟静默刷新一次（旧值优先，缓存随之保鲜）。
  // 订阅刷新事件：定时刷新开始/完成时同步 refreshing 与 quota，保证「打开 UI 时若在刷新则图标转圈」。
  React.useEffect(() => {
    if (!channelId) return
    ensurePeriodicRefresh(channelId)
    const unsubscribe = subscribeChannelQuotaRefresh(channelId, (event) => {
      if (event.type === 'start') {
        setState((prev) => ({ ...prev, refreshing: true }))
      } else {
        setState((prev) => ({ ...prev, quota: event.result, refreshing: false }))
      }
    })
    return () => {
      unsubscribe()
      releasePeriodicRefresh(channelId)
    }
  }, [channelId, setState])

  const refresh = React.useCallback(() => {
    if (!channelId) return
    // 不在此处判断 refreshing：UI 层按钮 disabled 已锁定，数据层 in-flight 锁兜底重复触发。
    void runPlanQuotaLoad(setState, channelId, true)
  }, [channelId, setState])

  return { quota: state.quota, refreshing: state.refreshing, refresh }
}
