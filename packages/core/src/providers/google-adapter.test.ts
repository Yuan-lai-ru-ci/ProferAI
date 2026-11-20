import { describe, expect, test } from 'bun:test'
import { GoogleAdapter } from './google-adapter.ts'

describe('GoogleAdapter 思考请求协议', () => {
  for (const modelId of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-hydrogen-preview', 'gemini-2.5-pro']) {
    for (const thinkingEnabled of [true, false]) {
      test(`${modelId} thinking=${thinkingEnabled}`, () => {
        const request = new GoogleAdapter().buildStreamRequest({
          baseUrl: 'https://fixture.invalid', apiKey: 'offline', modelId,
          history: [], userMessage: '你好', readImageAttachments: () => [], thinkingEnabled,
        })
        const body = JSON.parse(request.body)
        if (!thinkingEnabled) expect(body.generationConfig).toBeUndefined()
        else expect(body.generationConfig.thinkingConfig).toEqual(modelId.startsWith('gemini-4-')
          ? { includeThoughts: true, thinkingLevel: 'HIGH' }
          : { includeThoughts: true, thinkingBudget: 16384 })
      })
    }
  }
})
