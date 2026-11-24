import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCoreExecutionLock, publishLocalCoreOwner, readLocalCoreOwner } from '@profer/session-store/execution-lock'
import { connectLocalCore, resolveCoreLaunch } from './local-core'

test('Given Windows CLI When PATH 存在同名干扰 Then 只接受相邻安装或显式绝对 Core', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-core-selection-'))
  try {
    const cliDir = join(root, 'cli'); const pathDir = join(root, 'path')
    mkdirSync(cliDir); mkdirSync(pathDir)
    const cli = join(cliDir, 'profer.exe'); writeFileSync(cli, 'fixture', { mode: 0o700 })
    const interferer = join(pathDir, 'profer-core.exe'); writeFileSync(interferer, 'fixture', { mode: 0o700 })
    expect(() => resolveCoreLaunch('win32', cli, { PATH: pathDir })).toThrow('未找到')
    const adjacent = join(cliDir, 'profer-core.exe'); writeFileSync(adjacent, 'fixture', { mode: 0o700 })
    expect(resolveCoreLaunch('win32', cli, { PATH: pathDir }).command).toBe(join(realpathSync(cliDir), 'profer-core.exe'))
    expect(resolveCoreLaunch('win32', cli, { PROFER_CORE_BIN: interferer }).command).toBe(interferer)
    expect(() => resolveCoreLaunch('win32', cli, { PROFER_CORE_BIN: 'relative' })).toThrow('绝对路径')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!['darwin', 'linux'].includes(process.platform))('CLI opt-in cold start shares one owner; invalid descriptors and failed launches do not fall back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-owner-start-'))
  const previous = process.env.PROFER_CORE_BIN
  const previousPath = process.env.PATH
  const configDir = join(root, 'data')
  const bin = join(root, 'profer-core')
  const entry = join(import.meta.dir, '../../core/src/index.ts')
  writeFileSync(bin, `#!${process.execPath}\nimport { startCore } from ${JSON.stringify(entry)}; await startCore([...process.argv.slice(2), '--mock-agent'])\n`, { mode: 0o700 })
  let pid: number | undefined
  try {
    delete process.env.PROFER_CORE_BIN
    process.env.PATH = root
    async function command(name: 'start' | 'status' | 'stop', ...extra: string[]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'index.ts'), 'core', name, '--config-dir', configDir, '--json', ...extra], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
      const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()])
      return { code, stdout, stderr }
    }
    await expect(connectLocalCore({ configDir })).rejects.toThrow('ENOENT')
    expect(await command('status')).toMatchObject({ code: 1, stdout: '' })
    expect(await command('start', '--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('用法') })
    expect(() => readLocalCoreOwner(configDir)).toThrow('ENOENT')
    const [peers, started] = await Promise.all([
      Promise.all([1, 2].map(() => connectLocalCore({ configDir }, { autoStart: true }))),
      command('start'),
    ])
    const owner = readLocalCoreOwner(configDir)
    pid = owner.pid
    for (const peer of peers) expect(await peer.json('/identity')).toMatchObject({ coreId: owner.coreId })
    const status = await command('status')
    expect(started).toMatchObject({ code: 0, stderr: '' })
    expect(status).toEqual(started)
    expect(JSON.parse(status.stdout)).toEqual({ status: 'running', coreId: owner.coreId, protocolVersion: 1, platform: process.platform, version: expect.any(String) })
    expect(status.stdout).not.toContain(owner.token)
    process.env.PROFER_CORE_BIN = join(root, 'missing')
    expect(await (await connectLocalCore({ configDir }, { autoStart: true })).json('/identity')).toMatchObject({ coreId: owner.coreId })
    await expect(connectLocalCore({ configDir: join(root, 'missing-root') }, { autoStart: true })).rejects.toThrow('ENOENT')
    const stopped = await command('stop')
    expect(stopped).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(stopped.stdout)).toEqual({ status: 'stopped', coreId: owner.coreId })
    expect(await command('status')).toMatchObject({ code: 1, stdout: '' })
    expect(() => readLocalCoreOwner(configDir)).toThrow('ENOENT')
    pid = undefined
    const invalid = join(root, '.core-owner.json')
    writeFileSync(invalid, '{', { mode: 0o600 })
    await expect(connectLocalCore({ configDir: root }, { autoStart: true })).rejects.toBeInstanceOf(SyntaxError)
  } finally {
    if (previous === undefined) delete process.env.PROFER_CORE_BIN
    else process.env.PROFER_CORE_BIN = previous
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    // Only stop a process published under this test's unique root.
    try { pid ??= readLocalCoreOwner(configDir).pid } catch {}
    if (pid) {
      process.kill(pid, 'SIGTERM')
      for (let i = 0; i < 200; i++) {
        try { process.kill(pid, 0) } catch { break }
        await Bun.sleep(20)
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)

for (const protocolVersion of [undefined, '1', 999, 1]) {
  test.skipIf(!['darwin', 'linux'].includes(process.platform))(`本机 CLI 相同身份协议 ${String(protocolVersion)} (${typeof protocolVersion})：仅协议1通过且不改变owner`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cli-owner-protocol-'))
    const release = acquireCoreExecutionLock(root)
    const paths: string[] = []
    let upgrades = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      paths.push(new URL(request.url).pathname)
      if (request.headers.get('upgrade')) upgrades++
      return Response.json({ coreId: 'protocol-fixture', protocolVersion, version: '999.0.0' })
    } })
    const remove = publishLocalCoreOwner(root, { version: 1, pid: process.pid, port: server.port!, coreId: 'protocol-fixture', token: 'synthetic' })
    const ownerPath = join(root, '.core-owner.json')
    const before = readFileSync(ownerPath, 'utf8')
    const previousBinary = process.env.PROFER_CORE_BIN
    process.env.PROFER_CORE_BIN = join(root, 'must-not-launch')
    try {
      const operation = connectLocalCore({ configDir: root }, { autoStart: true })
      if (protocolVersion === 1) expect((await operation).identity.protocolVersion).toBe(1)
      else expect(await operation.then(() => null, error => error.message)).toContain('协议版本不兼容')
      expect(paths).toEqual(['/identity'])
      expect(upgrades).toBe(0)
      expect(readFileSync(ownerPath, 'utf8')).toBe(before)
      expect(readFileSync(join(root, '.core-execution-lock', 'owner'), 'utf8')).toBe(String(process.pid))
      expect(readLocalCoreOwner(root).pid).toBe(process.pid)
    } finally {
      if (previousBinary === undefined) delete process.env.PROFER_CORE_BIN
      else process.env.PROFER_CORE_BIN = previousBinary
      remove(); release(); server.stop(true); rmSync(root, { recursive: true, force: true })
    }
  })
}
