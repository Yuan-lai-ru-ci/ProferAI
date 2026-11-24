import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listNativePiRewindSessionIds } from './native-session-pi'
import { CoreNativeSessionService, nativeSessionRevision, type NativeSessionState } from './native-session-service'

test('启动扫描只读取有回退日志的原生会话，不打开普通或损坏历史', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-rewind-scan-'))
  const directory = join(root, 'sdk-config/sessions/pi')
  mkdirSync(directory, { recursive: true })
  try {
    writeFileSync(join(directory, 'ordinary.jsonl'), 'invalid historical header')
    expect([...listNativePiRewindSessionIds(root)]).toEqual([])
    writeFileSync(join(directory, 'pending.jsonl'), JSON.stringify({ type: 'session', id: 'native-pending' }) + '\n')
    writeFileSync(join(directory, 'pending.jsonl.profer-rewind.json'), '{}')
    expect([...listNativePiRewindSessionIds(root)]).toEqual(['native-pending'])
    writeFileSync(join(directory, 'broken.jsonl.profer-rewind.json'), '{}')
    expect(() => listNativePiRewindSessionIds(root)).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32')('启动扫描拒绝越出 Core 根的原生目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-rewind-boundary-'))
  const outside = mkdtempSync(join(tmpdir(), 'core-rewind-outside-'))
  try {
    symlinkSync(outside, join(root, 'pi-sessions'))
    expect(() => listNativePiRewindSessionIds(root)).toThrow('越出')
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

test('扫描命中的真实回退事务仍恢复；损坏事务保留并拒绝启动', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-rewind-recovery-'))
  const directory = join(root, 'sdk-config/sessions/pi')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'pending.jsonl')
  const journal = `${file}.profer-rewind.json`
  const original = JSON.stringify({ type: 'session', id: 'native-pending' }) + '\n'
  const replacement = original + JSON.stringify({ type: 'message', id: 'changed' }) + '\n'
  const state: NativeSessionState = { meta: { id: 'app-session', title: 'fixture', agentRuntime: 'pi', sdkSessionId: 'native-pending', createdAt: 1, updatedAt: 1 }, messages: [] }
  const service = new CoreNativeSessionService({ read: () => state, busy: () => false, projectMode: () => false,
    locate: () => ({ file: realpathSync(file), cwd: root, sessionDir: directory }), commit: () => { throw new Error('unexpected commit') }, createFork: () => { throw new Error('unexpected fork') } })
  try {
    writeFileSync(file, replacement)
    writeFileSync(journal, JSON.stringify({ schema: 1, sessionId: state.meta.id, expected: nativeSessionRevision(state), original, replacement, messages: [], patch: {} }))
    expect(listNativePiRewindSessionIds(root).has(state.meta.sdkSessionId!)).toBe(true)
    service.recoverPi(state.meta.id, root)
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(existsSync(journal)).toBe(false)
    writeFileSync(journal, '{}')
    expect(listNativePiRewindSessionIds(root).has(state.meta.sdkSessionId!)).toBe(true)
    expect(() => service.recoverPi(state.meta.id, root)).toThrow('损坏')
    expect(readFileSync(journal, 'utf8')).toBe('{}')
    expect(readFileSync(file, 'utf8')).toBe(original)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32')('1700 个历史 Pi 会话无待恢复事务时，真实 Core 在健康检查预算内就绪', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-history-start-'))
  const directory = join(root, 'sdk-config/sessions/pi')
  mkdirSync(directory, { recursive: true })
  const sessions = Array.from({ length: 1700 }, (_, i) => {
    const id = crypto.randomUUID(), sdkSessionId = crypto.randomUUID()
    writeFileSync(join(directory, `${i}.jsonl`), JSON.stringify({ type: 'session', version: 3, id: sdkSessionId, cwd: root }) + '\n')
    return { id, sdkSessionId, title: 'history fixture', agentRuntime: 'pi', workspaceId: 'default', createdAt: 1, updatedAt: 1 }
  })
  writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }))
  writeFileSync(join(root, 'agent-workspaces.json'), JSON.stringify({ version: 4, workspaces: [{ id: 'default', name: 'Default', slug: 'default', storageMode: 'managed', createdAt: 1, updatedAt: 1 }] }))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts'), '--mock-agent', '--desktop-independent', '--config-dir', root], {
    env: { ...process.env, PROFER_CORE_LISTEN: '127.0.0.1:0', PROFER_CORE_API_KEY: 'history-fixture', PROFER_CORE_CHANNELS_JSON: '[]' }, stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const output = new Response(child.stdout).text()
    let ready = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const owner = JSON.parse(await Bun.file(join(root, '.core-owner.json')).text())
        ready = (await fetch(`http://127.0.0.1:${owner.port}/health`, { signal: AbortSignal.timeout(300) })).ok
        if (ready) break
      } catch {}
      await Bun.sleep(50)
    }
    expect(ready).toBe(true)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
    expect(await output).toContain('[Core] listening')
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
