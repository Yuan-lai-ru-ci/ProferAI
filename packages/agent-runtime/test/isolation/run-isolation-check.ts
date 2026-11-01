#!/usr/bin/env bun
/**
 * run-isolation-check.ts —— "核心独立缺席"验证器（真实构建 + 真实加载，不是字符串检查）。
 *
 * 为什么必须在临时目录而不是仓库内：Node/Bun 的解析会一直向上找 node_modules。
 * 只要沙箱还有 monorepo 祖先，`@earendil-works/*` 之类的已安装包就会被解析到，
 * "缺 SDK 也能加载"就变成假阳性。所以本脚本：
 *   1. 在 `os.tmpdir()` 下建沙箱，先断言沙箱及其所有祖先都没有 provider SDK 可解析；
 *   2. 只复制 provider 无关的支撑包（typescript / @types/node / @types/bun / bun-types）；
 *   3. 在沙箱里跑 typecheck（含反证）、`bun build`、源码入口加载、构建产物加载，以及本包测试；
 *   4. 入口断言复用 `probe-entry.ts`，与单测保持同一标准。
 *
 * 用法：
 *   bun run check:isolation
 *   bun run check:isolation -- --keep     # 保留沙箱目录便于人工排查
 * 退出码：0 全部通过；1 任一检查失败。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const packageDir = resolve(import.meta.dir, '..', '..')
const laneRoot = resolve(packageDir, '..', '..')
const sharedDir = join(laneRoot, 'packages', 'shared')
const fabricDir = join(laneRoot, 'packages', 'agent-fabric')
const bunBin = process.execPath
const keepSandbox = process.argv.includes('--keep')

/** 沙箱必须连"能解析到"都不成立：这些 specifier 从沙箱出发必须全部解析失败。 */
const MUST_NOT_RESOLVE = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  'typebox',
  'electron',
]

/** 构建产物里出现即说明 provider 被内联进核心包。 */
const FORBIDDEN_BUNDLE_MARKERS = ['@earendil-works/', '@anthropic-ai/', 'typebox']

/** 只复制的 provider 无关支撑包。 */
const SUPPORT_PACKAGES = ['typescript', '@types/node', '@types/bun']

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function run(bin: string, args: string[], cwd: string, label: string): { ok: boolean; output: string } {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0, output: `${label}\n${output}`.trim() }
}

function skipEntry(name: string): boolean {
  return name === 'node_modules' || name === 'dist' || name === 'out' || name.startsWith('.')
}

function copyTree(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => !skipEntry(src.split('/').pop() ?? ''),
  })
}

function listAncestorNodeModules(dir: string): string[] {
  const found: string[] = []
  let current = resolve(dir)
  while (true) {
    const candidate = join(current, 'node_modules')
    if (existsSync(candidate) && statSync(candidate).isDirectory()) found.push(candidate)
    const parent = dirname(current)
    if (parent === current) return found
    current = parent
  }
}

function providerHitsIn(nodeModulesDir: string): string[] {
  return ['@earendil-works', '@anthropic-ai', 'typebox', 'electron']
    .map((name) => join(nodeModulesDir, name))
    .filter((candidate) => existsSync(candidate))
}

/**
 * `bun-types` 是 `@types/bun` 的类型依赖，只在 .bun 虚拟目录里被链接；
 * 从 lane 根目录直接解析不到，因此按 @types/bun 的真实位置再解析一次。
 */
function resolveBunTypesDir(): string {
  const bunManifest = Bun.resolveSync('@types/bun/package.json', laneRoot)
  for (const dir of [laneRoot, dirname(bunManifest), resolve(dirname(bunManifest), '..', '..')]) {
    try {
      return dirname(Bun.resolveSync('bun-types/package.json', dir))
    } catch {
      // 继续尝试下一个起点
    }
  }
  throw new Error('找不到 bun-types（@types/bun 的类型依赖）；请先执行 lane 依赖准备脚本')
}

function prepareSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'profer-core-isolation-'))
  mkdirSync(join(sandbox, 'packages'), { recursive: true })
  mkdirSync(join(sandbox, 'node_modules', '@profer'), { recursive: true })
  writeFileSync(join(sandbox, 'package.json'), `${JSON.stringify({
    name: 'profer-core-isolation',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
  }, null, 2)}\n`)
  writeFileSync(join(sandbox, 'tsconfig.json'), readFileSync(join(laneRoot, 'tsconfig.json')))
  copyTree(packageDir, join(sandbox, 'packages', 'agent-runtime'))
  copyTree(sharedDir, join(sandbox, 'packages', 'shared'))
  copyTree(fabricDir, join(sandbox, 'packages', 'agent-fabric'))
  symlinkSync(join(sandbox, 'packages', 'shared'), join(sandbox, 'node_modules', '@profer', 'shared'), 'dir')
  symlinkSync(join(sandbox, 'packages', 'agent-fabric'), join(sandbox, 'node_modules', '@profer', 'agent-fabric'), 'dir')
  for (const name of SUPPORT_PACKAGES) {
    const from = join(laneRoot, 'node_modules', name)
    if (!existsSync(from)) throw new Error(`缺少 provider 无关的支撑包 ${name}：${from}`)
    const to = join(sandbox, 'node_modules', name)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, dereference: true })
  }
  cpSync(resolveBunTypesDir(), join(sandbox, 'node_modules', 'bun-types'), {
    recursive: true,
    dereference: true,
  })
  return sandbox
}

