/**
 * 会话状态视觉 — 状态点颜色与文案的唯一来源
 *
 * 组合 tab 的顶栏条目与组内栏头都要显示"两个会话各自在跑什么"，
 * 两边共用同一张表，避免出现两套色值。
 * 颜色沿用左侧栏会话列表的既有约定（running 蓝 / blocked 橙 / completed 绿）。
 * interrupted 用红：它表示“停在断点、等你决定是否续跑”，既不是成功也不是普通空闲，
 * 不能和 idle 同色否则用户看不见。
 */

import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'

export const SESSION_STATUS_DOT_CLASS: Record<SessionIndicatorStatus, string> = {
  idle: '',
  running: 'bg-info animate-pulse',
  blocked: 'bg-warning',
  completed: 'bg-success',
  interrupted: 'bg-destructive',
}

export const SESSION_STATUS_LABEL: Record<SessionIndicatorStatus, string> = {
  idle: '',
  running: '运行中',
  blocked: '等待确认',
  completed: '已完成',
  interrupted: '已中断',
}
