/**
 * 核心边界回归守卫。
 *
 * 断言的不是"源码里没有 SDK 字符串"，而是从根入口**可达**的依赖图里没有 provider SDK/Electron，
 * 并且运行时导出面、package 声明与实际加载行为一致。任何一条失败都说明脊柱又被肋骨绑上了。
 * 完整缺席验证（无 node_modules 可向上逃逸的沙箱 + 构建 + 加载）见 `run-isolation-check.ts`。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectDependencyGraph,
  findRepoRoot,
  formatRelative,
  isDeniedSpecifier,
} from './dependency-graph'
import { assertCoreEntryModule } from './probe-entry'

const packageRoot = join(import.meta.dir, '..', '..')
const repoRoot = findRepoRoot(import.meta.dir)
const entry = join(packageRoot, 'src', 'index.ts')

describe('core dependency boundary', () => {
  test('Given the core entry When walking reachable imports Then no provider SDK or Electron edge exists', () => {
    const graph = collectDependencyGraph(entry, repoRoot)
    const offenders = graph.edges
      .filter((edge) => isDeniedSpecifier(edge.specifier))
      .map((edge) => `${formatRelative(repoRoot, edge.from)} -> ${edge.specifier} (${edge.typeOnly ? 'type' : 'value'})`)

    expect(offenders).toEqual([])
    // 图必须真的走到了 shared 内部，否则"不经 shared/core 间接加载 SDK"没有被验证。
    const visited = graph.files.map((file) => formatRelative(repoRoot, file))
    expect(visited).toContain('packages/agent-runtime/src/index.ts')
    expect(visited.some((file) => file.startsWith('packages/shared/src/'))).toBe(true)
    expect(visited.some((file) => file.startsWith('packages/agent-fabric/src/'))).toBe(true)
    const fabric = collectDependencyGraph(join(repoRoot, 'packages', 'agent-fabric', 'src', 'index.ts'), repoRoot)
    expect(fabric.edges.filter((edge) => edge.specifier.startsWith('@profer/agent-runtime'))).toEqual([])
    expect(fabric.files.some((file) => file.startsWith(join(repoRoot, 'packages', 'agent-runtime')))).toBe(false)
  })

  test('Given the core entry When resolving the runtime closure Then it needs no bare external package', () => {
    const graph = collectDependencyGraph(entry, repoRoot)
    expect(graph.valueExternalSpecifiers).toEqual([])
    expect(graph.externalSpecifiers.filter(isDeniedSpecifier)).toEqual([])
  })

  test('Given the package manifest When declaring dependencies Then only shared and fabric workspace packages remain', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      exports?: Record<string, string>
    }
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]
    expect(declared.filter(isDeniedSpecifier)).toEqual([])
    expect(manifest.dependencies).toEqual({ '@profer/agent-fabric': 'workspace:*', '@profer/shared': 'workspace:*' })
    const exportedSubpaths = Object.keys(manifest.exports ?? {})
    expect(exportedSubpaths.filter((subpath) => subpath.startsWith('./pi'))).toEqual([])
    expect(exportedSubpaths).toContain('.')
  })

  test('Given provider implementations moved out When inspecting the core package Then no provider source directory returns', () => {
    for (const removed of ['src/pi', 'src/claude', 'src/pi-retry-control.ts', 'src/pi-streaming-control.ts']) {
      expect({ removed, exists: existsSync(join(packageRoot, removed)) }).toEqual({ removed, exists: false })
    }
  })

  test('Given the loaded core entry When probing its surface Then provider exports are gone, host seams remain and unregistered runtimes stay unavailable', async () => {
    const core = (await import(entry)) as Record<string, unknown>
    await assertCoreEntryModule(core, 'src/index.ts')
  })

  test('Given the core sources When reading the entry file Then it re-exports no provider module', () => {
    const entrySource = readFileSync(entry, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const providerReExports = [...entrySource.matchAll(/from\s+'([^']+)'/g)]
      .map((match) => match[1]!)
      .filter((specifier) => /(?:^|\/)(pi|claude)(?:\/|$)/.test(specifier))
    expect(providerReExports).toEqual([])
    // 入口必须指向真实的同目录核心模块，避免变成空壳。
    expect(entrySource).toContain("from './contract'")
    expect(entrySource).toContain("from './ports'")
  })
})
