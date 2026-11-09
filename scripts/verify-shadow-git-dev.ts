#!/usr/bin/env bun
/**
 * Shadow Git 底座的真机验证（dev 实例）。
 *
 * 为什么不写成一个 bun test：这里要读**真实的 dev 配置目录**（`~/.profer-dev`）
 * 和真实工作区索引，用真实项目验证「不碰用户 .git、重启能读回、两次采集稳定」。
 * 这些结论依赖真实目录规模与真实 git 状态，临时目录测不出来。
 *
 * 刻意不 import 主进程装配层（workspace-shadow-git.ts）：它经 agent-workspace-manager
 * 依赖 electron 的 safeStorage，普通 bun 进程无法加载。脚本按同一套规则从索引重建
 * 「主根 + 工作区级附加目录」，其余全部走 @profer/session-store 的真实实现。
 *
 * 用法：
 *   bun scripts/verify-shadow-git-dev.ts --dev --slug learning
 *   bun scripts/verify-shadow-git-dev.ts --dev --slug learning --clean
 *
 * 安全约定：
 * - 默认只允许对 `~/.profer-dev` 动手；碰 `~/.profer` 必须显式 `--allow-prod`；
 * - 只写 `<configDir>/workspace-shadow/<workspaceId>/`，不碰工作区；
 * - `--clean` 会删除本次创建的 shadow 仓库，避免在开发机上留下几百 MB 对象。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { rmSync } from 'node:fs'
import {
  WorkspaceShadowRepository,
  deriveAttachedRootId,
  diffShadowTrees,
  isWithinPath,
  normalizeShadowRoots,
  type ShadowRoot,
} from '../packages/session-store/src/shadow-git'
import { workspaceShadowExclusions } from '../apps/electron/src/main/lib/workspace-shadow-exclusions'

interface WorkspaceEntry {
  id: string
  slug: string
  name?: string
  storageMode?: string
  rootPath?: string
}

interface Args {
  configDir: string
  slug?: string
  clean: boolean
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const dev = argv.includes('--dev')
  const allowProd = argv.includes('--allow-prod')
  const explicitConfig = process.env.PROFER_CONFIG_DIR?.trim()
  const configDir = explicitConfig
    ? explicitConfig
    : join(homedir(), dev || !allowProd ? '.profer-dev' : '.profer')
  if (!dev && !allowProd && !explicitConfig) {
    throw new Error('默认只对 ~/.profer-dev 运行：加 --dev，或对正式配置显式加 --allow-prod')
  }
  const slugIndex = argv.indexOf('--slug')
  const slug = slugIndex >= 0 ? argv[slugIndex + 1] : undefined
  return {
    configDir,
    ...(slug ? { slug } : {}),
    clean: argv.includes('--clean'),
    json: argv.includes('--json'),
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function loadWorkspaces(configDir: string): WorkspaceEntry[] {
  const raw = readJson(join(configDir, 'agent-workspaces.json')) as { workspaces?: unknown } | undefined
  if (!raw || !Array.isArray(raw.workspaces)) return []
  return raw.workspaces.filter((entry): entry is WorkspaceEntry => {
    if (!entry || typeof entry !== 'object') return false
    const candidate = entry as WorkspaceEntry
    return typeof candidate.id === 'string' && typeof candidate.slug === 'string'
  })
}

function workspaceRoot(entry: WorkspaceEntry, configDir: string): string {
  if (typeof entry.rootPath === 'string' && isAbsolute(entry.rootPath)) return entry.rootPath
  return join(configDir, 'agent-workspaces', entry.slug)
}

/** 工作区级 config.json：managed 在 `<configDir>/agent-workspaces/<slug>/`，project 在 `<root>/.profer/`。 */
function readAttachedDirectories(entry: WorkspaceEntry, rootPath: string, configDir: string): string[] {
  const configPath =
    typeof entry.rootPath === 'string' && isAbsolute(entry.rootPath)
      ? join(rootPath, '.profer', 'config.json')
      : join(configDir, 'agent-workspaces', entry.slug, 'config.json')
  const raw = readJson(configPath) as { attachedDirectories?: unknown } | undefined
  if (!raw || !Array.isArray(raw.attachedDirectories)) return []
  return raw.attachedDirectories.filter((value): value is string => typeof value === 'string' && isAbsolute(value))
}

