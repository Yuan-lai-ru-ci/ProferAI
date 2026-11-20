#!/usr/bin/env bun
/** 仓库外、空 HOME/PATH 运行；只访问临时 mock 配置。 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function terminateRuntime(processHandle: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.platform !== 'win32') { processHandle.kill('SIGTERM'); return }
  // Windows 的 kill(SIGTERM) 不是可捕获的 POSIX 信号；与桌面生命周期一致终止整棵树。
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  const killer = Bun.spawn([taskkill, '/PID', String(processHandle.pid), '/T', '/F'], { stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await killer.exited, 0, await new Response(killer.stderr).text())
}

const root = mkdtempSync(join(tmpdir(), 'profer-core-smoke-'))
let child: ReturnType<typeof Bun.spawn> | undefined
let sdk: ReturnType<typeof Bun.spawn> | undefined
const sockets = new Set<WebSocket>()
const deadline = <T>(promise: Promise<T>, ms = 10000): Promise<T> => new Promise((yes, no) => {
  const timer = setTimeout(() => no(new Error('smoke 超时')), ms)
  promise.then(yes, no).finally(() => clearTimeout(timer))
})
try {
  const runtime = join(root, 'runtime')
  cpSync(resolve(process.argv[2] ?? join(import.meta.dir, '../dist')), runtime, { recursive: true })
  const cwd = join(root, 'cwd'); mkdirSync(cwd)
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port; listener.stop(true)
  const executable = join(runtime, process.platform === 'win32' ? 'profer-core.exe' : 'profer-core')
  const env = { PATH: '/nonexistent', HOME: root, PROFER_CORE_API_KEY: 'local-smoke-token', PROFER_CORE_WORKSPACE_ROOT: cwd }
  child = Bun.spawn([executable, '--mock-agent', '--config-dir', join(root, 'config'), '--listen', `127.0.0.1:${port}`], { cwd, env, stdout: 'inherit', stderr: 'inherit' })
  const url = `http://127.0.0.1:${port}`
  const request = (path: string, headers?: Record<string, string>) => fetch(url + path, { headers, signal: AbortSignal.timeout(3000) })
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { if ((await request('/health')).ok) { ready = true; break } } catch {}
    await Bun.sleep(100)
  }
  assert(ready)
  assert.equal((await request('/identity')).status, 401)
  const headers = { Authorization: 'Bearer local-smoke-token' }
  assert.equal((await request('/identity', headers)).status, 200)
  assert.deepEqual((await (await request('/sessions', headers)).json()).sessions, [])
  const connect = (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`); sockets.add(ws); return ws
  }
  await deadline(new Promise<void>((yes, no) => {
    const ws = connect('wrong')
    ws.onopen = () => no(new Error('WS 错误 token 被接受'))
    ws.onerror = () => yes()
    ws.onclose = () => yes()
  }))
  const ws = connect('local-smoke-token')
  await deadline(new Promise<void>((yes, no) => { ws.onopen = () => yes(); ws.onerror = () => no(new Error('WS 连接失败')) }))
  const frame = new Promise<Record<string, unknown>>((yes, no) => {
    ws.onmessage = event => { try { const value = JSON.parse(String(event.data)); if (value.requestId === 'smoke-resume') yes(value) } catch (error) { no(error) } }
  })
  ws.send(JSON.stringify({ requestId: 'smoke-resume', type: 'resume_agent_events', cursor: 0 }))
  const resumed = await deadline(frame)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.equal((resumed.data as { complete: boolean }).complete, true)
  console.log('[Core smoke] WS 鉴权/恢复', JSON.stringify(resumed))
  ws.close()
  const check = join(runtime, 'probe.mjs')
  await Bun.write(check, `import * as pi from '@earendil-works/pi-coding-agent'; import * as ai from '@earendil-works/pi-ai'; import * as photon from '@silvia-odwyer/photon-node'; import { createRequire } from 'node:module'; import { readdirSync } from 'node:fs'; import { join } from 'node:path';
const require = createRequire(import.meta.url);
const dir = join(import.meta.dir, 'node_modules/@earendil-works/pi-tui/native', process.platform, 'prebuilds', process.platform + '-' + process.arch);
const addons = readdirSync(dir).filter(name => name.endsWith('.node'));
if (!addons.length) throw new Error('缺少当前平台 native addon');
for (const addon of addons) { const native = require(join(dir, addon)); console.log('native loaded', addon, Object.keys(native).length); }
console.log('Pi/WASM exports', Object.keys(pi).length, Object.keys(ai).length, Object.keys(photon).length);`)
  sdk = Bun.spawn([executable, check], { cwd, env: { ...env, BUN_BE_BUN: '1' }, stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await deadline(sdk.exited), 0)
  await terminateRuntime(child)
  const exitCode = await deadline(child.exited)
  if (process.platform === 'win32') {
    assert.notEqual(exitCode, 0, 'Windows /F 是强制终止，不应冒充优雅退出')
    let stopped = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const released = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } })
        released.stop(true)
        stopped = true
        break
      } catch {}
      await Bun.sleep(100)
    }
    assert(stopped, 'Core launcher 已退出但监听进程仍存活')
    console.log('[Core smoke] 通过：HTTP/WS 鉴权、事件恢复、Pi/native/WASM、Windows 进程树强制终止及端口释放（非优雅退出）')
  } else {
    assert.equal(exitCode, 0)
    console.log('[Core smoke] 通过：HTTP/WS 鉴权、事件恢复、Pi/native/WASM、SIGTERM 正常退出')
  }
} finally {
  for (const ws of sockets) ws.close()
  if (sdk && sdk.exitCode === null) { sdk.kill('SIGKILL'); await sdk.exited }
  if (child && child.exitCode === null) {
    await terminateRuntime(child)
    try { await deadline(child.exited, 3000) } catch { child.kill('SIGKILL'); await child.exited }
  }
  rmSync(root, { recursive: true, force: true })
}
