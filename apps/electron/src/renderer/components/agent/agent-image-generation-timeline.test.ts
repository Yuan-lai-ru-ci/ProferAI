import { describe, expect, test } from 'bun:test'
import { agentMessageGroupCreatedAt, getPendingImageGenerationCards, mergeAgentImageGenerationTimeline } from './agent-image-generation-timeline'

const group = (id: string, createdAt: number) => ({ type: 'assistant-turn' as const, assistantMessages: [], turnMessages: [], createdAt })
const card = (id: string, createdAt: number) => ({ version: 1 as const, id, sessionId: 's', toolCallId: 't', status: 'succeeded' as const, prompt: 'x', size: 'auto' as const, quality: 'auto' as const, reference: { kind: 'none' as const }, image: { localPath: '/x.png', filename: 'x.png', mediaType: 'image/png' as const }, createdAt, updatedAt: createdAt })

describe('image generation timeline', () => {
  test('Given independent pending cards and message groups, when merged, then they sort chronologically and deterministically', () => {
    const timeline = mergeAgentImageGenerationTimeline([group('later', 30), group('first', 10)], [
      { ...card('middle', 20), status: 'requesting' as const },
      { ...card('same-time', 30), status: 'saving' as const },
    ], (item) => agentMessageGroupCreatedAt(item) === 30 ? 'later' : 'first')
    expect(timeline.map((item) => `${item.kind}:${item.id}`)).toEqual(['group:first', 'image:middle', 'group:later', 'image:same-time'])
  })

  test('Given succeeded or failed image records, when selecting timeline cards, then only live lifecycle states remain', () => {
    const cards = [
      { ...card('requesting', 1), status: 'requesting' as const },
      { ...card('saving', 2), status: 'saving' as const },
      card('succeeded', 3),
      { ...card('failed', 4), status: 'failed' as const },
    ]
    expect(getPendingImageGenerationCards(cards).map((item) => item.id)).toEqual(['requesting', 'saving'])
  })
})
