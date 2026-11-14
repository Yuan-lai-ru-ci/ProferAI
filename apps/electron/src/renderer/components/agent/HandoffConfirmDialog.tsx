/**
 * HandoffConfirmDialog — 手动交接的二次确认
 *
 * 交接不是本地操作：它会让源会话跑一次 headless agent 撰写文档（最长 4 分钟、
 * 消耗模型额度）、新建一个会话、并把用户切过去。误点一次代价不低，所以工具栏
 * 的常驻按钮先问一句再动手。
 *
 * 刻意挂在 `AgentView` 顶层而不是 `HandoffToolbarButton` 内部：窄窗口时工具栏会
 * 把按钮折进「更多」Popover，Dialog 若挂在按钮里，Popover 关闭（Dialog 打开会
 * 触发它的 outside interaction）就会连同 React 子树一起被卸载，确认框一闪就没了。
 * 提到顶层后，按钮无论在主栏还是 overflow 都不影响弹窗。
 *
 * 建议条 `HandoffSuggestion` 保持一键触发：那个入口本身就是「系统建议 + 用户点
 * 『新开会话』」，已经是一次明确确认，再叠一层只会变成噪音。
 */

import type { ReactElement } from 'react'
import { useAtomValue } from 'jotai'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import { handoffInFlightAtomFamily } from '@/atoms/session-handoff'
import { useSessionHandoff } from '@/hooks/useSessionHandoff'

interface HandoffConfirmDialogProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 会话标题，可能首轮之后才生成；缺省用通用文案 */
  sessionTitle?: string
}

export function HandoffConfirmDialog({
  sessionId,
  open,
  onOpenChange,
  sessionTitle,
}: HandoffConfirmDialogProps): ReactElement {
  const { startHandoff } = useSessionHandoff(sessionId)
  const inFlight = useAtomValue(handoffInFlightAtomFamily(sessionId))
  const subject = sessionTitle?.trim() ? `「${sessionTitle.trim()}」` : '当前会话'

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>把{subject}交接到一个新会话？</AlertDialogTitle>
          <AlertDialogDescription>
            会先让当前会话整理一份交接文档（需要调用一次模型，最长约 4 分钟），
            然后新建会话并自动切换过去；当前会话保持不变。
            新会话首轮只读取文档、复述计划，不会直接开始改动。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先不交接</AlertDialogCancel>
          <AlertDialogAction
            disabled={inFlight}
            onClick={(event) => {
              // 阻止 Radix 自动关闭：先关弹窗再启动，避免交接期间弹窗挂在已切走的会话上。
              event.preventDefault()
              if (inFlight) return
              onOpenChange(false)
              void startHandoff()
            }}
          >
            开始交接
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
