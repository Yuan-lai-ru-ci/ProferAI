import type { ConversationMeta } from '@profer/shared'

/** 恢复快照必须绑定广播时的目标及连接代次，空目录也不能省略归属。 */
export interface CoreChatSnapshot {
  targetId: string
  generation: number
  conversations: ConversationMeta[]
  activeRuns: Array<{ conversationId: string; runId: string }>
}
