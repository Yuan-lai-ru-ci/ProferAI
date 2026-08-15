/**
 * 渠道订阅 Plan 额度展示状态（共享）
 *
 * 供 ChannelPlanQuotaBadge（模型选择器徽章）与 ContextUsageBadge（上下文 Popover）共用，
 * 同一渠道在任何入口看到的数据与刷新状态保持一致：
 * - quota：最近一次成功结果（旧值优先，刷新期间保持可见）
 * - refreshing：当前是否有额度请求在飞（手动 / 被动 / 定时刷新统一置位）
 */
import { atomFamily } from 'jotai/utils'
import { atom } from 'jotai'
import type { ChannelPlanQuotaResult } from '@profer/shared'

/** 单渠道额度展示状态。quota 为 null 表示从未成功获取过（旧值优先时无旧值）。 */
export interface PlanQuotaUiState {
  quota: ChannelPlanQuotaResult | null
  refreshing: boolean
}

/** 按渠道 ID 切分的额度展示状态（跨组件共享，保证一致）。 */
export const planQuotaStateAtomFamily = atomFamily((_channelId: string) =>
  atom<PlanQuotaUiState>({ quota: null, refreshing: false }),
)
