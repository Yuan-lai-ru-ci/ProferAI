#!/usr/bin/env bun
/**
 * run-isolation-check.ts —— Pi provider 的「发行组合隔离」验证器（GAP-7 E1）。
 *
 * 与 `packages/agent-runtime/test/isolation/run-isolation-check.ts` 同一套 `os.tmpdir()` 沙箱模式：
 * 只有把沙箱放到仓库之外，「另一个 provider 的 SDK / Electron 不可解析」才不是假阳性
 * （只要沙箱还有 monorepo 祖先，Node/Bun 的解析会一路向上找到它们）。
 *
 * 本脚本在沙箱里做四件事（全部是真实行为，不是字符串检查）：
 *   1. 断言沙箱及其**所有祖先**都没有 `@anthropic-ai/claude-agent-sdk` 与 `electron`（含反证：
 *      这些 specifier 从沙箱出发必须解析失败；同时断言自有 Pi SDK **可以**解析，证明沙箱非空壳）；
 *   2. typecheck（含反证：显式注入禁用依赖必须报 TS2307）；
 *   3. `bun build` 打包 + 加载构建产物 + 加载源码入口（断言适配器导出面存在、禁用依赖不可加载）；
 *   4. 跑最小 runner 与包内测试。
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
const bunBin = process.execPath
const keepSandbox = process.argv.includes('--keep')

/** 本组合必须能解析的 specifier（Pi SDK 与其运行时依赖）。 */
const OWN_SDK_SPECIFIERS = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  'typebox',
  'undici',
]

/** 沙箱与祖先都必须「连解析都不成立」的 specifier：另一个 provider 的 SDK + Electron。 */
const FORBIDDEN_SPECIFIERS = ['@anthropic-ai/claude-agent-sdk', 'electron']

/** 构建产物里出现即说明禁用依赖被内联。 */
const FORBIDDEN_BUNDLE_MARKERS = ['@anthropic-ai/claude-agent-sdk']

/** 只复制 provider 无关的支撑包（版本来自本仓库已解析依赖树，不联网、不升级）。 */
const SUPPORT_PACKAGES = ['typescript', '@types']

/**
 * 工作区包在真实仓库里能解析到、而 provider 自身未声明的依赖（按 lane 根解析后链接）。
 *
 * `dompurify`：`@profer/shared` 的依赖，其自带类型是 `@types/dompurify` 的实体，
 * 缺失会让 tsc 报 `Cannot find type definition file for 'dompurify'`（隐式类型库入口）。
 */
const WORKSPACE_SUPPORT_SPECIFIERS = ['dompurify']

const WORKSPACE_PACKAGES = ['shared', 'agent-fabric', 'agent-runtime', 'core', 'agent-provider-pi']

const ADAPTER_EXPORT = 'PiAgentAdapter'
const RUNNER_PATH = 'test/minimal-pi-runner.ts'
const RUNNER_EXPECT = '通过'

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

function forbiddenHitsIn(nodeModulesDir: string, specifiers: readonly string[]): string[] {
  return specifiers.map(name => join(nodeModulesDir, name)).filter(candidate => existsSync(candidate))
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

function linkSpecifier(sandbox: string, specifier: string): void {
  const manifest = Bun.resolveSync(`${specifier}/package.json`, packageDir)
  const target = dirname(manifest)
  const linkPath = join(sandbox, 'node_modules', specifier)
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, 'dir')
}

function prepareSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'profer-provider-pi-isolation-'))
  mkdirSync(join(sandbox, 'packages'), { recursive: true })
  mkdirSync(join(sandbox, 'node_modules', '@profer'), { recursive: true })
  writeFileSync(join(sandbox, 'package.json'), `${JSON.stringify({
    name: 'profer-provider-pi-isolation',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
  }, null, 2)}\n`)
  writeFileSync(join(sandbox, 'tsconfig.json'), readFileSync(join(laneRoot, 'tsconfig.json')))

  for (const name of WORKSPACE_PACKAGES) {
    copyTree(join(laneRoot, 'packages', name), join(sandbox, 'packages', name))
  }
  for (const name of ['shared', 'agent-fabric', 'agent-runtime', 'core']) {
    symlinkSync(join(sandbox, 'packages', name), join(sandbox, 'node_modules', '@profer', name), 'dir')
  }

  for (const name of SUPPORT_PACKAGES) {
    const from = join(laneRoot, 'node_modules', name)
    if (!existsSync(from)) throw new Error(`缺少 provider 无关的支撑包 ${name}：${from}`)
    const to = join(sandbox, 'node_modules', name)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, dereference: true })
  }
  const bunTypesDir = resolveBunTypesDir()
  cpSync(bunTypesDir, join(sandbox, 'node_modules', 'bun-types'), { recursive: true, dereference: true })
  // `bun-types` 的 `fetch.d.ts` / `globals.d.ts` 用 `import("undici-types")` 取全局 `Response` 等类型。
  // 这个解析必须与仓库内一致：解析不到时 `Response` 会退化成空接口，
  // 让 `@profer/core` 的 fetch 调用出现一堆假错误（本检查踩过的坑）。
  symlinkSync(
    dirname(Bun.resolveSync('undici-types/package.json', bunTypesDir)),
    join(sandbox, 'node_modules', 'undici-types'),
    'dir',
  )
  for (const specifier of WORKSPACE_SUPPORT_SPECIFIERS) {
    const target = dirname(Bun.resolveSync(`${specifier}/package.json`, laneRoot))
    const linkPath = join(sandbox, 'node_modules', specifier)
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, 'dir')
  }

  // 自有 SDK 与其运行时依赖：指向本仓库已解析的真实目录（不联网、不升级）。
  for (const specifier of OWN_SDK_SPECIFIERS) linkSpecifier(sandbox, specifier)

  return sandbox
}

function checkResolvability(sandbox: string): void {
  // 祖先从沙箱的父目录开始（沙箱自身由下面的「沙箱 node_modules」检查负责），
  // 否则「祖先不含禁用依赖」会被自己的 node_modules 顶掉。
  const ancestors = listAncestorNodeModules(dirname(resolve(sandbox)))
  const ancestorHits = ancestors.flatMap(dir => forbiddenHitsIn(dir, FORBIDDEN_SPECIFIERS))
  record(
    '沙箱祖先不含另一套 SDK / Electron',
    ancestorHits.length === 0,
    ancestorHits.length === 0 ? `已检查 ${ancestors.length} 个祖先 node_modules` : `发现：${ancestorHits.join(', ')}`,
  )

  const sandboxHits = forbiddenHitsIn(join(sandbox, 'node_modules'), FORBIDDEN_SPECIFIERS)
  record('沙箱 node_modules 不含另一套 SDK / Electron', sandboxHits.length === 0, sandboxHits.join(', '))

  const resolved: string[] = []
  for (const specifier of FORBIDDEN_SPECIFIERS) {
    try {
      resolved.push(`${specifier} -> ${Bun.resolveSync(specifier, sandbox)}`)
    } catch {
      // 预期：解析失败
    }
  }
  record(
    '禁用依赖全部不可解析（反证，证明其余检查有区分度）',
    resolved.length === 0,
    resolved.length === 0 ? `${FORBIDDEN_SPECIFIERS.length} 个 specifier 均解析失败` : `意外可解析：${resolved.join('; ')}`,
  )

  const ownResolved: string[] = []
  const ownFailed: string[] = []
  for (const specifier of OWN_SDK_SPECIFIERS) {
    try {
      ownResolved.push(Bun.resolveSync(specifier, sandbox))
    } catch {
      ownFailed.push(specifier)
    }
  }
  record(
    '自有 Pi SDK 全部可解析（正向对照，证明沙箱不是空壳）',
    ownFailed.length === 0,
    ownFailed.length === 0 ? `${ownResolved.length} 个 specifier 均已解析` : `不可解析：${ownFailed.join(', ')}`,
  )
}

