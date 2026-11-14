/**
 * HandoffToolbarButton — 输入工具栏里的常驻「会话交接」入口
 *
 * 与 `HandoffSuggestion` 的区别：建议条只在设置阈值命中/上下文告警时出现，
 * 且默认关闭；这里是一个**常驻按钮**，不看阈值、不看上下文、不看「不再提示」，
 * 用户想在任意一轮交接都点得到。
 *
 * 点击只发出 `onRequest`，由 `AgentView` 顶层的 `HandoffConfirmDialog` 做二次确认
 * 后才真正执行：交接会跑一次模型、建会话、切标签，不值得为一键误点买单。
 *
 * 只挡「点了会出错」的时机（本会话正在跑 / 已交接在飞 / 会话没有内容），
 * 判定放在 `resolveManualHandoffState` 纯函数里，按钮只负责呈现。
 */

import type { ReactElement } from 'react'
import { useAtomValue } from 'jotai'
import { ArrowRightLeft, Loader2 } from 'lucide-react'
import { AgentComposerToolTrigger } from '@/components/ai-elements/composer/ComposerTool'
import { handoffInFlightAtomFamily } from '@/atoms/session-handoff'
import {
  MANUAL_HANDOFF_TOOLTIP,
  resolveManualHandoffState,
} from '@/lib/session-handoff-trigger'

interface HandoffToolbarButtonProps {
  sessionId: string
  /** 会话消息是否已完成首次加载 */
  sessionReady: boolean
  /** 会话里是否已有可交接的内容 */
  hasContent: boolean
  /** 本会话是否正在运行（流式 / 后台等待 / 压缩 / 换内核等） */
  running: boolean
  /** 只请求确认，不直接执行交接 */
  onRequest: () => void
}

export function HandoffToolbarButton({
  sessionId,
  sessionReady,
  hasContent,
  running,
  onRequest,
}: HandoffToolbarButtonProps): ReactElement {
  // 与建议条 / 确认弹窗共享同一份进行态，保证 spinner 和防连点一致。
  const inFlight = useAtomValue(handoffInFlightAtomFamily(sessionId))
  const state = resolveManualHandoffState({ sessionReady, hasContent, running, inFlight })

  // 启用态 hover 只报按钮名（代价说明在确认框里），禁用态才展开具体原因。
  const trigger = (
    <AgentComposerToolTrigger
      label="交接并新开会话"
      tooltip={state.hint ?? MANUAL_HANDOFF_TOOLTIP}
      state={inFlight ? 'active' : 'default'}
      disabled={!state.enabled}
      onClick={() => { onRequest() }}
    >
      {inFlight
        ? <Loader2 className="size-5 animate-spin" />
        : <ArrowRightLeft className="size-5" />}
    </AgentComposerToolTrigger>
  )

  // disabled button 不派发 pointer 事件，Radix Tooltip 挂不上去。包一层带原生
  // title 的容器兜底，否则用户只看到一个灰按钮，不知道为什么不能点。
  return state.enabled
    ? trigger
    : <span className="inline-flex" title={state.hint}>{trigger}</span>
}
