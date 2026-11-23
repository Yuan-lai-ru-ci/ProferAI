import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLocalCoreOwner } from '../packages/session-store/src/execution-lock'
import type { CoreClient as DesktopCoreClient } from '../apps/electron/src/main/lib/core-client'

// 真实 CLI 和 Core 进程、Electron 主进程发送预检与 CoreClient；只有模型服务是替身。
test.skipIf(!['darwin', 'linux'].includes(process.platform))('CLI 配置与轮换后，桌面发送使用同一 Core、原会话和新 Key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-shared-channel-'))
  const cliEntry = join(import.meta.dir, '../apps/cli/src/index.ts')
  const coreEntry = join(import.meta.dir, '../apps/core/src/index.ts')
  const model = 'claude-sonnet-4-5'
  const initial = 'fixture-initial-key'
  const rotated = 'fixture-rotated-key'
  let expectedKey = initial
  const modelRequests: Array<{ keyMatches: boolean; prompt: string }> = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (new URL(req.url).pathname !== '/v1/messages') return new Response(null, { status: 404 })
    const body = await req.json() as { model?: string; messages?: Array<{ content?: unknown }>; stream?: boolean }
    const keyMatches = req.headers.get('x-api-key') === expectedKey || req.headers.get('authorization') === `Bearer ${expectedKey}`
    if (body.stream !== false) modelRequests.push({ keyMatches, prompt: JSON.stringify(body.messages?.at(-1)?.content ?? '') })
    if (!keyMatches || body.model !== model) return new Response(null, { status: 401 })
    const text = 'fixture-model-answer'
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    if (body.stream === false) return Response.json({ ...message, stop_reason: 'end_turn', content: [{ type: 'text', text }] })
    const frames = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const env = { PATH: process.env.PATH, HOME: root }
  const start = () => Bun.spawn([process.execPath, coreEntry, '--desktop-independent', '--config-dir', root], { env, stdout: 'ignore', stderr: 'pipe' })
  let child = start()
  let desktop: DesktopCoreClient | undefined
  const previousConfigDir = process.env.PROFER_CONFIG_DIR
  const previousSdkDir = process.env.CLAUDE_CONFIG_DIR
  const cli = async <T>(args: string[], input = ''): Promise<T> => {
    const command = Bun.spawn([process.execPath, cliEntry, ...args, '--config-dir', root, '--json'], {
      env, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([command.exited, command.stdout.text(), command.stderr.text()])
    if (code !== 0) throw new Error(`${args[0]} exited ${code}: ${stderr}`)
    expect(stdout + stderr).not.toContain(initial)
    expect(stdout + stderr).not.toContain(rotated)
    return JSON.parse(stdout) as T
  }
  const connect = async () => {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(await child.stderr.text())
      try { return readLocalCoreOwner(root) } catch { await Bun.sleep(25) }
    }
    throw new Error('临时 Core 未就绪')
  }
  try {
    process.env.PROFER_CONFIG_DIR = root
    const { CoreClient } = await import('../apps/electron/src/main/lib/core-client')
    const { prepareIndependentCoreMessage } = await import('../apps/electron/src/main/lib/core-local-bridge')
    const owner = await connect()
    const channel = await cli<{ id: string }>(['channel', 'add', '--name', 'fixture', '--provider', 'anthropic', '--model', model, '--base-url', provider.url.origin], initial)
    const first = await cli<{ sessionId: string; runId: string; status: string; text: string }>(['-p', 'cli-fixture', '--workspace', 'default', '--channel', channel.id])
    expect(first).toMatchObject({ status: 'completed', text: 'fixture-model-answer' })
    await cli(['channel', 'rotate-key', channel.id], rotated)
    await cli(['core', 'stop'])
    expect(await child.exited).toBe(0)
    expectedKey = rotated
    child = start()
    const restarted = await connect()
    expect(restarted.coreId).toBe(owner.coreId)
    desktop = new CoreClient({ baseUrl: `http://127.0.0.1:${restarted.port}`, token: restarted.token, reconnect: false })
    await desktop.connect()
    const { session } = await desktop.getSessionDetail(first.sessionId)
    if (!session.workspaceId) throw new Error('预期会话属于同一工作区')
    expect(await desktop.listChannels()).toMatchObject([{ id: channel.id, models: [{ id: model }] }])
    const input = { sessionId: session.id, workspaceId: session.workspaceId, channelId: channel.id, modelId: model, agentRuntime: 'pi' as const, userMessage: 'desktop-fixture' }
    const assertCurrent = () => { if (!desktop?.isConnected) throw new Error('测试桌面连接已断开') }
    const options = await prepareIndependentCoreMessage(input, desktop, assertCurrent)
    expect(options).not.toHaveProperty('credentials')
    const finished = Promise.withResolvers<{ runId?: string; outcomeStatus?: string }>()
    const unsubscribe = desktop.addEventListener(event => {
      const frame = event.payload as { event?: { type?: string; runId?: string; triggerId?: string; outcomeStatus?: string } } | undefined
      if (event.sessionId === session.id && frame?.event?.type === 'run_completed' && frame.event.triggerId === options.context?.trigger.id) finished.resolve(frame.event)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      expect(await desktop.sendMessage(session.id, input.userMessage, options, assertCurrent)).toMatchObject({ accepted: true, sessionId: first.sessionId })
      const result = await Promise.race([finished.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('未收到桌面终态')), 5000) })])
      expect(result.outcomeStatus).toBe('completed')
      expect(result.runId).not.toBe(first.runId)
      const history = await desktop.getMessages(session.id)
      expect(history.filter(row => (row as { type?: string }).type === 'user')).toHaveLength(2)
      expect(history).toContainEqual(expect.objectContaining({ type: 'result', subtype: 'success', _provenance: expect.objectContaining({ runId: result.runId }) }))
    } finally { clearTimeout(timer); unsubscribe() }
    for (const prompt of ['cli-fixture', 'desktop-fixture']) {
      expect(modelRequests.filter(item => item.prompt.includes(prompt))).toEqual([{ keyMatches: true, prompt: expect.stringContaining(prompt) }])
    }
  } finally {
    desktop?.close()
    if (previousConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
    else process.env.PROFER_CONFIG_DIR = previousConfigDir
    if (previousSdkDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousSdkDir
    if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited }
    provider.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
