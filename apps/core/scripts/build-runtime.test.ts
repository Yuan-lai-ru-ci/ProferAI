import { expect, test } from 'bun:test'
import { coreBuildPlan, CORE_RUNTIME_BANNER } from './build-runtime'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Core磁盘bundle清除解释器专用环境，子进程不继承BUN_BE_BUN', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-core-env-'))
  try {
    const entry = join(root, 'input.ts')
    writeFileSync(entry, "console.log(process.env.BUN_BE_BUN ?? 'cleared')")
    const built = await Bun.build({ entrypoints: [entry], outdir: root, naming: 'probe.js', target: 'bun', banner: CORE_RUNTIME_BANNER })
    expect(built.success).toBe(true)
    const child = Bun.spawnSync([process.execPath, join(root, 'probe.js')], { env: { ...process.env, BUN_BE_BUN: '1' } })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe('cleared')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('宿主目录保留 external Pi 与目标 Claude native', () => {
  const plan = coreBuildPlan('/tmp/core-output', 'darwin', 'arm64')
  expect(plan.executable).toBe('/tmp/core-output/profer-core')
  expect(plan.nativeClaudePackage).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64')
  expect(plan.external).toContain('@earendil-works/pi-coding-agent')
  expect(plan.external).toContain('@earendil-works/pi-ai')
})
test('平台校验和 Windows 可执行文件名', () => {
  expect(coreBuildPlan('/tmp/core-output', 'win32', 'x64').executable).toEndWith('.exe')
  expect(() => coreBuildPlan('/tmp/core-output', 'linux', 'arm')).toThrow('不支持')
})
test('拒绝覆盖仓库源目录', () => {
  expect(() => coreBuildPlan(process.cwd(), 'darwin', 'arm64')).toThrow()
})
