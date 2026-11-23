import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireCoreExecutionLock } from './execution-lock'
import { ensureIndependentOwner, pickLocalCoreEnvironment, shutdownIndependentCore } from '@profer/session-store/execution-lock'

test.each([['win32', { Path: 'C:\\Git\\bin', systemroot: 'C:\\Windows', PROFER_WINDOWS_SHELL: 'git-bash' }], ['darwin', { PATH: '/usr/bin', HOME: '/home/user' }]] as const)(
  'Given %s 启动 Core When 选择环境变量 Then 只传递该平台白名单', (platform, expected) => {
    const source = platform === 'win32'
      ? { ...expected, HOME: '/another/home', PROFER_CORE_API_KEY: 'fixture-not-forwarded' }
      : { ...expected, Path: '/wrong-path', PROFER_WINDOWS_SHELL: 'git-bash', PROFER_CORE_API_KEY: 'fixture-not-forwarded' }
    expect(pickLocalCoreEnvironment(source, platform)).toEqual(expected)
  },
)

test.skipIf(process.platform !== 'win32')('Given Windows 未启用独立模式 When 配置根不存在 Then 启停均明确拒绝且不启动进程', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-owner-disabled-'))
  const absent = join(root, 'not-created')
  let launches = 0
  try {
    await expect(ensureIndependentOwner(absent, { launch: () => { launches++; throw new Error('unexpected launch') } }))
      .rejects.toThrow('平台门禁保持关闭')
    await expect(shutdownIndependentCore(absent)).rejects.toThrow('平台门禁保持关闭')
    expect(launches).toBe(0)
    expect(existsSync(absent)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('同根单写、正常释放与已退出进程锁恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-lock-'))
  try {
    const release = acquireCoreExecutionLock(dir)
    expect(() => acquireCoreExecutionLock(dir)).toThrow('已有 Core')
    release(); release()
    const again = acquireCoreExecutionLock(dir); again()
    mkdirSync(join(dir, '.core-execution-lock'))
    writeFileSync(join(dir, '.core-execution-lock/owner'), '2147483647')
    const recovered = acquireCoreExecutionLock(dir); recovered()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('独立进程同根拒绝、异常退出与 SIGKILL 后恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-lock-process-'))
  const source = `import { acquireCoreExecutionLock } from ${JSON.stringify(join(import.meta.dir, 'execution-lock.ts'))}; const release = acquireCoreExecutionLock(${JSON.stringify(dir)}); console.log('locked'); setInterval(()=>{},1000)`
  const child = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock()
    expect(() => acquireCoreExecutionLock(dir)).toThrow()
    child.kill('SIGKILL'); await child.exited
    const release = acquireCoreExecutionLock(dir); release()
    const failure = Bun.spawn([process.execPath, '-e', `import { acquireCoreExecutionLock } from ${JSON.stringify(join(import.meta.dir, 'execution-lock.ts'))}; const release = acquireCoreExecutionLock(${JSON.stringify(dir)}); try { throw new Error('startup failure') } finally { release() }`], { stdout: 'ignore', stderr: 'ignore' })
    expect(await failure.exited).not.toBe(0)
    const afterFailure = acquireCoreExecutionLock(dir); afterFailure()
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; rmSync(dir, { recursive: true, force: true }) }
})
