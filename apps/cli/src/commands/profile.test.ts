import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getCommand } from '../registry'
import type { CommandContext } from '../registry'
import './profile'

const roots: string[] = []
let configDir = ''

const originalStdout = process.stdout.write.bind(process.stdout)
const originalStderr = process.stderr.write.bind(process.stderr)
let stdout = ''
let stderr = ''

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'profer-cli-profile-'))
  roots.push(root)
  configDir = join(root, 'config')

  stdout = ''
  stderr = ''
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stdout.write = originalStdout
  process.stderr.write = originalStderr
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function ctx(positionals: string[], flags: Record<string, string | boolean> = {}, json = false): CommandContext {
  return { args: { positionals, flags }, pathOpts: { configDir }, json }
}

async function run(name: string, context: CommandContext): Promise<number> {
  const command = getCommand(name, 'profile')
  if (!command) throw new Error(`profile ${name} 未注册`)
  return await command.run(context)
}

describe('profer profile', () => {
  test('set then get round-trips a field through stdout only', async () => {
    expect(await run('set', ctx(['address', '老源']))).toBe(0)
    expect(stdout.trim()).toBe('老源')
    expect(stderr).toContain('已写入 user-profile.md')

    stdout = ''
    expect(await run('get', ctx(['address']))).toBe(0)
    expect(stdout.trim()).toBe('老源')
  })

  test('get on an empty field keeps stdout clean for scripts', async () => {
    expect(await run('get', ctx(['role']))).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('未填写')
  })

  test('show --json exposes profile, fields and files', async () => {
    await run('set', ctx(['collaboration', '先给结论']))
    stdout = ''
    expect(await run('show', ctx([], {}, true))).toBe(0)

    const data = JSON.parse(stdout)
    expect(data.configDir).toBe(configDir)
    expect(data.summary.indexExists).toBe(true)
    expect(data.fields.find((f: { key: string }) => f.key === 'collaboration').value).toBe('先给结论')
    expect(data.files.some((f: { relativePath: string }) => f.relativePath === 'MEMORY.md')).toBe(true)
  })

  test('context prints the same identity section the app injects', async () => {
    expect(await run('context', ctx([]))).toBe(0)
    expect(stdout).toContain('## 用户信息')
    expect(stdout).toContain('<global_user_memory_index>')
  })

  test('search finds a value written by set', async () => {
    await run('set', ctx(['role', '独立开发者']))
    stdout = ''
    expect(await run('search', ctx(['独立开发者']))).toBe(0)
    expect(stdout).toContain('user-profile.md')
  })

  test('an explicit empty value clears the field', async () => {
    await run('set', ctx(['address', '老源']))
    stdout = ''
    expect(await run('set', ctx(['address', '']))).toBe(0)
    expect(stdout.trim()).toBe('')

    stdout = ''
    await run('get', ctx(['address']))
    expect(stdout).toBe('')
    expect(stderr).toContain('未填写')
  })

  test('missing arguments are usage errors, not crashes', async () => {
    await expect(run('set', ctx(['address']))).rejects.toThrow('缺少字段值')
    await expect(run('get', ctx([]))).rejects.toThrow('缺少字段名')
    await expect(run('get', ctx(['nope']))).rejects.toThrow('未知画像字段')
  })
})
