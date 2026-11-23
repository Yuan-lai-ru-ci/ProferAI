import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLocalCoreOwner } from '@profer/session-store/execution-lock'
import { readCoreChannelStore } from '../../../core/src/channel-store'

const entry = join(import.meta.dir, '../index.ts')
const coreEntry = join(import.meta.dir, '../../../core/src/index.ts')

test.skipIf(!['darwin', 'linux'].includes(process.platform))('终端在没有 Electron 的数据根创建并轮换模型渠道，重启后继续使用', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-cli-channel-'))
  const env = { PATH: process.env.PATH, HOME: root }
  let core = Bun.spawn([process.execPath, coreEntry, '--desktop-independent', '--config-dir', root], { env, stdout: 'ignore', stderr: 'pipe' })
  const binary = join(root, 'profer')
  const cliArgs = (args: string[]) => [binary, ...args, '--config-dir', root, '--json']
  const cli = async (args: string[], key = '') => {
    const child = Bun.spawn(cliArgs(args), { env, stdin: new Blob([key]), stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()])
    return { code, stdout, stderr }
  }
  const connect = async () => {
    for (let i = 0; i < 150; i++) {
      if (core.exitCode !== null) throw new Error(await core.stderr.text())
      try {
        const owner = readLocalCoreOwner(root)
        return async <T>(path: string, body?: object): Promise<T> => {
          const response = await fetch(`http://127.0.0.1:${owner.port}${path}`, {
            headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
            ...(body && { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
          })
          if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
          return await response.json() as T
        }
      } catch { await Bun.sleep(25) }
    }
    throw new Error('临时 Core 未就绪')
  }
  const oldKey = 'fixture-api-key-before-rotate'
  const nextKey = 'fixture-api-key-after-rotate'
  let receivedModelRequest = false
  const model = 'claude-sonnet-4-5'
  // 走真实 Pi adapter 与 HTTP，模型供应商由回环 SSE 替代；用请求头验证重启后实际加载的是新 Key。
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (new URL(req.url).pathname !== '/v1/messages') return new Response(null, { status: 404 })
    if (req.headers.get('x-api-key') !== nextKey && req.headers.get('authorization') !== `Bearer ${nextKey}`) return new Response(null, { status: 401 })
    const body = await req.json() as { model?: string }
    if (body.model !== model) return new Response(null, { status: 400 })
    receivedModelRequest = true
    const frames = [
      { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已通过回环模型验证' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const add = ['channel', 'add', '--name', '离线', '--provider', 'anthropic', '--model', model, '--base-url', provider.url.origin]
  try {
    const build = Bun.spawnSync([process.execPath, 'build', '--compile', '--outfile', binary, entry], { stdout: 'pipe', stderr: 'pipe' })
    if (build.exitCode !== 0) throw new Error(build.stderr.toString())
    await connect()
    expect(await cli(['channel', 'list'])).toMatchObject({ code: 0, stdout: '[]\n' })
    const noArgv = await cli([...add, '--api-key', 'never-print-this-fixture'])
    expect(noArgv).toMatchObject({ code: 2, stdout: '' })
    expect(noArgv.stderr).not.toContain('never-print-this-fixture')
    expect((await cli(add)).code).toBe(2)
    const oauth = await cli(add, '{"access":"fixture","refresh":"fixture","expires":1}\n')
    expect(oauth).toMatchObject({ code: 2, stdout: '' })
    expect(oauth.stderr).toContain('不接收 OAuth')
    expect(existsSync(join(root, 'channels.enc.json'))).toBe(false)
    const added = await cli(add, `${oldKey}\n`)
    expect(added).toMatchObject({ code: 0, stderr: '' })
    expect(added.stdout).not.toContain(oldKey)
    const channel = JSON.parse(added.stdout)
    expect(channel).toMatchObject({ name: '离线', provider: 'anthropic', agentRuntimes: ['pi', 'claude'], models: [{ id: model, enabled: true }] })
    expect(channel).not.toHaveProperty('apiKey')
    let terminalOutput = ''
    const terminal = new TextDecoder()
    const rotation = Bun.spawn(cliArgs(['channel', 'rotate-key', channel.id]), {
      env, terminal: { data(_term, chunk) { terminalOutput += terminal.decode(chunk, { stream: true }) } },
    })
    try {
      for (let i = 0; i < 100 && !terminalOutput.includes('API Key（输入隐藏）') && rotation.exitCode === null; i++) await Bun.sleep(20)
      expect(terminalOutput).toContain('API Key（输入隐藏）')
      rotation.terminal!.write(`${nextKey}\n`)
      expect(await rotation.exited).toBe(0)
      expect(terminalOutput).not.toContain(nextKey)
    } finally { if (rotation.exitCode === null) rotation.kill(); rotation.terminal?.close() }
    expect(readCoreChannelStore(root)).toMatchObject([{ id: channel.id, apiKey: nextKey }])
    expect(readFileSync(join(root, 'channels.enc.json'), 'utf8')).not.toContain(nextKey)
    expect(existsSync(join(root, 'channels.json'))).toBe(false)
    expect((await cli(['core', 'stop'])).code).toBe(0)
    expect(await core.exited).toBe(0)
    core = Bun.spawn([process.execPath, coreEntry, '--desktop-independent', '--config-dir', root], { env, stdout: 'ignore', stderr: 'pipe' })
    const restarted = await connect()
    expect(JSON.parse((await cli(['channel', 'list'])).stdout)).toEqual([channel])
    const result = await cli(['--model', model, '-p', '离线配置验收', '--workspace', 'default', '--channel', channel.id, '--runtime', 'pi'])
    expect(result).toMatchObject({ code: 0 })
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'completed', text: '已通过回环模型验证' })
    expect(receivedModelRequest).toBe(true)
    expect((await restarted<{ sessions: unknown[] }>('/sessions')).sessions).toMatchObject([{ channelId: channel.id, modelId: model, agentRuntime: 'pi' }])
    expect(await cli(['--continue', '-p', '不能覆盖原配置', '--workspace', 'default', '--model', model])).toMatchObject({ code: 2, stderr: expect.stringContaining('只用于新会话') })
    expect((await cli(['core', 'stop'])).code).toBe(0)
    expect(await core.exited).toBe(0)
  } finally {
    if (core.exitCode === null) { core.kill('SIGTERM'); await core.exited }
    provider.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)
