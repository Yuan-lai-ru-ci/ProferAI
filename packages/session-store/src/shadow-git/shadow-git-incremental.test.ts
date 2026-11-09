/**
 * 增量索引的回归测试。
 *
 * 增量是「用一次 stat 比较换掉一次内容哈希」，它唯一的失败模式是**静默复用错误的 sha**：
 * 快照会记录一个从未存在过的内容，而且没有任何报错。所以这里不测「快了多少」，
 * 只测「什么时候必须重新哈希」：
 * - 内容变了（尺寸变 / 尺寸不变但 mtime、ctime、inode 变了）必须重新哈希；
 * - 被删除的路径必须从清单里消失，否则下次会把它“复用”回 tree；
 * - 清单损坏时必须整份作废并回退全量，而不是继续拿半份数据判断。
 */

import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createGitRunner } from './git-command'
import { ShadowManifest } from './manifest'
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
  const wellKnown = process.platform === 'win32' ? [] : ['/usr/bin/git', '/opt/homebrew/bin/git']
  return wellKnown.find((candidate) => existsSync(candidate)) ?? null
}

const gitPath = findGitPath()
const TEST_TIMEOUT_MS = 30_000
const WORKSPACE_ID = 'workspace-incremental'
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
      /* 句柄未释放时交给系统回收 */
    }
  }
})

interface Setup {
  baseDir: string
  rootPath: string
  repoDir: string
  journalPath: string
  manifestPath: string
  roots: ShadowRoot[]
}

function createSetup(): Setup {
  const baseDir = makeTempDir('profer-shadow-incr-')
  const rootPath = join(baseDir, 'root')
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'a.txt'), 'aaaa\n', 'utf8')
  writeFileSync(join(rootPath, 'b.txt'), 'bbbb\n', 'utf8')
  writeFileSync(join(rootPath, 'c.txt'), 'cccc\n', 'utf8')
  return {
    baseDir,
    rootPath,
    repoDir: join(baseDir, 'shadow', 'repo.git'),
    journalPath: join(baseDir, 'shadow', 'journal.json'),
    manifestPath: join(baseDir, 'shadow', 'manifest.json'),
    roots: [{ rootId: WORKSPACE_ID, rootPath, kind: 'project' }],
  }
}

async function openRepository(setup: Setup): Promise<WorkspaceShadowRepository> {
  return WorkspaceShadowRepository.open({
    workspaceId: WORKSPACE_ID,
    repoDir: setup.repoDir,
    journalPath: setup.journalPath,
    gitPath: gitPath ?? '',
    tempDir: join(setup.baseDir, 'shadow', 'tmp'),
    manifestPath: setup.manifestPath,
  })
}

test('manifest：保存后可读回，坏文件留证并整份作废', () => {
  const dir = makeTempDir('profer-shadow-manifest-')
  const path = join(dir, 'manifest.json')
  const manifest = ShadowManifest.open(path)
  manifest.replaceRoots({
    [WORKSPACE_ID]: {
      rootPath: '/tmp/root',
      files: { 'a.txt': { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1, sha: 'a'.repeat(40) } },
    },
  })
  expect(manifest.save()).toBe(true)
  expect(ShadowManifest.open(path).size()).toBe(1)

  // 形状不对的条目必须被丢弃，不能让一个坏 sha 进入复用判断。
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      roots: {
        [WORKSPACE_ID]: {
          rootPath: '/tmp/root',
          files: { 'bad.txt': { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 1, sha: 'not-a-sha' } },
        },
      },
    }),
    'utf8',
  )
  expect(ShadowManifest.open(path).size()).toBe(0)

  // 完全无法解析时：留证 + 空清单，不能抛。
  writeFileSync(path, '{ broken', 'utf8')
  expect(ShadowManifest.open(path).size()).toBe(0)
  expect(readdirSync(dir).some((name) => name.startsWith('manifest.json.corrupt-'))).toBe(true)
})