function main(): void {
  const sandbox = prepareSandbox()
  console.log(`沙箱：${sandbox}\n`)
  checkResolvability(sandbox)

  const packageInSandbox = join(sandbox, 'packages', 'agent-provider-pi')
  const tsconfigPath = join(packageInSandbox, 'tsconfig.json')
  const tsc = join(sandbox, 'node_modules', 'typescript', 'bin', 'tsc')

  const typecheck = run(bunBin, [tsc, '--noEmit', '-p', tsconfigPath], packageInSandbox, '$ tsc --noEmit（provider 包）')
  record('隔离环境 typecheck 通过', typecheck.ok, typecheck.ok ? '' : typecheck.output)

  // 反证：同一个 tsc + 同一个 tsconfig，注入禁用依赖必须失败。
  const negativeProbePath = join(packageInSandbox, 'src', 'isolation-negative-probe.ts')
  writeFileSync(
    negativeProbePath,
    `import type { Probe } from '${FORBIDDEN_SPECIFIERS[0]}'\nexport type IsolationNegativeProbe = Probe\n`,
  )
  const negative = run(bunBin, [tsc, '--noEmit', '-p', tsconfigPath], packageInSandbox, '$ tsc --noEmit（注入禁用依赖的反证）')
  rmSync(negativeProbePath, { force: true })
  record(
    'typecheck 反证：显式注入禁用依赖会失败',
    !negative.ok && /Cannot find module|TS2307/.test(negative.output),
    negative.ok ? `注入 ${FORBIDDEN_SPECIFIERS[0]} 后 tsc 仍通过，隔离无效` : '注入后按预期报 TS2307',
  )

  const build = run(
    bunBin,
    ['build', './packages/agent-provider-pi/src/index.ts', '--target=node', '--outfile', './out/agent-provider-pi.js'],
    sandbox,
    '$ bun build src/index.ts --target=node',
  )
  const bundlePath = join(sandbox, 'out', 'agent-provider-pi.js')
  const bundleExists = existsSync(bundlePath)
  record(
    '隔离环境构建通过',
    build.ok && bundleExists,
    build.ok ? (bundleExists ? `${(statSync(bundlePath).size / 1024).toFixed(1)} KB` : '缺少产物') : build.output,
  )
  if (bundleExists) {
    const source = readFileSync(bundlePath, 'utf8')
    const leaked = FORBIDDEN_BUNDLE_MARKERS.filter(marker => source.includes(marker))
    const electronSpecifier = /(from\s*["']electron["'])|(require\(\s*["']electron["']\s*\))/.test(source)
    record(
      '构建产物未内联禁用依赖',
      leaked.length === 0 && !electronSpecifier,
      [...leaked, ...(electronSpecifier ? ['electron specifier'] : [])].join(', ') || '',
    )
  }

  const probePath = join(sandbox, 'probe-entry.ts')
  writeFileSync(probePath, [
    'const [entryPath, label] = process.argv.slice(2) as [string, string]',
    'const mod = await import(entryPath) as Record<string, unknown>',
    `if (typeof mod[${JSON.stringify(ADAPTER_EXPORT)}] !== 'function') throw new Error('缺少导出 ${ADAPTER_EXPORT}')`,
    `for (const specifier of ${JSON.stringify(FORBIDDEN_SPECIFIERS)}) {`,
    '  try { await import(specifier); throw new Error(`禁用依赖仍可加载: ${specifier}`) } catch (error) {',
    "    if (error instanceof Error && error.message.startsWith('禁用依赖仍可加载')) throw error",
    '  }',
    '}',
    'console.log(`probe-ok:${label}`)',
    '',
  ].join('\n'))
  if (bundleExists) {
    const bundleProbe = run(bunBin, [probePath, bundlePath, 'out/agent-provider-pi.js'], sandbox, '$ bun probe-entry.ts（加载构建产物）')
    record(
      '构建产物可加载、导出面完整、禁用依赖不可加载',
      bundleProbe.ok && bundleProbe.output.includes('probe-ok:out/agent-provider-pi.js'),
      bundleProbe.ok ? '' : bundleProbe.output,
    )
  }
  const sourceProbe = run(
    bunBin,
    [probePath, join(packageInSandbox, 'src', 'index.ts'), 'src/index.ts'],
    sandbox,
    '$ bun probe-entry.ts（加载源码入口）',
  )
  record(
    '源码入口可加载、导出面完整、禁用依赖不可加载',
    sourceProbe.ok && sourceProbe.output.includes('probe-ok:src/index.ts'),
    sourceProbe.ok ? '' : sourceProbe.output,
  )

  const runner = run(bunBin, [RUNNER_PATH], packageInSandbox, `$ bun ${RUNNER_PATH}`)
  record('最小 runner 通过（非 Electron 生命周期）', runner.ok && runner.output.includes(RUNNER_EXPECT), runner.ok ? '' : runner.output)

  const sandboxTests = run(bunBin, ['test', '--isolate'], packageInSandbox, '$ bun test --isolate（沙箱内）')
  const testSummary = sandboxTests.output.split('\n').filter(line => /Ran \d+ tests|\d+ pass|\d+ fail/.test(line)).join(' · ')
  record('隔离环境包内测试通过', sandboxTests.ok, testSummary || sandboxTests.output.slice(-500))

  const failures = results.filter(result => !result.ok)
  console.log(`\nPi provider 隔离检查：${results.length - failures.length}/${results.length} 通过`)
  if (failures.length > 0) {
    console.error(`失败项：\n${failures.map(failure => `  - ${failure.name}\n${failure.detail}`).join('\n')}`)
  }
  if (keepSandbox) console.log(`沙箱保留在 ${sandbox}`)
  else rmSync(sandbox, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
}

main()
