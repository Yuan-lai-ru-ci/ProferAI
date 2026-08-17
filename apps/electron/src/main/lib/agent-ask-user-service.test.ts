import { describe, expect, test } from 'bun:test'
import { AgentAskUserService } from './agent-ask-user-service'

describe('AgentAskUserService', () => {
  test('Given the renderer answers synchronously When notifying it of a question Then the answer resolves the pending request', async () => {
    const service = new AgentAskUserService()
    const controller = new AbortController()

    const result = service.handleAskUserQuestion(
      'session-1',
      { questions: [{ question: 'Continue?' }] },
      controller.signal,
      (request) => {
        expect(service.respondToAskUser(request.requestId, { 'Continue?': 'Yes' })).toBe('session-1')
      },
    )

    await expect(result).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [{ question: 'Continue?' }],
        answers: { 'Continue?': 'Yes' },
      },
    })
    expect(service.getPendingRequests()).toEqual([])
  })
})
