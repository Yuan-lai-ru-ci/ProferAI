/**
 * Shadow Git「Git 层」的端到端测试。
 *
 * 全部在 os.tmpdir() 的真实目录里跑：这一层的行为完全由 git 决定（索引、tree、
 * ref、路径引用规则），mock 掉 git 只会测到自己的想象，测不到 `read-tree --prefix`
 * 在 bare 仓库里的真实约束。用户仓库一律是临时目录里的假仓库，测试不会碰任何真实项目。
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { GitRunner } from './git-command'
import { createGitRunner } from './git-command'
import { ShadowJournal } from './journal'
import { WorkspaceShadowRepository } from './repository'
import { diffShadowTrees } from './tree-builder'
import type { ShadowRoot } from './types'

function findGitPath(): string | null {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, executable))
    .find((candidate) => existsSync(candidate))
  if (fromPath) return fromPath
  const wellKnown =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\cmd\\git.exe']
      : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
  return wellKnown.find((candidate) => existsSync(candidate)) ?? null
}

/** 没装 git 时整组跳过：缺 git 是环境问题，不是代码回归。 */
const gitPath = findGitPath()
const TEST_TIMEOUT_MS = 30_000

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    } catch {
      /* Windows 上对象文件可能仍被句柄占用，残留的临时目录由系统回收 */
    }
  }
})

interface ShadowSetup {
  baseDir: string
  rootA: string
  rootB: string
  repoDir: string
  journalPath: string
  runner: GitRunner
  roots: ShadowRoot[]
}

const ROOT_A_ID = 'root-a'
const ROOT_B_ID = 'root-b'

/**
 * 两个根：A 带子目录 + 中文目录 + 带空格文件名，B 带子目录。
 * 中文与空格是有意为之——它们是最容易在 pathspec / ls-tree 解析里翻车的输入。
 */
