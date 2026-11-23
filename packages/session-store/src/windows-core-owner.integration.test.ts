import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCoreExecutionLock } from './execution-lock'
import { holdWindowsCoreOwner, requestWindowsOwner, resolveWindowsOwnerHelper } from './windows-core-owner'

const runtimeDir = process.env.PROFER_TEST_CORE_RUNTIME_DIR
const native = process.platform === 'win32' && Boolean(runtimeDir)

test.skipIf(!native)('Given Windows 原生成品 helper When TS 控制流持锁发布读取释放 Then 与旧 writer 互斥且不泄露凭据', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'core-owner-adapter-'))
  const root = join(temporary, 'private-root')
  const endpoint = { version: 1 as const, pid: process.pid, port: 4242, coreId: 'fixture-core', token: 'fixture-not-a-real-credential' }
  let lost = 0
  let lease: Awaited<ReturnType<typeof holdWindowsCoreOwner>> | undefined
  try {
    const absent = join(temporary, 'absent')
    expect(() => requestWindowsOwner(runtimeDir!, 'read', absent)).toThrow()
    expect(existsSync(absent)).toBe(false)
    lease = await holdWindowsCoreOwner(runtimeDir!, root, () => { lost++ })
    expect(() => acquireCoreExecutionLock(root)).toThrow('已有 Core')
    // Bun 1.3.14 Windows 的 .rejects 等待会阻塞子进程 I/O；先异步取结果再断言。
    const competingError = await holdWindowsCoreOwner(runtimeDir!, root, () => { lost++ }).then(() => undefined, (error: unknown) => error)
    expect(competingError).toMatchObject({ code: 'BUSY' })
    await lease.publish(endpoint)
    expect(requestWindowsOwner(runtimeDir!, 'read', root)).toEqual(endpoint)
    expect(requestWindowsOwner(runtimeDir!, 'released', root, process.pid)).toBe(false)
    await lease.remove()
    expect(() => requestWindowsOwner(runtimeDir!, 'read', root)).toThrow()
    // remove 只撤连接文件，不能提前释放 writer 锁。
    expect(() => acquireCoreExecutionLock(root)).toThrow()
    await Promise.all([lease.release(), lease.release()])
    await lease.release()
    expect(lost).toBe(0)
    expect(requestWindowsOwner(runtimeDir!, 'released', root, process.pid)).toBe(true)
    const oldWriter = acquireCoreExecutionLock(root); oldWriter()
  } finally { await lease?.release(); rmSync(temporary, { recursive: true, force: true }) }
}, 30_000)

test.skipIf(!native)('Given release 原生收尾失败 When helper 已关闭写锁句柄 Then TS 必须视为失锁而非继续写入', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'core-owner-release-failure-'))
  const root = join(temporary, 'private-root')
  let lost = 0
  const lease = await holdWindowsCoreOwner(runtimeDir!, root, () => { lost++ })
  try {
    mkdirSync(join(root, '.core-owner.json'))
    const releaseError = await lease.release().then(() => undefined, (error: unknown) => error)
    expect(releaseError).toMatchObject({ code: 'UNSAFE' })
    expect(lost).toBe(1)
    await expect(lease.publish({ version: 1, pid: process.pid, port: 4242, coreId: 'fixture', token: 'fixture' })).rejects.toThrow()
  } finally {
    // 失败已触发 child.kill，等其退出后测试才能删除被固定的目录。
    await Bun.sleep(100)
    rmSync(temporary, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(!native)('Given 持锁 helper 意外退出 When Windows 进程结束 Then TS 必须触发失锁回调且拒绝后续写入', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'core-owner-loss-'))
  const root = join(temporary, 'private-root')
  let lost = 0
  const lease = await holdWindowsCoreOwner(runtimeDir!, root, () => { lost++ })
  try {
    const helper = resolveWindowsOwnerHelper(runtimeDir!).replaceAll("'", "''")
    const script = `$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object { $_.ExecutablePath -eq '${helper}' }); if($p.Count -ne 1){exit 3}; Stop-Process -Id $p[0].ProcessId -Force`
    const powershell = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const stopped = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10_000 })
    expect(stopped.status).toBe(0)
    for (let i = 0; i < 100 && !lost; i++) await Bun.sleep(20)
    expect(lost).toBe(1)
    await expect(lease.publish({ version: 1, pid: process.pid, port: 4242, coreId: 'fixture', token: 'fixture' })).rejects.toThrow('helper')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}, 30_000)
