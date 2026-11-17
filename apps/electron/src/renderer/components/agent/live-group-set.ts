import type { SDKMessage } from '@profer/shared'
import type { MessageGroup } from './SDKMessageRenderer'

interface BuildLiveGroupSetOptions {
  allGroups: MessageGroup[]
  liveMessages?: readonly SDKMessage[] | null
  streaming: boolean
}

const EMPTY_LIVE_GROUPS: ReadonlySet<MessageGroup> = new Set<MessageGroup>()

/**
 * 只有会话仍在流式输出时，liveMessages 才代表“运行中的消息”。
 * 流式结束后它只是防闪烁桥接数据，不应继续触发展开态、隐藏操作栏等 live UI。
 */
export function buildLiveGroupSet({
  allGroups,
  liveMessages,
  streaming,
}: BuildLiveGroupSetOptions): ReadonlySet<MessageGroup> {
  if (!streaming || !liveMessages || liveMessages.length === 0) return EMPTY_LIVE_GROUPS

  const liveSet = new Set<SDKMessage>(liveMessages)
  const result = new Set<MessageGroup>()

  for (const group of allGroups) {
    if (group.type === 'user' || group.type === 'system') {
      if (liveSet.has(group.message as SDKMessage)) {
        result.add(group)
      }
      continue
    }

    // assistant-turn 可能被 mergeAdjacentTurns 合并，
    // 需检查任意一条 assistantMessage 是否来自实时流。
    if (group.assistantMessages.some((message) => liveSet.has(message as SDKMessage))) {
      result.add(group)
    }
  }

  return result
}

/**
 * 当前这一轮（最后一条用户消息之后）是否已经有可渲染的 assistant 内容。
 *
 * 流式兜底气泡只在「本轮还什么都没画出来」时才需要带头像；一旦本轮已有
 * assistant-turn（哪怕只有工具调用），再画一个带头像的气泡就会让同一条用户消息
 * 看起来有两个模型回复——即「说一句话出现两个模型头像」。
 *
 * 只按分组结构判断，不依赖 liveMessages / 运行起点：落盘水位与实时缓冲不同步时
 * 这两个信号都会短暂失真。system 分组（压缩分隔、通知等）不算内容，跳过。
 */
export function hasAssistantTurnInCurrentTurn(groups: MessageGroup[]): boolean {
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!
    if (group.type === 'system') continue
    return group.type === 'assistant-turn'
  }
  return false
}

/**
 * 找出最后一条用户消息之后是否还有 assistant 输出。
 *
 * 「已被用户中断」badge 挂在「被中断的那一轮」上；当被中断的一轮没有任何 assistant
 * 输出（用户刚发出消息就点停止）时，磁盘上不存在新的 assistant-turn，
 * `allGroups.findLast(assistant-turn)` 会错误地指向上一个有内容的轮次。
 * 这里按分组结构判断最后一条用户消息之后是否真的有助手输出，没有则说明
 * 中断发生在空轮上，badge 不应该渲染。
 */
export function hasAssistantOutputAfterLastUser(groups: MessageGroup[]): boolean {
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!
    if (group.type === 'system') continue
    if (group.type === 'user') return false
    return true
  }
  return false
}

/**
 * 找出当前这一轮正在流式输出的 assistant-turn。
 *
 * 实时消息与持久化副本合并后，对象身份并不总是能对上（重新落盘、外置内容替换等），
 * 只靠 `liveGroupSet` 会让「正在输出的那一轮」掉出 live 态：过程区不再自动展开、
 * 操作栏提前出现——子会话页尤其明显，表现成「一直在折叠、看不出在运行」。
 *
 * 这里补一条时间判据：本轮运行起点之后产生的 assistant 消息所属的最后一轮，
 * 也算 live。起点缺失时不猜，保持原行为。
 */
export function findStreamingTurnGroup(input: {
  allGroups: MessageGroup[]
  liveGroupSet: ReadonlySet<MessageGroup>
  streaming: boolean
  runStartedAt?: number
}): MessageGroup | null {
  if (!input.streaming) return null
  const lastTurn = [...input.allGroups]
    .reverse()
    .find((group): group is Extract<MessageGroup, { type: 'assistant-turn' }> => group.type === 'assistant-turn')
  if (!lastTurn) return null
  if (input.liveGroupSet.has(lastTurn)) return lastTurn

  const startedAt = input.runStartedAt
  if (typeof startedAt !== 'number') return null
  const belongsToRun = lastTurn.assistantMessages.some((message) => {
    const createdAt = (message as { _createdAt?: unknown })._createdAt
    return typeof createdAt === 'number' && createdAt >= startedAt
  })
  return belongsToRun ? lastTurn : null
}
