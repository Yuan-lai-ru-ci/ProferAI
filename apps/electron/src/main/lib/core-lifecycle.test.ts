import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalCoreLifecycle, resolveCoreLaunchSpec } from './core-lifecycle'

describe('Core lifecycle launch selection', () => {
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

  test('passes the validated host Bash path to an owned Core child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-local-core-shell-'))
    let childEnv: NodeJS.ProcessEnv | undefined
    const spawnImpl = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      childEnv = options.env
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      return spawn(command, args, options as import('node:child_process').SpawnOptions)
    }) as typeof import('node:child_process').spawn
    const lifecycle = new LocalCoreLifecycle({
      configDir: root, workspaceRoot: join(root, 'workspaces'), bunCommand: process.execPath,
      env: { Path: 'C:\\Git\\bin', CLAUDE_CODE_SHELL: 'C:\\Git\\bin\\bash.exe', PROFER_WINDOWS_SHELL: 'git-bash' },
      spawnImpl,
    })
    try {
      await lifecycle.start()
      expect(childEnv?.CLAUDE_CODE_SHELL).toBe('C:\\Git\\bin\\bash.exe')
      expect(childEnv?.PROFER_WINDOWS_SHELL).toBe('git-bash')
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
