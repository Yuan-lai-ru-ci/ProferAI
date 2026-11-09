/**
 * Shadow Git 底座的集成测试（我补的安全边界）。
 *
 * 三层单测各自覆盖自己的形状，这里只验证三件「跨层才会暴露」的事：
 * 1. 根目录不可见时，绝不能用空树生成一次快照（否则等价于「文件全被删除」）；
 * 2. 同一工作区的并发采集必须串行成一条父链，不能互相覆盖 head ref；
 * 3. 采集部分失败（partial）时，journal 与结果都保留这个事实。
 *
 * 全部在 os.tmpdir() 的真实目录里跑；找不到 git 时整组跳过。
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createGitRunner } from './git-command'
import { ShadowJournal } from './journal'
import { WorkspaceShadowRepository } from './repository'
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

const gitPath = findGitPath()
const TEST_TIMEOUT_MS = 30_000
const WORKSPACE_ID = 'workspace-shadow-integration'

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
      /* 句柄未释放时留给系统回收，不让清理失败掩盖断言结果 */
    }
  }
})

interface Setup {
  baseDir: string
  rootPath: string
  repoDir: string
  journalPath: string
  roots: ShadowRoot[]
}

function createSetup(): Setup {
  const baseDir = makeTempDir('profer-shadow-integration-')
  const rootPath = join(baseDir, 'root')
  mkdirSync(join(rootPath, 'src'), { recursive: true })
  writeFileSync(join(rootPath, 'src', 'index.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(rootPath, 'README.md'), '# root\n', 'utf8')
  return {
    baseDir,
    rootPath,
    repoDir: join(baseDir, 'shadow', 'repo.git'),
    journalPath: join(baseDir, 'shadow', 'journal.json'),
    roots: [{ rootId: WORKSPACE_ID, rootPath, kind: 'project' }],
  }
}

async function openRepository(setup: Setup): Promise<WorkspaceShadowRepository> {
  if (!gitPath) throw new Error('git 不可用')
  return WorkspaceShadowRepository.open({
    workspaceId: WORKSPACE_ID,
    repoDir: setup.repoDir,
    journalPath: setup.journalPath,
    gitPath,
    tempDir: join(setup.baseDir, 'shadow', 'tmp'),
  })
}

test.skipIf(!gitPath)(
  '根目录不可用：采集失败、不产生 commit、journal 留下 failed 记录',
  async () => {
    const setup = createSetup()
    const repository = await openRepository(setup)

    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)
    expect(first.commitId.length).toBeGreaterThan(0)

    // 把根换成不存在的路径：这是「项目被移除/未挂载」，不是「用户删光了文件」。
    const ghostRoots: ShadowRoot[] = [
      { rootId: WORKSPACE_ID, rootPath: join(setup.baseDir, 'not-mounted'), kind: 'project' },
    ]
    const second = await repository.capture({ reason: 'turn-after', roots: ghostRoots })
    expect(second.ok).toBe(false)
    expect(second.commitId).toBe('')
    expect(second.error).toContain('根目录不可用')
    // 根不可见时不得把 root 当成「0 个文件」的成功快照。
    expect(second.treeSha).toBe('')

    const state = await repository.readState()
    expect(state.headCommitId).toBe(first.commitId)

    const journal = ShadowJournal.open(setup.journalPath, WORKSPACE_ID)
    expect(journal.list().some((entry) => entry.status === 'failed' && entry.captureId === second.captureId)).toBe(
      true,
    )
    // 失败不能污染「最近一次成功」。
    expect(journal.latestCompleted()?.captureId).toBe(first.captureId)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '同一工作区并发采集：串行执行，父链与 head 都不互相覆盖',
  async () => {
    const setup = createSetup()
    const repository = await openRepository(setup)

    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)

    writeFileSync(join(setup.rootPath, 'a.txt'), 'a\n', 'utf8')
    writeFileSync(join(setup.rootPath, 'b.txt'), 'b\n', 'utf8')

    const results = await Promise.all([
      repository.capture({ reason: 'turn-after', roots: setup.roots }),
      repository.capture({ reason: 'turn-after', roots: setup.roots }),
      repository.capture({ reason: 'startup-reconcile', roots: setup.roots }),
    ])
    expect(results.every((result) => result.ok)).toBe(true)

    // 三次并发采集之间工作区没有再变：tree 相同 → 复用同一个 commit，
    // 既不产生内容相同的空 diff 提交，也不能让 head 指向三个不同的对象。
    const commits = results.map((result) => result.commitId)
    expect(new Set(commits).size).toBe(1)
    expect(commits[0]).not.toBe(first.commitId)

    const runner = createGitRunner({ gitPath: gitPath ?? '' })
    const parent = await runner.run(['rev-parse', `${commits[0] ?? ''}^`], { gitDir: setup.repoDir })
    expect(parent.stdout.trim()).toBe(first.commitId)

    const state = await repository.readState()
    expect(state.headCommitId).toBe(commits[0] ?? '')
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  'partial 语义：超限文件让该根标记不完整，但仍可读回状态',
  async () => {
    const setup = createSetup()
    writeFileSync(join(setup.rootPath, 'huge.bin'), Buffer.alloc(64 * 1024))
    const repository = await WorkspaceShadowRepository.open({
      workspaceId: WORKSPACE_ID,
      repoDir: setup.repoDir,
      journalPath: setup.journalPath,
      gitPath: gitPath ?? '',
      tempDir: join(setup.baseDir, 'shadow', 'tmp'),
      limits: { maxFileBytes: 1024 },
    })

    const result = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(result.ok).toBe(true)
    expect(result.roots[0]?.partial).toBe(true)
    expect(result.roots[0]?.skipped.some((entry) => entry.reason === 'file-too-large')).toBe(true)
    expect(result.roots[0]?.fileCount).toBe(2)

    const state = await repository.readState()
    expect(state.headCommitId).toBe(result.commitId)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '嵌套仓库（目录内自带 .git）的文件也必须进入基线',
  async () => {
    const setup = createSetup()
    const runner = createGitRunner({ gitPath: gitPath ?? '' })
    // 复现真实场景：工作区里有个独立的小仓库（.pi / vendor / submodule 的常见形状）。
    // `git add <嵌套仓库内的文件>` 会静默退出 0 且不加入任何条目，这里就是回归护栏。
    const nested = join(setup.rootPath, '.pi')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'README.md'), 'nested repo file\n', 'utf8')
    expect((await runner.run(['init', '--quiet', nested])).ok).toBe(true)
    await runner.run(['add', 'README.md'], { workTree: nested })
    await runner.run(['-c', 'user.name=Test', '-c', 'user.email=t@local', 'commit', '-m', 'init'], {
      workTree: nested,
    })

    const repository = await openRepository(setup)
    const result = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(result.ok).toBe(true)
    expect(result.roots[0]?.fileCount).toBe(3)

    const tree = await runner.run(['ls-tree', '-r', '--name-only', result.treeSha], { gitDir: setup.repoDir })
    const paths = tree.stdout.split('\n').filter(Boolean)
    expect(paths).toContain(`roots/${WORKSPACE_ID}/.pi/README.md`)
    expect(paths).toContain(`roots/${WORKSPACE_ID}/README.md`)
    // 嵌套仓库自己的 .git 仍然不进入基线。
    expect(paths.some((path) => path.includes('/.pi/.git/'))).toBe(false)
  },
  TEST_TIMEOUT_MS,
)
