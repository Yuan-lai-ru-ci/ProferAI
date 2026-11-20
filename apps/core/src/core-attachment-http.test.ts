import { expect, test } from 'bun:test'
import { request } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm, readFile, mkdir, symlink, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreAgentRuntime } from './runtime'
import { createCoreServer, listenCoreServer, closeCoreServer } from './server'
import { CORE_ATTACHMENT_BODY_MAX_BYTES } from './core-attachment-service'

async function fixture(run: (ctx: { runtime: ReturnType<typeof createCoreAgentRuntime>; root: string; base: string; port: number }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-attachment-http-'))
  const runtime = createCoreAgentRuntime({ host: '127.0.0.1', port: 0, configDir: join(root, 'config'), workspaceRoot: join(root, 'workspaces'), mockAgent: true })
  const server = createCoreServer({ version: 'fixture', runtime, apiKey: 'fixture-only' })
  await listenCoreServer(server, '127.0.0.1', 0)
  const port = (server.address() as { port: number }).port
  try { await run({ runtime, root, port, base: `http://127.0.0.1:${port}` }) }
  finally { await closeCoreServer(server); await runtime.shutdown(); await rm(root, { recursive: true, force: true }) }
}

function rawChunkedRequest(port: number, path: string, bytes: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const crlf = String.fromCharCode(13, 10)
    let data = Buffer.alloc(0), settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); socket.destroy()
      if (error) { reject(error); return }
      const text = data.toString('latin1'), split = text.indexOf(crlf + crlf)
      if (split < 0) { reject(new Error(`未收到完整HTTP头: ${text.slice(0, 200)}`)); return }
      resolve({ status: Number(text.slice(0, text.indexOf(crlf)).split(' ')[1]), body: text.slice(split + 4) })
    }
    const timer = setTimeout(() => finish(new Error('服务端未在chunk终止前响应超限')), 5000)
    socket.on('error', error => finish(error))
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      const text = data.toString('latin1'), head = text.split(crlf + crlf, 1)[0] ?? ''
      const length = Number(head.split(crlf).find(line => line.toLowerCase().startsWith('content-length:'))?.split(':')[1] ?? 0)
      const boundary = text.indexOf(crlf + crlf)
      if (boundary >= 0 && data.length >= boundary + 4 + length) finish()
    })
    socket.on('connect', () => {
      socket.write(`POST ${path} HTTP/1.1${crlf}Host: 127.0.0.1:${port}${crlf}Authorization: Bearer fixture-only${crlf}Content-Type: application/json${crlf}Transfer-Encoding: chunked${crlf}${crlf}`)
      socket.write(`${bytes.length.toString(16)}${crlf}`); socket.write(bytes); socket.write(crlf)
    })
  })
}

/** Content-Length请求提前拒绝；chunked帧由raw TCP发送后故意不发送终止帧。 */
function incompleteRequest(port: number, path: string, declaredLength?: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json',
      ...(declaredLength !== undefined ? { 'content-length': declaredLength } : {}) } }, response => {
      let body = ''
      response.on('data', chunk => { body += String(chunk) })
      response.on('end', () => { clearTimeout(timer); req.destroy(); resolve({ status: response.statusCode!, body }) })
    })
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Content-Length超限未及时响应')) }, 5000)
    req.on('error', error => { clearTimeout(timer); reject(error) })
    req.flushHeaders()
    req.write(Buffer.from('{'))
  })
}

test('附件HTTP在读取中按字节拒绝Content-Length及chunked超限，不等待end、不保存任何附件', async () => fixture(async ({ runtime, root, port }) => {
  const workspace = runtime.workspaces.createManaged('Fixture')
  const session = runtime.sessions.create({ title: 'Upload', workspaceId: workspace.id })
  let saves = 0
  const original = runtime.saveAttachment.bind(runtime)
  runtime.saveAttachment = (...args) => { saves++; return original(...args) }
  const path = `/sessions/${session.id}/attachments`
  expect((await incompleteRequest(port, path, CORE_ATTACHMENT_BODY_MAX_BYTES + 1)).status).toBe(413)
  const bytes = Buffer.from(`{"padding":"${'中'.repeat(Math.ceil(CORE_ATTACHMENT_BODY_MAX_BYTES / 3))}"}`)
  expect(bytes.length).toBeGreaterThan(CORE_ATTACHMENT_BODY_MAX_BYTES)
  expect((await rawChunkedRequest(port, path, bytes)).status).toBe(413)
  expect(saves).toBe(0)
  expect(existsSync(join(root, 'config', 'session-workspaces', session.id, 'attachments'))).toBe(false)
  expect(existsSync(join(root, 'config', 'agent-attachment-backups', session.id))).toBe(false)
}), 20000)

