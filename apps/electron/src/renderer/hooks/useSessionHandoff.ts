/**
 * useSessionHandoff —— 会话交接动作的单一实现
 *
 * 交接动作只有一份：撰写交接文档 → 新建会话 → 打开标签页 → 把首轮 prompt
 * 交给新会话。以前整段写在 HandoffSuggestion 内部，其它入口（建议条、Agent
 * 提交的交接卡片等）要复用只能复制一份，两边一旦漂移就会出现「建的会话不带
 * 交接文档」这类难查的差异，所以抽成 hook。
 *
 * 注意：这里只是动作实现，不代表存在常驻 UI 入口；入口由各调用方自己决定。
 *
 * 主进程是单写者：这里不碰任何会话文件，只调 IPC 并更新渲染层状态。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { AgentSessionHandoffResult } from '@profer/shared'
import { agentPendingPromptAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { handoffDismissedAtom, handoffInFlightAtomFamily } from '@/atoms/session-handoff'
import { useOpenSession } from './useOpenSession'

/**
 * 同步闸门：Jotai 的 set 不会立刻改到本次渲染读到的值，同一帧里两个入口各点一次
 * 仍可能都通过。模块级 Set 是同步的，兜住这种跨组件的极限连点。
 */
const inFlightSessionIds = new Set<string>()

/**
 * 新会话首轮 prompt：只要它「读 + 复述」，不要它「动手」。
 *
 * `additionalDirectories` 里会带上交接文档所在目录，所以这里用绝对路径引用
 * 才不会因为 cwd 之外而读不到。
 */
export function buildHandoffBootstrapPrompt(result: AgentSessionHandoffResult): string {
  return `已从上一个会话交接过来，交接文档：${result.handoffPath}

请先读取这份文档，然后**只做确认，先不要动手**：
1. 用 3-5 条要点复述你接手的目标、已经完成的部分、以及下一步建议；
2. 指出文档里含糊、缺失，或你认为需要我确认的地方；
3. 等我确认之后再开始执行。`
}

export interface UseSessionHandoffResult {
  /** 交接是否在进行中；调用方据此显示进度并防连点 */
  inFlight: boolean
  startHandoff: () => Promise<void>
  /**
   * 交接结果已在主进程产生时（Agent 提议卡片的确认走主进程 IPC），只执行渲染层动作：
   * 会话列表 / 忽略建议 / 切标签 / 首轮 prompt。不要再跑一次交接。
   */
  applyHandoffResult: (result: AgentSessionHandoffResult) => void
}

export function useSessionHandoff(sessionId: string): UseSessionHandoffResult {
  const setPendingPrompt = useSetAtom(agentPendingPromptAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setDismissedIds = useSetAtom(handoffDismissedAtom)
  const openSession = useOpenSession()
  const [inFlight, setInFlight] = useAtom(handoffInFlightAtomFamily(sessionId))

  const applyHandoffResult = React.useCallback((result: AgentSessionHandoffResult): void => {
    setAgentSessions((prev) => (
      prev.some((session) => session.id === result.session.id) ? prev : [result.session, ...prev]
    ))
    // 交接完成后旧会话不再提示：用户刚做过这个动作，立刻再劝一次只会变成噪音。
    setDismissedIds((prev) => {
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
    openSession('agent', result.session.id, result.session.title)
    setPendingPrompt({
      sessionId: result.session.id,
      message: buildHandoffBootstrapPrompt(result),
      additionalDirectories: [result.handoffDir],
    })
    if (result.handoffSource === 'transcript') {
      toast.warning('交接文档由转录自动生成（模型撰写未成功），建议先核对内容')
    }
  }, [sessionId, openSession, setAgentSessions, setDismissedIds, setPendingPrompt])

  const startHandoff = React.useCallback(async (): Promise<void> => {
    if (inFlight || inFlightSessionIds.has(sessionId)) return
    inFlightSessionIds.add(sessionId)
    setInFlight(true)
    toast.info('正在整理交接文档…', { description: '完成后会自动切到新会话，当前会话保持不变' })
    try {
      const result = await window.electronAPI.createAgentHandoffSession(sessionId)
      applyHandoffResult(result)
    } catch (error) {
      console.error('[会话交接] 创建交接会话失败:', error)
      toast.error('交接失败，请重试', {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      inFlightSessionIds.delete(sessionId)
      setInFlight(false)
    }
  }, [sessionId, inFlight, setInFlight, applyHandoffResult])

  return { inFlight, startHandoff, applyHandoffResult }
}
