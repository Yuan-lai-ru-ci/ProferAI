import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCoreExecutionLock } from '@profer/session-store/execution-lock'

test('启动编排仅在新核模式冻结旧 writer、注册重试并启动 Core', async () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const claim = source.slice(source.indexOf('  // 默认新核先冻结旧 writer'), source.indexOf('  // Register IPC handlers'))
  const start = source.slice(source.indexOf('  if (isLocalCoreEnabled()) {\n    configureLocalCoreRetry'), source.indexOf('  // 远程服务（remote-service）'))
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${claim}\n${start}`.replaceAll("await import('./lib/agent-workspace-manager')", 'workspace').replaceAll("await import('./lib/automation-manager')", 'automation'))
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('isLocalCoreEnabled', 'workspace', 'automation', 'configureLocalCoreRetry', 'startLocalCore', 'safeAwait', 'updateLocalCoreStatus', js)
  for (const enabled of [false, true]) {
    const calls: string[] = []
    await run(() => enabled, { claimWorkspaceIndexForCore: () => calls.push('workspace') }, { claimAutomationsForCore: () => calls.push('automation') }, () => calls.push('retry'), async () => { calls.push('start') }, async (_name: string, fn: () => Promise<void>) => { await fn() }, () => {})
    expect(calls).toEqual(enabled ? ['workspace', 'automation', 'retry', 'start'] : [])
  }
  expect(source).toContain('if (!isLocalCoreEnabled() || remoteExitPending || remoteExitComplete) return')
})

const bootstrap = join(import.meta.dir, 'core-local-bootstrap.ts')
function source(root: string, single = true, legacy = false): string {
  return `import {mock} from 'bun:test';
process.env.PROFER_CONFIG_DIR=${JSON.stringify(root)};
process.env.PROFER_CORE_LOCAL='0';
${legacy ? "process.env.PROFER_LOCAL_CORE_MODE='legacy';" : "delete process.env.PROFER_LOCAL_CORE_MODE;"}
mock.module('electron',()=>({app:{isPackaged:false,setName(){},setPath(){},getPath(){return '/isolated/userdata'},requestSingleInstanceLock(){return ${single}},exit(code){process.exit(code)},on(event,callback){if(event==='will-quit')process.on('exit',callback)}}}));
await import(${JSON.stringify(bootstrap)});
console.log('booted');
process.stdin.on('data',()=>process.exit(0));setInterval(()=>{},1000);`
}
test('旧安装正常进入 Core 启动；父桌面不争抢 Core 执行锁，重复实例立即退出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-bootstrap-'))
  writeFileSync(join(root, 'settings.json'), '{}')
  writeFileSync(join(root, 'core-local-settings.json'), JSON.stringify({ version: 1, enabled: false }))
  const release = acquireCoreExecutionLock(root)
  const child = Bun.spawn([process.execPath, '-e', source(root)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read(); reader.releaseLock()
    expect(new TextDecoder().decode(first.value)).toContain('booted')
    expect(() => acquireCoreExecutionLock(root)).toThrow()
    const duplicate = Bun.spawn([process.execPath, '-e', source(root, false)], { stdout: 'ignore', stderr: 'ignore' })
    expect(await duplicate.exited).toBe(0)
    child.stdin.write('quit'); child.stdin.flush()
    expect(await child.exited).toBe(0)
    expect(() => acquireCoreExecutionLock(root)).toThrow()
    release()
    const next = acquireCoreExecutionLock(root); next()
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    release()
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)

test('显式旧核持有同根执行锁，退出释放；Core仍在运行时拒绝旧核写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-bootstrap-'))
  const child = Bun.spawn([process.execPath, '-e', source(root, true, true)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read(); reader.releaseLock()
    expect(new TextDecoder().decode(first.value)).toContain('booted')
    expect(() => acquireCoreExecutionLock(root)).toThrow()
    child.stdin.write('quit'); child.stdin.flush()
    expect(await child.exited).toBe(0)
    const release = acquireCoreExecutionLock(root)
    try {
      const rejected = Bun.spawn([process.execPath, '-e', source(root, true, true)], { stdout: 'pipe', stderr: 'pipe' })
      expect(await rejected.exited).not.toBe(0)
      expect(await new Response(rejected.stdout).text()).not.toContain('booted')
      expect(() => acquireCoreExecutionLock(root)).toThrow()
    } finally { release() }
  } finally {
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
