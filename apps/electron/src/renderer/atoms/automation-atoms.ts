/**
 * 定时任务（Automation）状态管理
 *
 * - automationsAtom：任务列表（由初始化器从主进程加载并订阅变更刷新）
 * - automationFormAtom：创建/编辑表单的开关 + 草稿（表单复用中间内容区，非弹窗）
 */

import { atom } from 'jotai'
import type { Automation } from '@profer/shared'
import type { AutomationDraft } from '@/domains/automation/automation-draft'

// 保留历史入口，现有对话与规划页面继续使用同一组 Atom 和草稿函数。
export { createEmptyDraft, automationToDraft } from '@/domains/automation/automation-draft'
export type { AutomationDraft } from '@/domains/automation/automation-draft'

/** 全部定时任务列表 */
export const automationsAtom = atom<Automation[]>([])

/** 表单视图状态（覆盖在中间内容区） */
export interface AutomationFormState {
  open: boolean
  draft: AutomationDraft | null
}

export const automationFormAtom = atom<AutomationFormState>({
  open: false,
  draft: null,
})

/** 固定间隔选项（分钟） */
export const AUTOMATION_INTERVAL_OPTIONS = [
  { label: '每 5 分钟', value: 5 },
  { label: '每 10 分钟', value: 10 },
  { label: '每 30 分钟', value: 30 },
  { label: '每 1 小时', value: 60 },
  { label: '每 3 小时', value: 180 },
  { label: '每 6 小时', value: 360 },
  { label: '每 12 小时', value: 720 },
] as const

/** 星期选项（0=周日） */
export const AUTOMATION_WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 0 },
] as const