test('附件HTTP上传读回与会话隔离、删除守卫和链接拒绝；跨chunk中文文件名不损坏', async () => fixture(async ({ runtime, root, base, port }) => {
  const workspace = runtime.workspaces.createManaged('Fixture')
  const session = runtime.sessions.create({ title: 'Own', workspaceId: workspace.id })
  const other = runtime.sessions.create({ title: 'Other', workspaceId: workspace.id })
  const api = (sid: string) => `${base}/sessions/${sid}/attachments`
  const payload = { filename: '中文附件.txt', base64: Buffer.from('中文 fixture attachment').toString('base64') }
  const headers = { authorization: 'Bearer fixture-only', 'content-type': 'application/json' }
  expect((await fetch(api(session.id), { method: 'POST', body: JSON.stringify(payload) })).status).toBe(401)
  expect((await fetch(api('missing'), { method: 'POST', headers, body: JSON.stringify(payload) })).status).toBe(404)
  console.log('attachment-test: pre-upload complete')
  const encoded = Buffer.from(JSON.stringify(payload)), split = encoded.indexOf(Buffer.from('中')) + 1
  const uploaded = await new Promise<{ status: number; body: { path: string; filename: string; size: number } }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: `/sessions/${session.id}/attachments`, method: 'POST', headers }, response => {
      let data = ''; response.on('data', chunk => { data += String(chunk) })
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.write(encoded.subarray(0, split))
    setTimeout(() => req.end(encoded.subarray(split)), 15)
  })
  expect(uploaded.status).toBe(201)
  expect(uploaded.body.filename).toBe(payload.filename)
  expect(await readFile(uploaded.body.path, 'utf8')).toBe('中文 fixture attachment')
  const readUrl = (sid: string) => `${base}/sessions/${sid}/files/read?path=${encodeURIComponent(uploaded.body.path)}`
  const read = await fetch(readUrl(session.id), { headers })
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ base64: payload.base64, version: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) } })
  expect((await fetch(readUrl(other.id), { headers })).status).toBe(404)
  console.log('attachment-test: read and isolation complete')
  for (const body of [{ ...payload, filename: '../escape.txt' }, { ...payload, base64: 'invalid!' }, []]) expect((await fetch(api(session.id), { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(400)
  console.log('attachment-test: invalid bodies complete')
  const outside = join(root, 'outside'); await mkdir(outside)
  const workbench = join(root, 'config', 'session-workspaces', other.id)
  await mkdir(workbench, { recursive: true })
  const link = join(workbench, 'attachments')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  try { expect((await fetch(api(other.id), { method: 'POST', headers, body: JSON.stringify(payload) })).status).toBe(400) }
  finally { await unlink(link) }
  let release!: () => void, stopping = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const stop = runtime.coordinator.stopAndWait.bind(runtime.coordinator)
  runtime.coordinator.stopAndWait = async (...args) => { stopping = true; await gate; return stop(...args) }
  const deletion = runtime.deletions.request(session.id)
  console.log('attachment-test: deletion started')
  while (!stopping) await Bun.sleep(1)
  try {
    expect((await fetch(api(session.id), { method: 'POST', headers, body: JSON.stringify(payload) })).status).toBe(400)
  } finally { release() }
  await runtime.deletions.drain()
  expect(runtime.deletions.snapshot().find(record => record.id === deletion.requestId)?.status).toBe('completed')
  expect((await fetch(api(session.id), { method: 'POST', headers, body: JSON.stringify(payload) })).status).toBe(404)
}), 20000)
