import { describe, expect, test } from 'bun:test'
import { mergeAgentImageGenerationTimeline } from './agent-image-generation-timeline'

const group = (id: string, createdAt: number) => ({ type: 'assistant-turn' as const, assistantMessages: [], turnMessages: [], createdAt })
const card = (id: string, createdAt: number) => ({ version: 1 as const, id, sessionId: 's', toolCallId: 't', status: 'succeeded' as const, prompt: 'x', size: 'auto' as const, quality: 'auto' as const, reference: { kind: 'none' as const }, image: { localPath: '/x.png', filename: 'x.png', mediaType: 'image/png' as const }, createdAt, updatedAt: createdAt })

describe('image generation timeline', () => {
  test('Given independent cards and message groups, when merged, then they sort chronologically and deterministically', () => {
    const timeline = mergeAgentImageGenerationTimeline([group('later', 30), group('first', 10)], [card('middle', 20), card('same-time', 30)], (item) => item.createdAt === 30 ? 'later' : 'first')
    expect(timeline.map((item) => `${item.kind}:${item.id}`)).toEqual(['group:first', 'image:middle', 'group:later', 'image:same-time'])
  })
})
