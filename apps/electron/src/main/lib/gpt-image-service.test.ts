import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
}))

let credentials = { mode: 'official' as 'official' | 'byok', apiKey: '', baseUrl: '', model: '' }
let auth: { baseUrl: string; token: string; proxyToken?: string } | undefined = {
  baseUrl: 'https://team.example/', token: 'team-token', proxyToken: 'proxy-token',
}
let recoveredAuth: typeof auth = auth

mock.module('./chat-tool-config', () => ({ getGptImageCredentials: () => credentials }))
mock.module('./auth-service', () => ({
  getTeamAuthWithRefresh: async () => auth,
  recoverCommercialProxyAuth: async () => recoveredAuth,
}))

const { generateGptImage } = await import('./gpt-image-service')
const originalFetch = globalThis.fetch
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function response(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  credentials = { mode: 'official', apiKey: '', baseUrl: '', model: '' }
  auth = { baseUrl: 'https://team.example/', token: 'team-token', proxyToken: 'proxy-token' }
  recoveredAuth = auth
})

describe('generateGptImage', () => {
  test('official generation posts a fixed model JSON request with caller idempotency key', async () => {
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return response({ data: [{ b64_json: png.toString('base64') }] })
    }) as typeof fetch

    const result = await generateGptImage({ prompt: 'blue square', size: '1024x1024', quality: 'high', idempotencyKey: 'call-1' })

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://team.example/v1/proxy/images/generations')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer proxy-token')
    expect(calls[0]!.headers.get('idempotency-key')).toBe('call-1')
    expect(await calls[0]!.json()).toEqual({ model: 'gpt-image-2', prompt: 'blue square', size: '1024x1024', quality: 'high', n: 1 })
  })

  test('refreshes a stale relay token once and reuses the idempotency key', async () => {
    const calls: Request[] = []
    const freshAuth = { baseUrl: 'https://team.example/', token: 'fresh-team-token', proxyToken: 'fresh-proxy-token' }
    recoveredAuth = freshAuth
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      if (calls.length === 1) return response({ error: 'relay 令牌无效' }, 401)
      return response({ data: [{ b64_json: png.toString('base64') }] })
    }) as typeof fetch

    const result = await generateGptImage({ prompt: 'retry image', idempotencyKey: 'retry-key-1' })

    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer proxy-token')
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer fresh-proxy-token')
    expect(calls[0]!.headers.get('idempotency-key')).toBe('retry-key-1')
    expect(calls[1]!.headers.get('idempotency-key')).toBe('retry-key-1')
  })

  test('official edit uses multipart endpoint and caps references at four', async () => {
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return response({ data: [{ b64_json: png.toString('base64') }] })
    }) as typeof fetch
    const references = Array.from({ length: 5 }, (_, index) => ({ data: png.toString('base64'), mediaType: 'image/png', filename: `ref-${index}.png` }))

    const result = await generateGptImage({ prompt: 'edit', references, idempotencyKey: 'edit-1' })

    expect(result.ok).toBe(true)
    expect(calls[0]!.url).toBe('https://team.example/v1/proxy/images/edits')
    const form = await calls[0]!.formData()
    expect(form.getAll('image[]')).toHaveLength(4)
  })

  test('BYOK generation uses configured base URL, key and b64 response format', async () => {
    credentials = { mode: 'byok', apiKey: 'sk-test', baseUrl: 'https://byok.example/', model: 'custom-image' }
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push(new Request(input, init))
      return response({ data: [{ b64_json: png.toString('base64') }] })
    }) as typeof fetch

    const result = await generateGptImage({ prompt: 'cat', idempotencyKey: 'ignored-for-byok' })

    expect(result).toMatchObject({ ok: true, mode: 'byok', mediaType: 'image/png' })
    expect(calls[0]!.url).toBe('https://byok.example/v1/images/generations')
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sk-test')
    expect(await calls[0]!.json()).toMatchObject({ model: 'custom-image', response_format: 'b64_json', n: 1 })
  })

  test('downloads URL result with the BYOK bearer key', async () => {
    credentials = { mode: 'byok', apiKey: 'sk-download', baseUrl: 'https://byok.example', model: '' }
    const calls: Request[] = []
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return calls.length === 1
        ? response({ data: [{ url: 'https://cdn.example/image.png' }] })
        : new Response(png, { headers: { 'content-type': 'image/png' } })
    }) as typeof fetch

    const result = await generateGptImage({ prompt: 'from url', idempotencyKey: 'url-1' })

    expect(result).toMatchObject({ ok: true, mediaType: 'image/png' })
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer sk-download')
  })

  test('maps safe official error messages and never reports a success object for missing image bytes', async () => {
    globalThis.fetch = (async () => response({ error: { code: 'INSUFFICIENT_CREDITS' } }, 402)) as unknown as typeof fetch
    await expect(generateGptImage({ prompt: 'x', idempotencyKey: 'credits' })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('积分不足') })

    globalThis.fetch = (async () => response({ data: [{ b64_json: '' }] })) as unknown as typeof fetch
    await expect(generateGptImage({ prompt: 'x', idempotencyKey: 'empty' })).resolves.toMatchObject({ ok: false })
  })
})