function checkResolvability(sandbox: string): void {
  const ancestors = listAncestorNodeModules(sandbox)
  const ancestorHits = ancestors.flatMap(providerHitsIn)
  record(
    '沙箱祖先不含 provider SDK',
    ancestorHits.length === 0,
    ancestorHits.length === 0 ? `已检查 ${ancestors.length} 个祖先 node_modules` : `发现：${ancestorHits.join(', ')}`,
  )

  const sandboxHits = providerHitsIn(join(sandbox, 'node_modules'))
  record('沙箱 node_modules 不含 provider SDK', sandboxHits.length === 0, sandboxHits.join(', '))

  const resolved: string[] = []
  for (const specifier of MUST_NOT_RESOLVE) {
    try {
      resolved.push(`${specifier} -> ${Bun.resolveSync(specifier, sandbox)}`)
    } catch {
      // 预期：解析失败
    }
  }
  record(
    '沙箱内 provider SDK 全部不可解析（反证，证明其余检查有区分度）',
    resolved.length === 0,
    resolved.length === 0 ? `${MUST_NOT_RESOLVE.length} 个 specifier 均解析失败` : `意外可解析：${resolved.join('; ')}`,
  )
}

function main(): void {
  const sandbox = prepareSandbox()
  console.log(`沙箱：${sandbox}\n`)
  checkResolvability(sandbox)

  const packageInSandbox = join(sandbox, 'packages', 'agent-runtime')
  const tsconfigPath = join(packageInSandbox, 'tsconfig.json')
  const tsc = join(sandbox, 'node_modules', 'typescript', 'bin', 'tsc')
  const typecheckLabels = 'tsc --noEmit -p packages/agent-runtime/tsconfig.json'

  const typecheck = run(bunBin, [tsc, '--noEmit', '-p', tsconfigPath], packageInSandbox, `$ ${typecheckLabels}`)
  record('无 provider SDK 下 typecheck 通过', typecheck.ok, typecheck.ok ? '' : typecheck.output)

  // 反证：同一个 tsc + 同一个 tsconfig，注入一个 provider import 必须失败。
  const negativeProbePath = join(packageInSandbox, 'src', 'isolation-negative-probe.ts')
  writeFileSync(negativeProbePath, "import type { AgentMessage } from '@earendil-works/pi-agent-core'\nexport type IsolationNegativeProbe = AgentMessage\n")
  const negative = run(bunBin, [tsc, '--noEmit', '-p', tsconfigPath], packageInSandbox, '$ tsc --noEmit（注入 provider import 的反证）')
  rmSync(negativeProbePath, { force: true })
  record(
    'typecheck 反证：显式注入 provider import 会失败',
    !negative.ok && /Cannot find module|TS2307/.test(negative.output),
    negative.ok ? '注入 @earendil-works/pi-agent-core 后 tsc 仍通过，隔离无效' : '注入后按预期报 TS2307',
  )

  const build = run(bunBin, ['build', './packages/agent-runtime/src/index.ts', '--target=node', '--outfile', './out/core.js'], sandbox, '$ bun build src/index.ts --target=node')
  const bundlePath = join(sandbox, 'out', 'core.js')
  const bundleExists = existsSync(bundlePath)
  record(
    '无 provider SDK 下构建通过',
    build.ok && bundleExists,
    build.ok ? (bundleExists ? `${(statSync(bundlePath).size / 1024).toFixed(1)} KB` : '缺少产物') : build.output,
  )
  if (bundleExists) {
    const bundleSource = readFileSync(bundlePath, 'utf8')
    const leaked = FORBIDDEN_BUNDLE_MARKERS.filter((marker) => bundleSource.includes(marker))
    record('构建产物未内联 provider SDK', leaked.length === 0, leaked.join(', '))
  }

  const probePath = join(sandbox, 'probe.ts')
  writeFileSync(probePath, [
    'const [entryPath, label] = process.argv.slice(2) as [string, string]',
    "const probe = await import('./packages/agent-runtime/test/isolation/probe-entry.ts')",
    'const loaded = await import(entryPath)',
    'await probe.assertCoreEntryModule(loaded as Record<string, unknown>, label)',
    'console.log(`probe-ok:${label}`)',
    '',
  ].join('\n'))

  const sourceProbe = run(bunBin, [probePath, join(packageInSandbox, 'src', 'index.ts'), 'src/index.ts'], sandbox, '$ bun probe.ts src/index.ts')
  record(
    '无 provider SDK 下源码入口可加载、导出面已收窄、未注册 runtime 明确不可用',
    sourceProbe.ok && sourceProbe.output.includes('probe-ok:src/index.ts'),
    sourceProbe.ok ? '' : sourceProbe.output,
  )

  if (bundleExists) {
    const bundleProbe = run(bunBin, [probePath, bundlePath, 'out/core.js'], sandbox, '$ bun probe.ts out/core.js')
    record(
      '无 provider SDK 下构建产物可加载、导出面已收窄、未注册 runtime 明确不可用',
      bundleProbe.ok && bundleProbe.output.includes('probe-ok:out/core.js'),
      bundleProbe.ok ? '' : bundleProbe.output,
    )
  }

  const sandboxTests = run(bunBin, ['test', '--isolate'], packageInSandbox, '$ bun test --isolate（沙箱内）')
  const testSummary = sandboxTests.output.split('\n').filter((line) => /Ran \d+ tests|\d+ pass|\d+ fail/.test(line)).join(' · ')
  record('无 provider SDK 下本包测试通过', sandboxTests.ok, testSummary || sandboxTests.output.slice(-500))

  const failures = results.filter((result) => !result.ok)
  console.log(`\n隔离检查：${results.length - failures.length}/${results.length} 通过`)
  if (failures.length > 0) {
    console.error(`失败项：\n${failures.map((failure) => `  - ${failure.name}\n${failure.detail}`).join('\n')}`)
  }
  if (keepSandbox) console.log(`沙箱保留在 ${sandbox}`)
  else rmSync(sandbox, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
