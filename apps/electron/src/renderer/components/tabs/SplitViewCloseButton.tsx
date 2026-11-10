/**
 * SplitViewCloseButton — 拆分视图右下角的退出浮标
 *
 * 为什么放在内容区而不是顶栏：分屏后用户的视线落在两栏内容上，退出入口要贴着拆分视图本身，
 * 与 Chrome 拆分视图右下角的关闭标一致；顶栏的「解散组合」仍然保留，两者语义相同。
 *
 * 浏览器/预览直接叠在内容右下角；右栏是 Agent/Chat 时由 MainArea 预留 32px，
 * 避免浮标压住输入框右下角的发送按钮。网页与浮标处于同一个 DOM 合成层。
 */

import * as React from 'react'
import { X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@profer/ui/primitives/tooltip'

export interface SplitViewCloseButtonProps {
  /** 退出拆分视图：两个标签都保留，只取消左右并排 */
  onClose: () => void
}

export function SplitViewCloseButton({ onClose }: SplitViewCloseButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="关闭拆分视图"
          data-split-view-close="true"
          onClick={onClose}
          // 按钮位于右栏外层（不经过栏内 pointerdown 聚焦逻辑），阻止冒泡避免误触分栏拖拽/聚焦。
          onPointerDown={(event) => event.stopPropagation()}
          className="titlebar-no-drag absolute bottom-1.5 right-1.5 z-20 flex size-6 items-center justify-center rounded-full border border-border/50 bg-foreground/[0.08] text-foreground/60 shadow-sm backdrop-blur transition-colors hover:bg-foreground/[0.14] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        <p>关闭拆分视图（两个标签都保留）</p>
      </TooltipContent>
    </Tooltip>
  )
}