async function createSetup(options: { userGitRepo?: boolean; noise?: boolean } = {}): Promise<ShadowSetup> {
  const baseDir = makeTempDir('profer-shadow-git-')
  const rootA = join(baseDir, 'root-a')
  const rootB = join(baseDir, 'root-b')
  mkdirSync(join(rootA, 'sub'), { recursive: true })
  mkdirSync(join(rootA, '中文目录'), { recursive: true })
  mkdirSync(join(rootB, 'docs'), { recursive: true })
  writeFileSync(join(rootA, 'sub', 'a.txt'), 'a1', 'utf8')
  writeFileSync(join(rootA, 'gone.txt'), 'to-be-deleted', 'utf8')
  writeFileSync(join(rootA, '中文目录', '名 称.txt'), 'cn1', 'utf8')
  writeFileSync(join(rootB, 'b.txt'), 'b1', 'utf8')
  writeFileSync(join(rootB, 'docs', '说明 文档.md'), 'doc1', 'utf8')
  if (options.noise) {
    mkdirSync(join(rootA, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(rootA, 'node_modules', 'pkg', 'index.js'), 'noise', 'utf8')
  }

  const runner = createGitRunner({ gitPath: gitPath ?? 'git' })
  if (options.userGitRepo) {
    // 模拟真实项目：根目录自己就是一个 git 仓库，并且有一处未提交修改。
    writeFileSync(join(rootA, 'tracked.txt'), 'v1', 'utf8')
    await runOrThrow(runner, ['-C', rootA, 'init'])
    await runOrThrow(runner, ['-C', rootA, 'add', '-A'])
    await runOrThrow(runner, [
      '-C',
      rootA,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@localhost',
      'commit',
      '-m',
      'init',
    ])
    writeFileSync(join(rootA, 'tracked.txt'), 'v2-uncommitted', 'utf8')
  }

  return {
    baseDir,
    rootA,
    rootB,
    repoDir: join(baseDir, 'shadow.git'),
    journalPath: join(baseDir, 'journal.json'),
    runner,
    roots: [
      { rootId: ROOT_A_ID, rootPath: rootA, kind: 'project' },
      { rootId: ROOT_B_ID, rootPath: rootB, kind: 'attached' },
    ],
  }
}

function runOrThrow(runner: GitRunner, args: string[]): Promise<string> {
  return runner.run(args).then((result) => {
    if (!result.ok) throw new Error(`git ${args.join(' ')} 失败：${result.stderr.trim()}`)
    return result.stdout
  })
}

async function openRepository(setup: ShadowSetup): Promise<WorkspaceShadowRepository> {
  return WorkspaceShadowRepository.open({
    workspaceId: 'workspace-test',
    repoDir: setup.repoDir,
    journalPath: setup.journalPath,
    gitPath: gitPath ?? 'git',
  })
}

async function listTreePaths(runner: GitRunner, repoDir: string, treeSha: string): Promise<string[]> {
  const result = await runner.run(['ls-tree', '-r', '-z', '--name-only', treeSha], { gitDir: repoDir })
  expect(result.ok).toBe(true)
  return result.stdout.split('\u0000').filter((entry) => entry.length > 0)
}

test.skipIf(!gitPath)(
  'capture：两个根按 roots/<rootId>/... 合成一棵 tree',
  async () => {
    const setup = await createSetup()
    const repository = await openRepository(setup)
    const result = await repository.capture({ reason: 'initial', roots: setup.roots })

    expect(result.ok).toBe(true)
    expect(result.commitId).toMatch(/^[0-9a-f]{40,64}$/)
    expect(result.roots.map((root) => root.rootId)).toEqual([ROOT_A_ID, ROOT_B_ID])

    const paths = await listTreePaths(setup.runner, setup.repoDir, result.treeSha)
    expect(paths).toContain(`roots/${ROOT_A_ID}/sub/a.txt`)
    expect(paths).toContain(`roots/${ROOT_A_ID}/中文目录/名 称.txt`)
    expect(paths).toContain(`roots/${ROOT_B_ID}/b.txt`)
    expect(paths).toContain(`roots/${ROOT_B_ID}/docs/说明 文档.md`)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '第二次 capture：diff 正确报告新增/修改/删除，且父提交指向上一次',
  async () => {
    const setup = await createSetup()
    const repository = await openRepository(setup)
    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)

    writeFileSync(join(setup.rootA, 'sub', 'a.txt'), 'a2', 'utf8')
    unlinkSync(join(setup.rootA, 'gone.txt'))
    writeFileSync(join(setup.rootA, 'new.txt'), 'new', 'utf8')

    const second = await repository.capture({ reason: 'turn-after', roots: setup.roots })
    expect(second.ok).toBe(true)
    expect(second.commitId).not.toBe(first.commitId)

    const diff = await diffShadowTrees(setup.runner, setup.repoDir, first.treeSha, second.treeSha)
    expect(diff.ok).toBe(true)
    expect(diff.diff.added).toEqual([`roots/${ROOT_A_ID}/new.txt`])
    expect(diff.diff.modified).toEqual([`roots/${ROOT_A_ID}/sub/a.txt`])
    expect(diff.diff.deleted).toEqual([`roots/${ROOT_A_ID}/gone.txt`])

    const parent = await setup.runner.run(['rev-parse', `${second.commitId}^`], { gitDir: setup.repoDir })
    expect(parent.ok).toBe(true)
    expect(parent.stdout.trim()).toBe(first.commitId)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  'journal 与 readState：新实例能读回 head commit',
  async () => {
    const setup = await createSetup()
    const repository = await openRepository(setup)
    const result = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(result.ok).toBe(true)

    expect(existsSync(setup.journalPath)).toBe(true)
    const journal = ShadowJournal.open(setup.journalPath, 'workspace-test')
    const latest = journal.latestCompleted()
    expect(latest?.captureId).toBe(result.captureId)
    expect(latest?.commitId).toBe(result.commitId)
    expect(latest?.treeSha).toBe(result.treeSha)
    expect(latest?.status).toBe('completed')

    // 新实例模拟重启：ref 与 journal 都在磁盘上，不依赖内存状态。
    const reopened = await openRepository(setup)
    const state = await reopened.readState()
    expect(state.headCommitId).toBe(result.commitId)
    expect(state.headTreeSha).toBe(result.treeSha)
    expect(state.lastCapture?.captureId).toBe(result.captureId)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '用户仓库隔离：capture 不改变用户仓库的 status 与 HEAD',
  async () => {
    const setup = await createSetup({ userGitRepo: true })
    const readState = async (): Promise<{ status: string; head: string }> => {
      const status = await runOrThrow(setup.runner, ['-C', setup.rootA, 'status', '--porcelain'])
      const head = (await runOrThrow(setup.runner, ['-C', setup.rootA, 'rev-parse', 'HEAD'])).trim()
      return { status, head }
    }

    const before = await readState()
    expect(before.status.trim()).toBe('M tracked.txt')

    const repository = await openRepository(setup)
    const result = await repository.capture({ reason: 'turn-before', roots: setup.roots })
    expect(result.ok).toBe(true)

    // 用户的工作区、索引、HEAD 都必须原样：shadow 只在自己的 bare 仓库里写对象。
    expect(await readState()).toEqual(before)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '排除规则：node_modules 与 .git 下的文件不进入 tree',
  async () => {
    const setup = await createSetup({ userGitRepo: true, noise: true })
    const repository = await openRepository(setup)
    const result = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(result.ok).toBe(true)

    const paths = await listTreePaths(setup.runner, setup.repoDir, result.treeSha)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.some((path) => path.includes('/node_modules/'))).toBe(false)
    expect(paths.some((path) => path.includes('/.git/'))).toBe(false)
    // 反向确认：断言不是「整棵树是空的」这种假通过。
    expect(paths).toContain(`roots/${ROOT_A_ID}/sub/a.txt`)
  },
  TEST_TIMEOUT_MS,
)
