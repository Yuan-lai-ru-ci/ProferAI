import { describe, expect, test } from 'bun:test'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { closeCoreServer, createCoreServer, listenCoreServer } from './server'
import { createCoreAgentRuntime } from './runtime'
import { MOCK_AGENT_NOTICE } from './mock-agent'

async function requestJson(port: number, path: string, options: { method?: string; body?: unknown; apiKey?: string } = {}): Promise<{ statusCode: number | undefined; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = request({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ statusCode: response.statusCode, body: body ? JSON.parse(body) : undefined }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function withCoreServer(
  options: { debug?: boolean; mockAgent?: boolean },
  run: (context: { port: number; runtime: ReturnType<typeof createCoreAgentRuntime>; configDir: string }) => Promise<void>,
): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), 'profer-core-debug-'))
  const workspaceRoot = join(configDir, 'workspaces')
  const runtime = createCoreAgentRuntime({
    host: '127.0.0.1', port: 0, configDir, workspaceRoot,
    ...(options.mockAgent ? { mockAgent: true } : {}),
  })
  const server = createCoreServer({
    version: 'debug-test', runtime, apiKey: 'debug-secret',
    ...(options.debug ? { debug: { configDir, workspaceRoot, mockAgent: options.mockAgent === true, startedAt: Date.now() } } : {}),
  })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as AddressInfo).port
  try {
    await run({ port, runtime, configDir })
  } finally {
    await closeCoreServer(server)
    runtime.dispose()
    await rm(configDir, { recursive: true, force: true })
  }
}

describe('core debug surface', () => {
  test('serves debug state with sanitized channels and sessions', async () => {
    await withCoreServer({ debug: true, mockAgent: true }, async ({ port, runtime, configDir }) => {
      runtime.createChannel({ id: 'debug-channel', name: 'Debug', provider: 'anthropic', apiKey: 'secret-key' })
      runtime.sessions.create({ title: '调试会话', runtime: 'pi' })

      const unauthorized = await requestJson(port, '/debug/state')
      expect(unauthorized.statusCode).toBe(401)

      const response = await requestJson(port, '/debug/state', { apiKey: 'debug-secret' })
      expect(response.statusCode).toBe(200)
      const body = response.body as Record<string, unknown>
      expect(body.mockAgent).toBe(true)
      expect(body.channels).toEqual([{ id: 'debug-channel', name: 'Debug', provider: 'anthropic', enabled: true, models: 0 }])
      expect(JSON.stringify(body)).not.toContain('secret-key')
      expect((body.sessions as Array<Record<string, unknown>>).map(session => session.title)).toEqual(['调试会话'])
      expect((body.paths as Record<string, unknown>).workspaceRoot).toBe(join(configDir, 'workspaces'))
    })
  })

  test('is absent unless debug is enabled', async () => {
    await withCoreServer({}, async ({ port }) => {
      await expect(requestJson(port, '/debug/state', { apiKey: 'debug-secret' })).resolves.toEqual({ statusCode: 404, body: { error: 'not_found' } })
    })
  })

  test('requires explicit confirmation before resetting session data', async () => {
    await withCoreServer({ debug: true }, async ({ port, runtime }) => {
      const session = runtime.sessions.create({ title: '要被清理', runtime: 'pi' })
      expect(runtime.sessions.list()).toHaveLength(1)

      const rejected = await requestJson(port, '/debug/reset', { method: 'POST', apiKey: 'debug-secret', body: {} })
      expect(rejected).toEqual({ statusCode: 400, body: { error: 'confirm_required' } })
      expect(runtime.sessions.list()).toHaveLength(1)

      const reset = await requestJson(port, '/debug/reset', { method: 'POST', apiKey: 'debug-secret', body: { confirm: 'reset' } })
      expect(reset.statusCode).toBe(200)
      expect((reset.body as Record<string, unknown>).reset).toBe(true)
      expect(runtime.sessions.list()).toEqual([])
      expect(runtime.sessions.getMeta(session.id)).toBeUndefined()
    })
  })

  test('mock agent produces a synthetic reply without provider credentials', async () => {    await withCoreServer({ debug: true, mockAgent: true }, async ({ port, runtime }) => {
      const session = runtime.sessions.create({ title: 'mock run', runtime: 'pi', channelId: 'not-configured' })
      const startedAt = 1760000000999
      let echoedStartedAt: unknown
      const completed = new Promise<void>((resolve, reject) => {
        const unsubscribe = runtime.subscribe(event => {
          if (event.sessionId !== session.id || event.type !== 'runtime') return
          const payload = event.payload as { type?: string; startedAt?: unknown; outcome?: { status?: string; error?: string } } | undefined
          if (payload?.type === 'runtime_started') echoedStartedAt = payload.startedAt
          if (payload?.type !== 'runtime_finished') return
          unsubscribe()
          if (payload.outcome?.status === 'completed') resolve()
          else reject(new Error(payload.outcome?.error ?? `unexpected outcome: ${payload.outcome?.status}`))
        })
      })
      const accepted = await requestJson(port, `/sessions/${session.id}/messages`, {
        method: 'POST', apiKey: 'debug-secret', body: { prompt: '你好，调试内核', startedAt },
      })
      expect(accepted.statusCode).toBe(202)
      await completed
      expect(echoedStartedAt).toBe(startedAt)

      const persisted = JSON.stringify(runtime.sessions.readMessages(session.id))
      expect(persisted).toContain(MOCK_AGENT_NOTICE)
      expect(persisted).toContain('你好，调试内核')
    })
  }, 20000)
})
