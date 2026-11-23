import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCoreExecutionLock, publishLocalCoreOwner, readLocalCoreOwner } from '@profer/session-store/execution-lock'
import { LocalCoreLifecycle, resolveCoreLaunchSpec } from './core-lifecycle'

describe('Core lifecycle launch selection', () => {
  test('打包资源携带完整运行目录且启动入口定位 resources/bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'core-packaged-contract-'))
    try {
      mkdirSync(join(root, 'bin'))
      const binary = join(root, 'bin', process.platform === 'win32' ? 'profer-core.exe' : 'profer-core')
      writeFileSync(binary, '')
      expect(resolveCoreLaunchSpec({ packaged: true, resourcesPath: root, env: {} })).toEqual({ command: binary, args: [] })
      const config = readFileSync(join(import.meta.dir, '../../../electron-builder.yml'), 'utf8')
      expect(config).toContain('from: ../core/dist')
      for (const asset of ['profer-core', 'core.js', 'core-runtime.json', 'node_modules/**/*']) expect(config).toContain(`- ${asset}`)
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'))
      expect(pkg.scripts.build).toContain('bun run build:core')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('uses an explicitly configured Core executable', () => {
    expect(resolveCoreLaunchSpec({ coreBinary: 'C:/tools/profer-core.exe', packaged: true })).toEqual({
      command: 'C:/tools/profer-core.exe',
      args: [],
    })
  })

  test('requires a packaged Core binary instead of depending on a developer Bun install', () => {
    expect(() => resolveCoreLaunchSpec({ packaged: true, resourcesPath: 'C:/missing/resources' })).toThrow('缺少 Profer Core 二进制')
  })

  test('reports a missing executable as a rejected startup instead of an uncaught child error', async () => {
    const lifecycle = new LocalCoreLifecycle({
      configDir: process.cwd(),
      workspaceRoot: process.cwd(),
      coreBinary: 'C:/profer-nonexistent-core-probe/core-missing.exe',
      fetchImpl: async () => { throw new Error('not listening') },
      healthTimeoutMs: 1_000,
    })
    await expect(lifecycle.start()).rejects.toThrow('ENOENT')
    await lifecycle.stop()
  })

  test('启动失败报告error；修复启动入口后可重试，停止及重启状态真实', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-core-recovery-'))
    const states: string[] = []
    const options = { configDir: root, workspaceRoot: join(root, 'workspaces'),
      coreBinary: '/nonexistent/profer-core-recovery', bunCommand: process.execPath,
      healthTimeoutMs: 1000, onStatus: (status: string) => { states.push(status) } }
    const lifecycle = new LocalCoreLifecycle(options)
    try {
      await expect(lifecycle.start()).rejects.toThrow()
      expect(states.at(-1)).toBe('error')
      options.coreBinary = ''
      const [first, second] = await Promise.all([lifecycle.start(), lifecycle.start()])
      expect(first).toBe(second)
      expect(states.at(-1)).toBe('ready')
      await lifecycle.stop()
      expect(states.at(-1)).toBe('stopped')
      await lifecycle.start()
      expect(states.at(-1)).toBe('ready')
    } finally { await lifecycle.stop(); rmSync(root, { recursive: true, force: true }) }
  }, 20000)

  test('自身 Core 子进程收到桌面索引配置，并读取启动后新增工作区', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-local-core-index-'))
    const lifecycle = new LocalCoreLifecycle({ configDir: root, workspaceRoot: join(root, 'agent-workspaces'), bunCommand: process.execPath })
    try {
      const legacy = { id: 'legacy-fixture', name: 'Legacy paused', prompt: 'offline fixture', active: false, scheduleType: 'interval', intervalMinutes: 60,
        channelId: 'fixture', createdAt: 1, updatedAt: 2, nextRunAt: 12345, runHistory: [] }
      const source = JSON.stringify({ version: 4, automations: [legacy], triggers: [] })
      writeFileSync(join(root, 'automations.json'), source)
      const started = await lifecycle.start()
      const imported = await started.client.automationRequest<import('@profer/shared').Automation[]>('list')
      expect(imported[0]).toMatchObject({ id: legacy.id, active: false, nextRunAt: 12345, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      expect(readFileSync(join(root, 'automations.json'), 'utf8')).toBe(source)
      const created = await started.client.createManagedWorkspace('Created by Core')
      expect((await started.client.listWorkspaces())[0]?.id).toBe(created.id)
      expect(JSON.parse(readFileSync(join(root, 'agent-workspaces.json'), 'utf8')).version).toBe(4)
      expect(existsSync(join(root, 'workspaces.json'))).toBe(false)
      const workspace = { id: 'desktop-added', name: 'Desktop', slug: 'desktop', createdAt: 1, updatedAt: 1 }
      const index = JSON.parse(readFileSync(join(root, 'agent-workspaces.json'), 'utf8')) as { version: number; workspaces: unknown[] }
      writeFileSync(join(root, 'agent-workspaces.json'), JSON.stringify({ ...index, workspaces: [...index.workspaces, workspace] }))
      expect((await started.client.listWorkspaces()).map(item => item.id)).toContain('desktop-added')
    } finally {
      await lifecycle.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)

  test('已有桌面工作区、Claude/Pi会话与消息在默认 Core 启动后原位接续', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-core-existing-profile-'))
    const workspaceRoot = join(root, 'agent-workspaces')
    const workspace = { id: 'existing-workspace', name: 'Existing', slug: 'default', createdAt: 1, updatedAt: 2, type: 'personal' }
    const sessions = ['claude', 'pi'].map(agentRuntime => ({ id: `existing-${agentRuntime}`, title: `Existing ${agentRuntime}`, agentRuntime,
      agentRuntimeLocked: false, workspaceId: workspace.id, createdAt: 1, updatedAt: 2, customField: 'keep' }))
    const messages = `${JSON.stringify({ type: 'user', uuid: 'existing-turn', message: { role: 'user', content: 'existing history' } })}\n`
    mkdirSync(join(workspaceRoot, 'default'), { recursive: true })
    mkdirSync(join(root, 'agent-sessions'))
    const workspaceIndex = JSON.stringify({ version: 4, workspaces: [workspace], customMetadata: 'preserve' })
    writeFileSync(join(root, 'agent-workspaces.json'), workspaceIndex)
    writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }))
    for (const session of sessions) writeFileSync(join(root, 'agent-sessions', `${session.id}.jsonl`), messages)
    const obsoleteSettings = JSON.stringify({ version: 1, enabled: false })
    writeFileSync(join(root, 'core-local-settings.json'), obsoleteSettings)
    const lifecycle = new LocalCoreLifecycle({ configDir: root, workspaceRoot, bunCommand: process.execPath })
    try {
      const { client } = await lifecycle.start()
      expect(await client.listWorkspaces()).toContainEqual(expect.objectContaining({ id: workspace.id, slug: 'default' }))
      for (const session of sessions) {
        expect((await client.listSessions()).find(value => value.id === session.id)).toMatchObject(session)
        expect(JSON.stringify(await client.getMessages(session.id))).toContain('existing history')
      }
      expect((await client.connectionState()).sharingEnabled).toBe(false)
      await client.updateSessionMeta(sessions[0]!.id, { title: 'Continued by Core' })
      expect((await client.listSessions()).find(value => value.id === sessions[0]!.id)?.title).toBe('Continued by Core')
      expect(JSON.parse(readFileSync(join(root, 'agent-workspaces.json'), 'utf8')).customMetadata).toBe('preserve')
      for (const session of sessions) expect(readFileSync(join(root, 'agent-sessions', `${session.id}.jsonl`), 'utf8')).toBe(messages)
      expect(readFileSync(join(root, 'core-local-settings.json'), 'utf8')).toBe(obsoleteSettings)
      await lifecycle.stop()
      const restarted = await lifecycle.start()
      expect((await restarted.client.listSessions()).find(value => value.id === sessions[0]!.id)?.title).toBe('Continued by Core')
    } finally { await lifecycle.stop(); rmSync(root, { recursive: true, force: true }) }
  }, 20_000)

  test('Given 宿主平台 When 启动自身Core Then 仅Windows透传Bash配置且POSIX保留宿主路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-local-core-shell-'))
    let childEnv: NodeJS.ProcessEnv | undefined
    const spawnImpl = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      childEnv = options.env
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      return spawn(command, args, options as import('node:child_process').SpawnOptions)
    }) as typeof import('node:child_process').spawn
    const lifecycle = new LocalCoreLifecycle({
      configDir: root, workspaceRoot: join(root, 'workspaces'), bunCommand: process.execPath,
      env: process.platform === 'win32'
        ? { Path: 'C:\\Git\\bin', CLAUDE_CODE_SHELL: 'C:\\Git\\bin\\bash.exe', PROFER_WINDOWS_SHELL: 'git-bash' }
        : { PATH: '/usr/bin:/bin', HOME: root, CLAUDE_CODE_SHELL: 'C:\\Git\\bin\\bash.exe', PROFER_WINDOWS_SHELL: 'git-bash' },
      spawnImpl,
    })
    try {
      await lifecycle.start()
      if (process.platform === 'win32') {
        expect(childEnv?.CLAUDE_CODE_SHELL).toBe('C:\\Git\\bin\\bash.exe')
        expect(childEnv?.PROFER_WINDOWS_SHELL).toBe('git-bash')
      } else {
        expect(childEnv?.PATH).toBe('/usr/bin:/bin')
        expect(childEnv?.HOME).toBe(root)
        expect(childEnv?.CLAUDE_CODE_SHELL).toBeUndefined()
        expect(childEnv?.PROFER_WINDOWS_SHELL).toBeUndefined()
      }
    } finally {
      await lifecycle.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)

  test('uses an explicit Bun executable from the environment', () => {
    const spec = resolveCoreLaunchSpec({ packaged: false, env: { PROFER_BUN_PATH: 'C:/runtime/bun.exe' } })
    expect(spec.command).toBe('C:/runtime/bun.exe')
  })

  test.skipIf(process.platform !== 'win32')('resolves the executable behind an npm Bun command shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-core-bun-shim-'))
    try {
      const bin = join(root, 'node_modules', 'bun', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(root, 'bun.cmd'), '@echo off')
      writeFileSync(join(bin, 'bun.exe'), '')
      const spec = resolveCoreLaunchSpec({ packaged: false, env: { Path: root } })
      expect(spec.command).toBe(join(bin, 'bun.exe'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('resolves the development entry from the repository layout', () => {
    const spec = resolveCoreLaunchSpec({ packaged: false, bunCommand: 'bun' })
    expect(spec.command).toBe('bun')
    expect(spec.args).toHaveLength(1)
    expect(existsSync(spec.args[0]!)).toBe(true)
  })
})

test.skipIf(!['darwin', 'linux'].includes(process.platform))('独立接入失败不启动或接管进程；重试重新读取描述符', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-external-lifecycle-'))
  const release = acquireCoreExecutionLock(root)
  const seen: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = []
  let spawns = 0
  const lifecycle = new LocalCoreLifecycle({
    configDir: root, workspaceRoot: join(root, 'agent-workspaces'), independent: true,
    spawnImpl: () => { spawns++; throw new Error('unexpected spawn') },
    fetchImpl: async (url, init) => {
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
      return Response.json({ coreId: 'wrong-id' })
    },
  })
  try {
    const remove = publishLocalCoreOwner(root, { version: 1, pid: process.pid, port: 12345, coreId: 'expected-id', token: 'fixture' })
    try {
      chmodSync(join(root, '.core-owner.json'), 0o644)
      await expect(lifecycle.start()).rejects.toThrow('权限')
      expect(seen).toHaveLength(0)
      chmodSync(join(root, '.core-owner.json'), 0o600)
      await expect(lifecycle.start()).rejects.toThrow('身份')
      await lifecycle.stop()
      expect(seen).toEqual([{ url: 'http://127.0.0.1:12345/identity', authorization: 'Bearer fixture', redirect: 'error' }])
      expect(spawns).toBe(0)
    } finally { remove() }
  } finally {
    release()
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!['darwin', 'linux'].includes(process.platform))('独立 Core 支持桌面断开重连和显式停服，重启保留身份', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-external-cold-start-'))
  const entry = join(root, 'mock-core.ts')
  const coreEntry = join(import.meta.dir, '../../../../core/src/index.ts')
  writeFileSync(entry, `import { startCore } from ${JSON.stringify(coreEntry)}; await startCore([...process.argv.slice(2), '--mock-agent'])`)
  const children: import('node:child_process').ChildProcess[] = []
  const options = { configDir: root, workspaceRoot: join(root, 'agent-workspaces'), independent: true, coreEntry: entry, bunCommand: process.execPath, spawnImpl: (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    children.push(child)
    return child
  } }
  const first = new LocalCoreLifecycle(options)
  const second = new LocalCoreLifecycle(options)
  try {
    const started = await first.start()
    const owner = readLocalCoreOwner(root)
    expect(children.map(child => child.pid)).toEqual([owner.pid])
    await first.stop()
    const reused = await second.start()
    expect(reused.baseUrl).toBe(started.baseUrl)
    expect((await reused.client.identity()).coreId).toBe(owner.coreId)
    expect(children).toHaveLength(1)
    const child = children[0]!
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    await second.quit(5_000)
    expect(await exited).toBe(0)
    expect(() => readLocalCoreOwner(root)).toThrow('ENOENT')
    expect(existsSync(join(root, '.core-execution-lock'))).toBe(false)
    const restarted = await first.start()
    expect((await restarted.client.identity()).coreId).toBe(owner.coreId)
  } finally {
    await first.stop()
    await second.stop()
    await Promise.all(children.filter(child => child.pid && child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM') })))
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test.skipIf(!['darwin', 'linux'].includes(process.platform))('独立冷启动找不到二进制时只尝试独立入口，不回落内置', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-external-cold-error-'))
  const attempts: string[][] = []
  const lifecycle = new LocalCoreLifecycle({ configDir: root, workspaceRoot: root, independent: true, coreBinary: join(root, 'missing-core'), healthTimeoutMs: 1000,
    spawnImpl: (...args: Parameters<typeof spawn>) => { attempts.push([...args[1]]); return spawn(...args) },
  })
  try {
    await expect(lifecycle.start()).rejects.toThrow('ENOENT')
    expect(attempts).toEqual([['--desktop-independent', '--config-dir', root]])
  } finally { await lifecycle.stop(); rmSync(root, { recursive: true, force: true }) }
})

for (const protocolVersion of [undefined, '1', 999]) {
  test.skipIf(!['darwin', 'linux'].includes(process.platform))(`独立桌面相同身份拒绝协议 ${String(protocolVersion)} (${typeof protocolVersion}) 且不启动或触碰业务`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-owner-protocol-'))
    const release = acquireCoreExecutionLock(root)
    let spawns = 0
    let upgrades = 0
    const paths: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      paths.push(new URL(request.url).pathname)
      if (request.headers.get('upgrade')) upgrades++
      return Response.json({ coreId: 'protocol-fixture', protocolVersion, version: '999.0.0' })
    } })
    const remove = publishLocalCoreOwner(root, { version: 1, pid: process.pid, port: server.port!, coreId: 'protocol-fixture', token: 'synthetic' })
    const before = readFileSync(join(root, '.core-owner.json'), 'utf8')
    const lifecycle = new LocalCoreLifecycle({ independent: true, configDir: root, workspaceRoot: root,
      spawnImpl: () => { spawns++; throw new Error('must not spawn') },
    })
    try {
      expect(await lifecycle.start().then(() => null, error => error.message)).toContain('协议版本不兼容')
      expect(paths).toEqual(['/identity'])
      expect(upgrades).toBe(0)
      expect(spawns).toBe(0)
      expect(readFileSync(join(root, '.core-owner.json'), 'utf8')).toBe(before)
      expect(readFileSync(join(root, '.core-execution-lock', 'owner'), 'utf8')).toBe(String(process.pid))
      expect(readLocalCoreOwner(root).pid).toBe(process.pid)
    } finally { await lifecycle.stop(); remove(); release(); server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
}
