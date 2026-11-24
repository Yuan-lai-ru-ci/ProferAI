import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalCoreLifecycle } from './core-lifecycle'

test.skipIf(process.platform === 'win32')('桌面被SIGKILL后，自有Core通过管道关闭释放写锁，重启可连接', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-parent-death-'))
  const entry = join(import.meta.dir, '../../../../core/src/index.ts')
  const lifecycle = join(import.meta.dir, 'core-lifecycle.ts')
  const source = `import { LocalCoreLifecycle } from ${JSON.stringify(lifecycle)};
const owner = new LocalCoreLifecycle({configDir:${JSON.stringify(root)},workspaceRoot:${JSON.stringify(join(root, 'workspaces'))},coreEntry:${JSON.stringify(entry)},bunCommand:process.execPath,env:{PATH:process.env.PATH}});
await owner.start(); console.log('READY'); setInterval(()=>{},1000);`
  const parent = Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' })
  let corePid: number | undefined
  const lock = join(root, '.core-execution-lock/owner')
  const replacement = new LocalCoreLifecycle({ configDir: root, workspaceRoot: join(root, 'workspaces'), coreEntry: entry, bunCommand: process.execPath, env: { PATH: process.env.PATH } })
  try {
    const reader = parent.stdout.getReader()
    const ready = await Promise.race([reader.read(), Bun.sleep(10000).then(() => { throw new Error('parent startup timeout') })])
    expect(new TextDecoder().decode(ready.value)).toContain('READY')
    reader.releaseLock()
    corePid = Number(readFileSync(lock, 'utf8'))
    parent.kill('SIGKILL'); await parent.exited
    for (let i = 0; i < 100 && existsSync(lock); i++) await Bun.sleep(50)
    expect(existsSync(lock)).toBe(false)
    const started = await replacement.start()
    expect((await started.client.health()).status).toBe('ok')
  } finally {
    await replacement.stop()
    if (parent.exitCode === null) { parent.kill('SIGKILL'); await parent.exited }
    // 仅清理本fixture发布的Core进程。
    if (corePid) { try { process.kill(corePid, 'SIGTERM') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
}, 25000)

test('健康检查前退出时返回Core的明确错误行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-start-error-'))
  const core = new LocalCoreLifecycle({ configDir: root, workspaceRoot: root, coreBinary: process.execPath,
    spawnImpl: (_command, _args, options) => require('node:child_process').spawn(process.execPath, ['-e', 'console.error("error: 同一配置根已有 Core 执行进程");process.exit(1)'], options),
  })
  try { await expect(core.start()).rejects.toThrow('同一配置根已有 Core 执行进程') }
  finally { await core.stop(); rmSync(root, { recursive: true, force: true }) }
})