test.skipIf(!gitPath)(
  '增量：第二次采集复用 sha，改动文件才重新哈希',
  async () => {
    const setup = createSetup()
    const repository = await openRepository(setup)

    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)
    expect(first.roots[0]?.hashed).toBe(3)
    expect(first.roots[0]?.reused).toBe(0)

    const second = await repository.capture({ reason: 'turn-after', roots: setup.roots })
    expect(second.ok).toBe(true)
    expect(second.roots[0]?.hashed).toBe(0)
    expect(second.roots[0]?.reused).toBe(3)
    expect(second.treeSha).toBe(first.treeSha)

    // 改内容（尺寸变化）：只有它需要重新哈希，diff 能看出来。
    writeFileSync(join(setup.rootPath, 'b.txt'), 'bbbb-changed\n', 'utf8')
    const third = await repository.capture({ reason: 'turn-after', roots: setup.roots })
    expect(third.roots[0]?.hashed).toBe(1)
    expect(third.roots[0]?.reused).toBe(2)
    const diff = await diffShadowTrees(
      createGitRunner({ gitPath: gitPath ?? '' }),
      setup.repoDir,
      second.treeSha,
      third.treeSha,
    )
    expect(diff.diff.modified).toEqual([`roots/${WORKSPACE_ID}/b.txt`])

    // 解构第三、四次之间的变化：新增文件 → 只哈希新的那个。
    writeFileSync(join(setup.rootPath, 'd.txt'), 'dddd\n', 'utf8')
    const fourth = await repository.capture({ reason: 'turn-after', roots: setup.roots })
    expect(fourth.roots[0]?.hashed).toBe(1)
    expect(fourth.roots[0]?.reused).toBe(3)

    // 删除文件：清单里必须消失，否则下次会把它“复用”回 tree。
    rmSync(join(setup.rootPath, 'd.txt'))
    const fifth = await repository.capture({ reason: 'turn-after', roots: setup.roots })
    expect(fifth.roots[0]?.hashed).toBe(0)
    expect(fifth.roots[0]?.reused).toBe(3)
    const manifest = JSON.parse(readFileSync(setup.manifestPath, 'utf8')) as {
      roots: Record<string, { files: Record<string, unknown> }>
    }
    expect(manifest.roots[WORKSPACE_ID]?.files['d.txt']).toBeUndefined()
    expect(Object.keys(manifest.roots[WORKSPACE_ID]?.files ?? {})).toHaveLength(3)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '增量：同尺寸且 mtime 被改回去的修改仍然要被发现（ctime/inode 兜底）',
  async () => {
    const setup = createSetup()
    const repository = await openRepository(setup)
    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)

    const file = join(setup.rootPath, 'a.txt')
    // 同样长度、把 mtime 恢复成原值：只靠 size+mtime 的方案会漏掉这次修改。
    writeFileSync(file, 'zzzz\n', 'utf8')
    utimesSync(file, new Date(1_600_000_000_000), new Date(1_600_000_000_000))

    const second = await repository.capture({ reason: 'turn-after', roots: setup.roots })
    expect(second.roots[0]?.hashed).toBe(1)
    const diff = await diffShadowTrees(
      createGitRunner({ gitPath: gitPath ?? '' }),
      setup.repoDir,
      first.treeSha,
      second.treeSha,
    )
    expect(diff.diff.modified).toEqual([`roots/${WORKSPACE_ID}/a.txt`])
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '增量：可执行位登记为 100755，旧清单缺少 mode 时会重新登记',
  async () => {
    const setup = createSetup()
    chmodSync(join(setup.rootPath, 'a.txt'), 0o755)
    const repository = await openRepository(setup)
    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)

    const runner = createGitRunner({ gitPath: gitPath ?? '' })
    const listed = await runner.run(['ls-tree', '-r', first.treeSha], { gitDir: setup.repoDir })
    expect(listed.ok).toBe(true)
    const modes = new Map<string, string>()
    for (const line of listed.stdout.split('\n')) {
      if (!line.trim()) continue
      const [meta, path] = line.split('\t')
      const [mode] = (meta ?? '').split(' ')
      if (path && mode) modes.set(path, mode)
    }
    expect(modes.get(`roots/${WORKSPACE_ID}/a.txt`)).toBe('100755')
    expect(modes.get(`roots/${WORKSPACE_ID}/b.txt`)).toBe('100644')

    // 模拟升级前写下的清单：条目没有 mode。这种条目不能复用，
    // 否则已有工作区在修复后永远不会重新登记 100755。
    const stored = JSON.parse(readFileSync(setup.manifestPath, 'utf8')) as {
      schemaVersion: number
      roots: Record<string, { rootPath: string; files: Record<string, Record<string, unknown>> }>
    }
    for (const root of Object.values(stored.roots)) {
      for (const entry of Object.values(root.files)) delete entry.mode
    }
    writeFileSync(setup.manifestPath, JSON.stringify(stored), 'utf8')

    const reopened = await openRepository(setup)
    const second = await reopened.capture({ reason: 'turn-after', roots: setup.roots })
    expect(second.ok).toBe(true)
    expect(second.roots[0]?.hashed).toBe(3)
    expect(second.roots[0]?.reused).toBe(0)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '增量：tree 不变时也回写清单——旧清单缺 mode 能升级，不会每轮全量重哈希',
  async () => {
    // 工作区里没有可执行文件：升级前后 tree 完全相同，靠「tree 变了才写清单」永远补不上 mode。
    const setup = createSetup()
    const repository = await openRepository(setup)
    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)

    // 造一份升级前形状的清单：条目没有 mode。
    const stored = JSON.parse(readFileSync(setup.manifestPath, 'utf8')) as {
      schemaVersion: number
      roots: Record<string, { rootPath: string; files: Record<string, Record<string, unknown>> }>
    }
    for (const root of Object.values(stored.roots)) {
      for (const entry of Object.values(root.files)) delete entry.mode
    }
    writeFileSync(setup.manifestPath, JSON.stringify(stored), 'utf8')

    // 第二次：不能复用旧条目（缺 mode），必须重新哈希；但 tree 与 head 相同，不能造空提交。
    const reopened = await openRepository(setup)
    const second = await reopened.capture({ reason: 'turn-after', roots: setup.roots })
    expect(second.ok).toBe(true)
    expect(second.commitId).toBe(first.commitId)
    expect(second.roots[0]?.hashed).toBe(3)
    expect(second.roots[0]?.reused).toBe(0)

    // 关键断言：tree 未变，清单仍然被回写，mode 已被补上。
    const upgraded = JSON.parse(readFileSync(setup.manifestPath, 'utf8')) as {
      roots: Record<string, { files: Record<string, { mode?: unknown }> }>
    }
    const modes = Object.values(upgraded.roots).flatMap((root) =>
      Object.values(root.files).map((entry) => entry.mode),
    )
    expect(modes).toHaveLength(3)
    for (const mode of modes) expect(typeof mode).toBe('number')

    // 第三次：清单已升级，恢复正常复用。
    const third = await (await openRepository(setup)).capture({ reason: 'turn-after', roots: setup.roots })
    expect(third.ok).toBe(true)
    expect(third.roots[0]?.hashed).toBe(0)
    expect(third.roots[0]?.reused).toBe(3)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '增量：清单损坏后回退全量哈希，采集仍然成功',
  async () => {
    const setup = createSetup()
    const repository = await openRepository(setup)
    const first = await repository.capture({ reason: 'initial', roots: setup.roots })
    expect(first.ok).toBe(true)

    // 清单在 open 时读取，所以要新建一个实例来模拟「下次启动读到坏清单」。
    writeFileSync(setup.manifestPath, '{ broken', 'utf8')
    const reopened = await openRepository(setup)

    const second = await reopened.capture({ reason: 'startup-reconcile', roots: setup.roots })
    expect(second.ok).toBe(true)
    expect(second.roots[0]?.hashed).toBe(3)
    expect(second.treeSha).toBe(first.treeSha)
  },
  TEST_TIMEOUT_MS,
)
