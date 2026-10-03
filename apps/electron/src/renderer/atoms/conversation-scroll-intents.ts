import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

/** renderer 用户动作的代次；消息刷新、后台续跑及请求清理不写入。 */
export const conversationFollowIntentAtomFamily = atomFamily((_sessionId: string) => atom(0))

export const requestConversationFollowAtom = atom(null, (get, set, sessionId: string) => {
  const intent = conversationFollowIntentAtomFamily(sessionId)
  set(intent, get(intent) + 1)
})

export interface ConversationFollowBaseline {
  sessionId: string
  consumedIntent: number
}

/** 首次订阅只建基线；加载期间的新动作延后消费，旧并排段直接吸收代次。 */
export function consumeConversationFollowIntent(
  baseline: ConversationFollowBaseline,
  sessionId: string,
  intent: number,
  loaded: boolean,
  active: boolean,
): { baseline: ConversationFollowBaseline; follow: boolean } {
  if (sessionId !== baseline.sessionId || !active) {
    return { baseline: { sessionId, consumedIntent: intent }, follow: false }
  }
  if (!loaded) return { baseline, follow: false }
  return {
    baseline: { sessionId, consumedIntent: intent },
    follow: intent > baseline.consumedIntent,
  }
}
