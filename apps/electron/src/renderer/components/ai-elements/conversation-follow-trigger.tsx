import { useAtomValue } from 'jotai'
import { useEffect, useRef } from 'react'
import { conversationFollowIntentAtomFamily, consumeConversationFollowIntent } from '@/atoms/conversation-scroll-intents'
import { useConversationScroll } from './conversation-scroll'

/** 让同一消息区域创建的新并排段继承当前已消费的 intent 代次。 */
export function useConversationFollowIntentBaseline(sessionId: string, loaded: boolean): number {
  const intent = useAtomValue(conversationFollowIntentAtomFamily(sessionId))
  const baseline = useRef({ sessionId, consumedIntent: intent })
  const initialIntent = baseline.current.sessionId === sessionId ? baseline.current.consumedIntent : intent
  useEffect(() => {
    if (loaded || baseline.current.sessionId !== sessionId) {
      baseline.current = { sessionId, consumedIntent: intent }
    }
  }, [sessionId, intent, loaded])
  return initialIntent
}

/** 只有显式用户动作触发回到底部；历史刷新和后台续跑不夺取阅读位置。 */
export function ConversationFollowTrigger({ sessionId, loaded = true, active = true, initialIntent }: {
  sessionId: string
  loaded?: boolean
  active?: boolean
  /** 新并排段继承区域的消费基线，保留同次发送创建 tail 时的意图。 */
  initialIntent?: number
}): null {
  const { follow } = useConversationScroll()
  const intent = useAtomValue(conversationFollowIntentAtomFamily(sessionId))
  const baseline = useRef({ sessionId, consumedIntent: initialIntent ?? intent })

  useEffect(() => {
    const result = consumeConversationFollowIntent(baseline.current, sessionId, intent, loaded, active)
    baseline.current = result.baseline
    if (result.follow) follow()
  }, [sessionId, intent, loaded, active, follow])
  return null
}
