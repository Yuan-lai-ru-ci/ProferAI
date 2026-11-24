import { expect, test } from 'bun:test'
import { coreBuildPlan, coreBuildDefines, CORE_RUNTIME_BANNER } from './build-runtime'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

test.each(['oss', 'commercial'] as const)('Core %s 实际bundle保留对应发行版实现', async edition => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, '../src/index.ts')], target: 'bun', external: coreBuildPlan('/tmp/core-edition').external,
    define: coreBuildDefines(edition), minify: { syntax: true, whitespace: false, identifiers: false } })
  expect(result.success).toBe(true)
  const text = await result.outputs[0]!.text()
  for (const signature of ['verifyRegistrationOtp', '/v1/proxy/messages', '/v1/proxy/chat', 'account-service.ts']) expect(text.includes(signature)).toBe(edition === 'commercial')
})

test('宿主目录保留 external Pi 与目标 Claude native', () => {
  const plan = coreBuildPlan('/tmp/core-output', 'darwin', 'arm64')
  expect(plan.executable).toBe(join(resolve('/tmp/core-output'), 'profer-core'))
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
