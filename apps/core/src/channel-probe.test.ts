import { afterEach, describe, expect, test } from 'bun:test'
import { discoverCoreModels, testCoreChannel } from './channel-probe'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Core channel probes', () => {
  test('discovers OpenAI-compatible models using the remote credential without returning it', async () => {
    const secret = 'remote-model-secret'
    let requestedUrl = ''
    let authorization = ''
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input)
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return Response.json({ data: [{ id: 'model-a' }] })
    }) as unknown as typeof fetch

    const result = await discoverCoreModels({ provider: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: secret })
    expect(result).toMatchObject({ success: true, models: [{ id: 'model-a', source: 'fetched' }] })
    expect(requestedUrl).toBe('https://api.example.test/v1/models')
    expect(authorization).toBe(`Bearer ${secret}`)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test('sanitizes provider errors and labels connectivity as model catalog access', async () => {
    const secret = 'do-not-leak'
    globalThis.fetch = (async () => { throw new Error(`request failed ${secret}`) }) as unknown as typeof fetch
    const result = await testCoreChannel({ provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: secret })
    expect(result.success).toBe(false)
    expect(result.message).not.toContain(secret)

    globalThis.fetch = (async () => Response.json({ data: [] })) as unknown as typeof fetch
    const success = await testCoreChannel({ provider: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: secret })
    expect(success).toEqual({ success: true, message: '模型目录连接成功' })
  })

  test('rejects OAuth-only Codex model discovery without a vendor request', async () => {
    let requested = false
    globalThis.fetch = (async () => { requested = true; return Response.json({ data: [] }) }) as unknown as typeof fetch
    const result = await discoverCoreModels({ provider: 'openai-codex', baseUrl: '', apiKey: '' })
    expect(result).toMatchObject({ success: false, models: [] })
    expect(requested).toBe(false)
  })
})
