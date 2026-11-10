/**
 * WelcomeEmptyState — 对话/会话空状态引导
 *
 * 在没有会话时展示：
 * 1. 个性化时段问候
 * 2. 平台感知的小 Tips
 * 3. 调用方插槽（新会话居中布局里放输入框）
 *
 * 模式切换由左侧栏顶部的 Agent/Chat 开关负责；活跃热力图统一收敛到「我的画像」
 * （GlobalUsageCard，跨工作区聚合），这里不再重复展示。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Lightbulb } from 'lucide-react'
import { cn } from '@/lib/utils'
import { userProfileAtom } from '@/atoms/user-profile'

import { getRandomTip, getPlatform, type Tip } from '@/lib/tips'

/** 根据小时返回时段问候 */
function getGreeting(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export interface WelcomeEmptyStateProps {
  /**
   * 布局变体：
   * - `centered`（默认）：占满消息区，为底部输入框让位（向上偏移补偿）
   * - `inline`：作为「欢迎语 + 输入框」居中布局的一部分，自身不撑满、不偏移，
   *   由外层容器负责垂直居中
   */
  variant?: 'centered' | 'inline'
  /** 插槽：inline 变体用来放输入框，紧跟在问候语与 Tips 下方 */
  children?: React.ReactNode
}

export function WelcomeEmptyState({ variant = 'centered', children }: WelcomeEmptyStateProps = {}): React.ReactElement {
  const inline = variant === 'inline'
  const userProfile = useAtomValue(userProfileAtom)

  // 稳定的随机 Tip（组件挂载时选一条）
  const [tip] = React.useState<Tip>(() => getRandomTip(getPlatform()))

  const hour = new Date().getHours()
  const greeting = getGreeting(hour)
  const displayName = userProfile.userName || '用户'

  return (
    <div
      className={cn(
        'welcome-empty-state flex flex-col items-center px-4',
        inline
          ? 'w-full gap-5'
          : 'h-full translate-y-[90px] justify-center gap-6 [@media(max-height:820px)]:translate-y-0 [@media(max-height:700px)]:gap-4',
      )}
    >
      {/* 问候语 */}
      <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
        {displayName}，{greeting}
      </h1>

      {/* Tips */}
      <div className="flex items-center gap-2.5 rounded-full bg-muted/50 px-4 py-2 text-[13px] text-muted-foreground">
        <Lightbulb size={14} className="flex-shrink-0 text-amber-500/80" />
        <span>{tip.text}</span>
      </div>

      {/* 插槽：inline 变体放输入框。
          justify-center 让调用方的 max-w 容器真正水平居中——普通块级子元素只会左对齐。 */}
      {children != null && <div className="flex w-full justify-center">{children}</div>}
    </div>
  )
}
