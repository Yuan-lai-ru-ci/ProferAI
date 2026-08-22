import type { AgentImageGenerationCard, SDKMessage } from '@profer/shared'
import type { MessageGroup } from './SDKMessageRenderer'

export type AgentTimelineItem =
  | { kind: 'group'; id: string; createdAt: number; group: MessageGroup }
  | { kind: 'image'; id: string; createdAt: number; card: AgentImageGenerationCard }

function messageCreatedAt(message: SDKMessage): number {
  const value = (message as Record<string, unknown>)._createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
}

export function agentMessageGroupCreatedAt(group: MessageGroup): number {
  if (group.type === 'assistant-turn') return group.createdAt ?? Number.MAX_SAFE_INTEGER
  return messageCreatedAt(group.message)
}

/**
 * Cards are intentionally transient status UI. Completed output is delivered by the
 * canonical PROMA_IMAGE_ATTACHMENT in the Agent reply; a failed attempt remains visible
 * in its existing tool audit trail rather than becoming a second conversation item.
 */
export function getPendingImageGenerationCards(cards: AgentImageGenerationCard[]): AgentImageGenerationCard[] {
  return cards.filter((card) => card.status === 'requesting' || card.status === 'saving')
}

/** Stable merge for desktop card timeline. Same timestamp deliberately keeps SDK group first. */
export function mergeAgentImageGenerationTimeline(
  groups: MessageGroup[],
  cards: AgentImageGenerationCard[],
  groupId: (group: MessageGroup) => string,
): AgentTimelineItem[] {
  const safeCards = cards.filter((card) => card.version === 1 && Number.isFinite(card.createdAt))
  const items: AgentTimelineItem[] = [
    ...groups.map((group) => ({ kind: 'group' as const, id: groupId(group), createdAt: agentMessageGroupCreatedAt(group), group })),
    ...safeCards.map((card) => ({ kind: 'image' as const, id: card.id, createdAt: card.createdAt, card })),
  ]
  return items.sort((a, b) => a.createdAt - b.createdAt || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'group' ? -1 : 1))
}