/** 与 workspace-shadow-git.ts 相同的规则：先 realpath，再丢弃嵌套在主根内的附加根。 */
function buildRoots(entry: WorkspaceEntry, configDir: string): ShadowRoot[] {
  const rawRoot = workspaceRoot(entry, configDir)
  const primaryRootPath = realpathOrSelf(rawRoot)
  const primary: ShadowRoot = {
    rootId: entry.id,
    rootPath: primaryRootPath,
    kind: typeof entry.rootPath === 'string' && isAbsolute(entry.rootPath) ? 'project' : 'managed',
  }
  const attached = readAttachedDirectories(entry, rawRoot, configDir).map((value) => {
    const canonical = realpathOrSelf(value)
    return { rootId: deriveAttachedRootId(canonical), rootPath: canonical, kind: 'attached' as const }
  })
  return normalizeShadowRoots([
    primary,
    ...attached.filter((root) => !isWithinPath(primary.rootPath, root.rootPath) && root.rootPath !== primary.rootPath),
  ])
}

function primaryMode(entry: WorkspaceEntry): 'managed' | 'project' {
  return typeof entry.rootPath === 'string' && isAbsolute(entry.rootPath) ? 'project' : 'managed'
}

function realpathOrSelf(pathValue: string): string {
  try {
    return require('node:fs').realpathSync(pathValue)
  } catch {
    return pathValue
  }
}

function gitPath(): string {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('未找到 git')
}

async function dirSize(pathValue: string): Promise<string> {
  const result = Bun.spawnSync({ cmd: ['du', '-sh', pathValue] })
  return result.stdout.toString().split('\t')[0] ?? '?'
}

const args = parseArgs(process.argv.slice(2))
const entries = loadWorkspaces(args.configDir)
const targets = args.slug ? entries.filter((entry) => entry.slug === args.slug) : entries
if (targets.length === 0) {
  console.error(`没有匹配的工作区（configDir=${args.configDir}${args.slug ? `, slug=${args.slug}` : ''}）`)
  console.error(`可用 slug: ${entries.map((entry) => entry.slug).join(', ')}`)
  process.exit(1)
}

const gitExecutable = gitPath()
const report: Record<string, unknown>[] = []

