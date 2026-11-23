import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCoreExecutionLock, publishLocalCoreOwner } from '@profer/session-store/execution-lock'

test.skipIf(!['darwin', 'linux'].includes(process.platform))('终端在当前项目创建并续接 Core 会话，只输出本轮事件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-cli-run-'))
  const project = join(root, 'project')
  const cwd = join(project, 'src')
  mkdirSync(cwd, { recursive: true })
  const release = acquireCoreExecutionLock(root)
  const session = { id: 'session-1', workspaceId: 'project', updatedAt: 1 }
  let created = 0
  let messages = 0
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const commands: unknown[] = []
  let snapshot: Record<string, unknown> = { runs: [], pending: [] }
  let finishDuringSnapshot = false
  let disconnectAfterSnapshot = false
  const write = (value: unknown) => stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
  const writeRun = (payload: object) => write({ type: 'runtime', sessionId: session.id, payload })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, websocket: { message(ws, raw) {
    const { _cmdId, ...input } = JSON.parse(String(raw))
    if (input.type === 'core_snapshot') {
      if (finishDuringSnapshot) snapshot = { runs: [{ id: 'already-running', sessionRef: session.id, status: 'completed', finishedAt: Date.now() }], pending: [] }
      ws.send(JSON.stringify({ kind: 'command_result', commandId: _cmdId, ok: true, data: snapshot }))
      if (disconnectAfterSnapshot) stream?.close()
      return
    }
    commands.push(input)
    ws.send(JSON.stringify({ kind: 'command_result', commandId: _cmdId, ok: true, data: true }))
    writeRun({ type: 'runtime_finished', runId: input.runId, outcome: { status: 'completed' } })
  } }, fetch: async (req, server) => {
    if (req.headers.get('authorization') !== 'Bearer fixture-owner') return new Response(null, { status: 401 })
    switch (new URL(req.url).pathname) {
      case '/ws': if (server.upgrade(req)) return; return new Response(null, { status: 400 })
      case '/identity': return Response.json({ coreId: 'fixture', protocolVersion: 1 })
      case '/workspaces': return Response.json({ workspaces: [{ id: 'project', slug: 'project', rootPath: realpathSync(project) }] })
      case '/sessions': return Response.json({ sessions: [session] })
      case '/sessions/configured': {
        const body = await req.json() as { workspaceId?: string }
        if (body.workspaceId !== 'project') return new Response(null, { status: 400 })
        created++
        return Response.json(session)
      }
      case '/sessions/session-1/detail': return Response.json({ session, active: false })
      case '/sessions/session-1/events': return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller
        write({ type: 'ready', sessionId: session.id })
      }, cancel() { stream = undefined } }), { headers: { 'content-type': 'text/event-stream' } })
      case '/sessions/session-1/messages': {
        if (req.method === 'GET') return Response.json({ messages: [
          { type: 'assistant', uuid: 'old', _provenance: { runId: 'unrelated' }, message: { content: [{ type: 'text', text: 'old unrelated text' }] } },
          { type: 'assistant', uuid: 'saved', _provenance: { runId: 'already-running' }, message: { content: [{ type: 'text', text: 'persisted reply' }] } },
        ] })
        if (!stream) return new Response(null, { status: 409 })
        const { uuid, prompt, context } = await req.json() as { uuid: string; prompt: string; context: { trigger: { id: string } } }
        if (!uuid || context.trigger.id !== `message:${session.id}:${uuid}`) return new Response(null, { status: 400 })
        messages++
        const frame = writeRun
        frame({ type: 'runtime_finished', triggerId: 'unrelated', runId: 'other', outcome: { status: 'completed' } })
        frame({ type: 'runtime_started', triggerId: context.trigger.id, runId: `run-${messages}` })
        if (prompt === '断线') {
          stream.close()
          return Response.json({ accepted: true }, { status: 202 })
        }
        if (prompt === '权限' || prompt === '询问') {
          frame({ type: 'runtime', event: { type: prompt === '权限' ? 'permission_request' : 'ask_user_request', request: {
            requestId: `req-${messages}`, runId: `run-${messages}`, sessionId: session.id, toolName: 'Fixture', toolInput: { name: 'example' },
            questions: [{ question: '颜色？', options: [{ label: '蓝' }] }],
          } } })
          return Response.json({ accepted: true }, { status: 202 })
        }
        frame({ type: 'runtime', runId: 'other', event: { type: 'permission_request', request: { runId: 'other', sessionId: session.id } } })
        frame({ type: 'message', runId: `run-${messages}`, message: { type: 'assistant', uuid: `m${messages}`, _partial: true, message: { content: [{ type: 'text', text: 'preview' }] } } })
        if (prompt === '预览') await Bun.sleep(120)
        frame({ type: 'message', runId: `run-${messages}`, message: { type: 'assistant', uuid: `m${messages}`, message: { content: [{ type: 'text', text: `reply ${prompt}` }] } } })
        frame({ type: 'runtime_finished', runId: `run-${messages}`, outcome: { status: 'completed' } })
        return Response.json({ accepted: true }, { status: 202 })
      }
      default: return new Response(null, { status: 404 })
    }
  } })
  const remove = publishLocalCoreOwner(root, { version: 1, port: server.port!, pid: process.pid, coreId: 'fixture', token: 'fixture-owner' })
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'), ...args, '--config-dir', root], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()])
    return { code, stdout, stderr }
  }
  try {
    const first = await run('-p', '第一轮', '--output-format', 'stream-json')
    expect(first).toMatchObject({ code: 0, stderr: `会话：${session.id}\n` })
    const events = first.stdout.trim().split('\n').map(line => JSON.parse(line))
    expect(events.map(event => event.type)).toEqual(['start', 'assistant', 'assistant', 'result'])
    expect(events.at(-1)).toMatchObject({ runId: 'run-1', sessionId: session.id, text: 'reply 第一轮', status: 'completed' })
    const second = await run('--continue', '-p', '第二轮', '--json')
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ runId: 'run-2', sessionId: session.id, text: 'reply 第二轮' })
    const third = await run('--resume', session.id, '-p', '第三轮')
    expect(third).toMatchObject({ code: 0, stdout: 'reply 第三轮\n' })
    const disconnected = await run('--resume', session.id, '-p', '断线', '--output-format', 'stream-json')
    expect(disconnected).toMatchObject({ code: 1, stderr: expect.stringContaining('不会自动重发') })
    expect(disconnected.stdout.trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['start'])
    expect({ created, messages }).toEqual({ created: 1, messages: 4 })
    const noninteractive = await run('--resume', session.id, '-p', '权限')
    expect(noninteractive).toMatchObject({ code: 1, stderr: expect.stringContaining('permission_request') })
    expect(commands).toEqual([])
    const decoder = new TextDecoder()
    let out = ''
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'), '--resume', session.id, '--config-dir', root], {
      cwd, terminal: { data(_terminal, data) { out += decoder.decode(data, { stream: true }) } },
    })
    async function at(prompt: string) {
      for (let count = 0; count < 150; count++) {
        const index = out.indexOf(prompt)
        if (index >= 0) { out = out.slice(index + prompt.length); return }
        if (child.exitCode !== null) break
        await Bun.sleep(20)
      }
      throw new Error(`没有收到 ${prompt}：${out}`)
    }
    try {
      await at('profer> ')
      child.terminal!.write('权限\n')
      await at('[y/N] ')
      child.terminal!.write('y\n')
      await at('profer> ')
      child.terminal!.write('权限\n')
      await at('[y/N] ')
      child.terminal!.write('\n')
      await at('profer> ')
      child.terminal!.write('询问\n')
      await at('回答：')
      child.terminal!.write('蓝\n')
      await at('profer> ')
      child.terminal!.write('预览\n')
      await at('… preview')
      await at('reply 预览')
      await at('profer> ')
      child.terminal!.write('/exit\n')
      expect(await child.exited).toBe(0)
      expect(commands).toEqual([
        { requestId: 'req-6', sessionId: session.id, runId: 'run-6', type: 'respond_permission', behavior: 'allow' },
        { requestId: 'req-7', sessionId: session.id, runId: 'run-7', type: 'respond_permission', behavior: 'deny' },
        { requestId: 'req-8', sessionId: session.id, runId: 'run-8', type: 'respond_ask_user', answers: { '颜色？': '蓝' } },
      ])
    } finally { if (child.exitCode === null) child.kill(); child.terminal?.close() }
    const pendingPermission = { requestId: 'existing-request', sessionId: session.id, runId: 'already-running', toolName: 'Fixture', toolInput: { name: 'example' } }
    snapshot = { runs: [{ id: 'already-running', sessionRef: session.id, status: 'waiting' }], pending: [{ sessionId: session.id,
      permissions: [pendingPermission], askUsers: [], exitPlans: [] }] }
    async function attach(mode: 'local' | 'peer' | 'finished' | 'disconnect') {
      finishDuringSnapshot = mode === 'finished'
      disconnectAfterSnapshot = mode === 'disconnect'
      out = ''
      const resumed = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'), '--resume', session.id, '--config-dir', root], {
        cwd, terminal: { data(_terminal, data) { out += decoder.decode(data, { stream: true }) } },
      })
      async function waitFor(marker: string) {
        for (let i = 0; i < 100; i++) {
          if (out.includes(marker)) return
          if (resumed.exitCode !== null) break
          await Bun.sleep(20)
        }
        throw new Error(`没有收到 ${marker}：${out}`)
      }
      const before = messages
      try {
        if (mode === 'finished') {
          await waitFor('profer> ')
          expect(out).toContain('already-running')
          expect(out).toContain('persisted reply')
          expect(out).not.toContain('old unrelated text')
          expect(out).not.toContain('[y/N] ')
        } else if (mode === 'disconnect') {
          await waitFor('不会自动重发')
          expect(await resumed.exited).toBe(1)
          expect(messages).toBe(before)
          return
        } else {
          await waitFor('[y/N] ')
          expect(out).toContain('already-running')
        }
        if (mode === 'peer') {
          const beforeCommands = commands.length
          writeRun({ event: { type: 'permission_resolved', requestId: pendingPermission.requestId } })
          writeRun({ type: 'runtime_finished', runId: pendingPermission.runId, outcome: { status: 'completed' } })
          await waitFor('profer> ')
          expect(commands.length).toBe(beforeCommands)
        } else if (mode === 'local') {
          resumed.terminal!.write('y\n')
          await waitFor('profer> ')
          expect(commands.at(-1)).toMatchObject({ type: 'respond_permission', runId: 'already-running', requestId: 'existing-request', behavior: 'allow' })
        }
        resumed.terminal!.write('/exit\n')
        expect(await resumed.exited).toBe(0)
        expect(messages).toBe(before)
      } finally { if (resumed.exitCode === null) resumed.kill(); resumed.terminal?.close() }
    }
    await attach('local')
    await attach('peer')
    await attach('disconnect')
    await attach('finished')
  } finally { server.stop(true); remove(); release(); rmSync(root, { recursive: true, force: true }) }
}, 10000)
