/**
 * 核心可达依赖图（零依赖实现）。
 *
 * 目的：证明 `@profer/agent-runtime` 的根入口**真实可达**的依赖边里没有 provider SDK 和 Electron，
 * 而不是只检查字符串或只删掉直接 import。审计同时沿 `@profer/*` 工作区包继续向内走，
 * 因此能发现"核心自己没写 SDK，却经 shared/core 宽入口间接拉进来"这类传递耦合。
 *
 * 这是 typecheck 视角的图（type-only 边也算边）；value 边额外标记，用于区分运行时加载闭包。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export type DependencyEdgeKind = 'relative' | 'workspace' | 'external'

export interface DependencyEdge {
  from: string
  specifier: string
  kind: DependencyEdgeKind
  /** 仅出现在类型位置（`import type` / `export type` / 类型位置的 `import()`）。 */
  typeOnly: boolean
  resolved?: string
}

export interface DependencyGraph {
  entry: string
  repoRoot: string
  files: string[]
  edges: DependencyEdge[]
  /** 所有无法解析到工作区源码的裸 specifier。 */
  externalSpecifiers: string[]
  /** 仅出现在值位置的裸 specifier —— 即运行时加载必须解析的包。 */
  valueExternalSpecifiers: string[]
}

/**
 * provider / 宿主 SDK 拒绝清单。命中即核心边界违规（无论 type-only 还是 value）。
 * 只列已证实会破坏"核心独立安装/编译/加载"的包，不做泛化猜测。
 */
export const DENIED_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^@earendil-works\//, // Pi SDK（pi-ai / pi-agent-core / pi-coding-agent）
  /^@anthropic-ai\//, // Claude Agent SDK / Anthropic SDK
  /^@modelcontextprotocol\//, // MCP SDK，目前由 provider/宿主持有
  /^typebox$/,
  /^electron$/,
  /^electron\//,
  /^@profer\/core$/, // core 的 providers 入口带 Claude SDK peer
  /^@profer\/core\//,
]

export function isDeniedSpecifier(specifier: string): boolean {
  return DENIED_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier))
}

const SPECIFIER_PATTERN =
  /(?:^|[^\w$])(?:import|export)\s+(type\s+)?(?:\*\s+as\s+[\w$]+\s+|\{[\s\S]*?\}\s+|\*\s+from\s+|)(?:from\s+)?['"]([^'"]+)['"]|(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g

interface RawSpecifier {
  specifier: string
  typeOnly: boolean
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 抽取文件里的 import / export 来源与动态 import。 */
export function collectSpecifiers(file: string): RawSpecifier[] {
  const source = stripComments(readFileSync(file, 'utf8'))
  const found: RawSpecifier[] = []
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const explicitType = Boolean(match[1])
    const specifier = match[2] ?? match[3]
    if (!specifier) continue
    if (match[3] !== undefined) {
      // 类型位置的 `import('x')`（`Promise<import('x').T>`、`: import('x').T`）不算运行时边。
      // 注意：正则可能把前一个定界符一起吃掉，必须把它补回来再判断。
      const before = `${source.slice(0, match.index)}${match[0][0] ?? ''}`.replace(/\s+$/, '')
      found.push({ specifier, typeOnly: /[:<|[&(,]$/.test(before) })
      continue
    }
    found.push({ specifier, typeOnly: explicitType })
  }
  return found
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
}

interface WorkspacePackage {
  dir: string
  name: string
  exports: Record<string, string>
}

function readWorkspacePackage(repoRoot: string, packageName: string): WorkspacePackage | undefined {
  const shortName = packageName.split('/')[1]
  if (!shortName) return undefined
  const dir = join(repoRoot, 'packages', shortName)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name?: string
    exports?: Record<string, string | Record<string, string>>
  }
  const exportsMap: Record<string, string> = {}
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value === 'string') exportsMap[key] = value
    else if (value && typeof value === 'object') {
      const picked = value.types ?? value.import ?? value.default
      if (typeof picked === 'string') exportsMap[key] = picked
    }
  }
  return { dir, name: manifest.name ?? packageName, exports: exportsMap }
}

function resolveWorkspaceSpecifier(repoRoot: string, specifier: string): string | undefined {
  const parts = specifier.split('/')
  const packageName = parts.slice(0, 2).join('/')
  const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.'
  const workspacePackage = readWorkspacePackage(repoRoot, packageName)
  if (!workspacePackage) return undefined
  const matchedKey = Object.keys(workspacePackage.exports).find(
    (key) => key === subpath || (key.endsWith('/*') && subpath.startsWith(key.slice(0, -1))),
  )
  const target = matchedKey
    ? subpath === matchedKey
      ? workspacePackage.exports[matchedKey]!
      : workspacePackage.exports[matchedKey]!.replace('*', subpath.slice(matchedKey.length - 1))
    : './src/index.ts'
  return resolve(workspacePackage.dir, target)
}

export function findRepoRoot(startDir: string): string {
  let current = resolve(startDir)
  while (dirname(current) !== current) {
    if (existsSync(join(current, 'packages', 'agent-runtime', 'package.json'))) return current
    current = dirname(current)
  }
  throw new Error(`未找到包含 packages/agent-runtime 的仓库根目录：${startDir}`)
}

/** 从入口出发，BFS 收集相对 import 与工作区包内部文件（含 shared 的传递可达）。 */
export function collectDependencyGraph(entryFile: string, repoRoot: string): DependencyGraph {
  const entry = resolve(entryFile)
  const files = new Set<string>()
  const edges: DependencyEdge[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (files.has(file)) continue
    files.add(file)
    for (const { specifier, typeOnly } of collectSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelative(file, specifier)
        edges.push({ from: file, specifier, kind: 'relative', typeOnly, ...(resolved ? { resolved } : {}) })
        if (resolved && !files.has(resolved)) queue.push(resolved)
        continue
      }
      if (specifier.startsWith('@profer/')) {
        const resolved = resolveWorkspaceSpecifier(repoRoot, specifier)
        edges.push({ from: file, specifier, kind: 'workspace', typeOnly, ...(resolved ? { resolved } : {}) })
        if (resolved && !files.has(resolved)) queue.push(resolved)
        continue
      }
      edges.push({ from: file, specifier, kind: 'external', typeOnly })
    }
  }
  const external = edges.filter((edge) => edge.kind === 'external')
  const unique = (values: string[]): string[] => [...new Set(values)].sort()
  return {
    entry,
    repoRoot,
    files: [...files].sort(),
    edges,
    externalSpecifiers: unique(external.map((edge) => edge.specifier)),
    valueExternalSpecifiers: unique(external.filter((edge) => !edge.typeOnly).map((edge) => edge.specifier)),
  }
}

export function formatRelative(repoRoot: string, file: string): string {
  return relative(repoRoot, file).replace(/\\/g, '/')
}