for (const entry of targets) {
  const roots = buildRoots(entry, args.configDir)
  const repoDir = join(args.configDir, 'workspace-shadow', entry.id, 'repo.git')
  const repoParent = join(args.configDir, 'workspace-shadow', entry.id)
  const lines: string[] = []
  lines.push(`\n=== ${entry.name ?? entry.slug} (${entry.slug}) ===`)
  lines.push(`配置目录: ${args.configDir}`)
  lines.push(`shadow 仓库: ${repoDir}`)
  for (const root of roots) {
    lines.push(`  根 ${root.kind.padEnd(8)} ${root.rootId} → ${root.rootPath}`)
  }

  const repository = await WorkspaceShadowRepository.open({
    workspaceId: entry.id,
    repoDir,
    journalPath: join(repoParent, 'journal.json'),
    gitPath: gitExecutable,
    tempDir: join(repoParent, 'tmp'),
    // 与主进程装配层同一套规则：Profer 私有目录不进基线，用户源码目录不误排。
    excludeAbsolutePaths: () => [
      repoParent,
      ...workspaceShadowExclusions({ storageMode: primaryMode(entry), rootPath: roots[0]?.rootPath ?? '' }),
    ],
  })

  const before = await snapshotUserGit(entry, roots, gitExecutable)
  const first = await repository.capture({ reason: 'initial', roots })
  if (!first.ok) {
    lines.push(`采集失败: ${first.error ?? 'unknown'}`)
    console.log(lines.join('\n'))
    report.push({ slug: entry.slug, ok: false, error: first.error })
    continue
  }

  // 紧接着再采一次：工作区没变时两次 tree 必须逐字相同，否则说明枚举/哈希不稳定。
  const second = await repository.capture({ reason: 'startup-reconcile', roots })
  const diff = second.ok
    ? await diffShadowTrees(createRunner(), repoDir, first.treeSha, second.treeSha)
    : undefined
  const after = await snapshotUserGit(entry, roots, gitExecutable)
  const state = await repository.readState()

  lines.push(
    `采集: ${first.roots.map((root) => `${root.fileCount} 文件`).join(' + ')} / ${first.completedAt - first.startedAt}ms（重哈希 ${sumHashed(first)}，复用 ${sumReused(first)}）`,
  )
  lines.push(
    `第二次: ${second.ok ? `${second.completedAt - second.startedAt}ms（重哈希 ${sumHashed(second)}，复用 ${sumReused(second)}）` : '失败'}`,
  )
  lines.push(`commit: ${first.commitId}`)
  lines.push(`tree:   ${first.treeSha}`)
  const skipped = first.roots.flatMap((root) => root.skipped)
  if (skipped.length > 0) {
    const byReason = new Map<string, number>()
    for (const item of skipped) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
    lines.push(`跳过: ${[...byReason].map(([reason, count]) => `${reason}×${count}`).join(', ')}`)
  }
  const partial = first.roots.filter((root) => root.partial)
  if (partial.length > 0) lines.push(`不完整: ${partial.map((root) => root.rootId).join(', ')}`)
  if (diff?.ok) {
    const total = diff.diff.added.length + diff.diff.modified.length + diff.diff.deleted.length
    lines.push(`重复采集 diff: ${total === 0 ? '空（稳定）' : `+${diff.diff.added.length} ~${diff.diff.modified.length} -${diff.diff.deleted.length}`}`)
  } else {
    lines.push(`重复采集 diff: 不可用（${diff?.error ?? 'capture failed'}）`)
  }
  lines.push(`重启读回: head=${state.headCommitId ?? '无'} tree=${state.headTreeSha ?? '无'}`)
  for (const [index, root] of roots.entries()) {
    const beforeState = before[index]
    const afterState = after[index]
    if (!beforeState || !afterState) continue
    const unchanged = beforeState.status === afterState.status && beforeState.head === afterState.head
    lines.push(`用户 git ${root.kind}: ${unchanged ? '未改变' : '已改变（异常）'}`)
  }
  lines.push(`仓库体积: ${await dirSize(repoParent)}`)

  if (args.clean) {
    rmSync(repoParent, { recursive: true, force: true })
    lines.push('已清理 shadow 仓库')
  }

  console.log(lines.join('\n'))
  report.push({
    slug: entry.slug,
    ok: true,
    files: first.roots.map((root) => root.fileCount),
    partial: partial.map((root) => root.rootId),
    skipped: skipped.length,
    stable: diff?.ok ? diff.diff.added.length + diff.diff.modified.length + diff.diff.deleted.length === 0 : false,
    head: state.headCommitId,
    userGitUnchanged: roots.every((_, index) => before[index]?.status === after[index]?.status && before[index]?.head === after[index]?.head),
  })
}

function sumHashed(result: { roots: Array<{ hashed?: number }> }): number {
  return result.roots.reduce((total, root) => total + (root.hashed ?? 0), 0)
}

function sumReused(result: { roots: Array<{ reused?: number }> }): number {
  return result.roots.reduce((total, root) => total + (root.reused ?? 0), 0)
}

function createRunner() {
  return {
    gitPath: gitExecutable,
    async run(commandArgs: string[], options: { gitDir?: string; workTree?: string } = {}) {
      const full: string[] = []
      if (options.gitDir) full.push('--git-dir', options.gitDir)
      if (options.workTree) full.push('--work-tree', options.workTree)
      full.push(...commandArgs)
      const proc = Bun.spawnSync({ cmd: [gitExecutable, ...full] })
      return {
        ok: proc.exitCode === 0,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        code: proc.exitCode,
      }
    },
  }
}

async function snapshotUserGit(
  entry: WorkspaceEntry,
  roots: ShadowRoot[],
  executable: string,
): Promise<Array<{ status: string; head: string }>> {
  void entry
  const results: Array<{ status: string; head: string }> = []
  for (const root of roots) {
    const run = (cmd: string[]) => {
      const proc = Bun.spawnSync({ cmd: [executable, '-C', root.rootPath, ...cmd] })
      return { ok: proc.exitCode === 0, stdout: proc.stdout.toString() }
    }
    if (!existsSync(join(root.rootPath, '.git'))) {
      results.push({ status: '<no-git>', head: '<no-git>' })
      continue
    }
    results.push({ status: run(['status', '--porcelain']).stdout, head: run(['rev-parse', 'HEAD']).stdout })
  }
  return results
}

if (args.json) console.log(JSON.stringify(report, null, 2))
