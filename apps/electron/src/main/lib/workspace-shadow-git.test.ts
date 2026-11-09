/**
 * 工作区 Shadow Git 装配层测试。
 *
 * 这里验证的不是 git 细节（那在 @profer/session-store/shadow-git 里），而是
 * 「工作区 → 根集合 → 配置目录下的 bare 仓库」这条装配链：
 * - 项目模式的主根必须是项目真实根，而不是 Profer 的配置目录；
 * - 附加目录派生的 rootId 必须稳定，且不得重复覆盖主根；
 * - 底座必须落在 ~/.profer/workspace-shadow/<workspaceId>/ 下，并把 `.profer` 排除掉；
 * - 用户项目自己的 `.git` 不因采集而改变。
 *
 * 用 PROFER_CONFIG_DIR 把整个测试关进临时目录，绝不读写真实用户配置。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitRunner, deriveAttachedRootId } from '@profer/session-store'
import type { AgentWorkspace } from '@profer/shared'
import {
  captureWorkspaceShadow,
  getWorkspaceShadowDir,
  getWorkspaceShadowRepoDir,
  isSafeWorkspaceShadowId,
  readWorkspaceShadowState,
  resolveWorkspaceShadowRoots,
} from './workspace-shadow-git'

const TEST_TIMEOUT_MS = 30_000

let baseDir = ''
let configDir = ''
let previousConfigDir: string | undefined

function findGitPath(): string | null {
  for (const candidate of ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']) {
    try {
      if (require('node:fs').existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

const gitPath = findGitPath()

interface Fixture {
  workspace: AgentWorkspace
  projectRoot: string
  attachedRoot: string
}

function makeFixture(slug: string): Fixture {
  const projectRoot = join(baseDir, `${slug}-project`)
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  mkdirSync(join(projectRoot, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(projectRoot, '.profer'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')
  writeFileSync(join(projectRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n', 'utf8')
  writeFileSync(join(projectRoot, '.profer', 'config.json'), JSON.stringify({ attachedDirectories: [] }), 'utf8')

  // 附加目录：一个在主根外、一个故意嵌在主根内（后者必须被丢弃）。
  const attachedRoot = join(baseDir, `${slug}-attached`)
  mkdirSync(attachedRoot, { recursive: true })
  writeFileSync(join(attachedRoot, 'note.md'), '# note\n', 'utf8')
  const nested = join(projectRoot, 'docs-vendor')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'nested.md'), 'nested\n', 'utf8')
  writeFileSync(
    join(projectRoot, '.profer', 'config.json'),
    JSON.stringify({ attachedDirectories: [attachedRoot, nested] }),
    'utf8',
  )

  const workspace: AgentWorkspace = {
    id: `workspace-id-${slug}`,
    name: `工作区 ${slug}`,
    slug,
    createdAt: 1,
    updatedAt: 1,
    type: 'personal',
    storageMode: 'project',
    rootPath: projectRoot,
  }
  const indexPath = join(configDir, 'agent-workspaces.json')
  const existing = (() => {
    try {
      return require('node:fs').readFileSync(indexPath, 'utf8')
    } catch {
      return undefined
    }
  })()
  const parsed = existing ? JSON.parse(existing) : { version: 4, workspaces: [] }
  parsed.workspaces.push(workspace)
  writeFileSync(indexPath, JSON.stringify(parsed), 'utf8')

  return { workspace, projectRoot, attachedRoot }
}

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'profer-shadow-glue-'))
  configDir = join(baseDir, 'config')
  mkdirSync(configDir, { recursive: true })
  previousConfigDir = process.env.PROFER_CONFIG_DIR
  process.env.PROFER_CONFIG_DIR = configDir
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = previousConfigDir
  try {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
  } catch {
    /* 清理失败不影响断言结论 */
  }
})

test('workspaceId 必须能安全地作为目录名', () => {
  expect(isSafeWorkspaceShadowId('0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')).toBe(true)
  expect(isSafeWorkspaceShadowId('../escape')).toBe(false)
  expect(isSafeWorkspaceShadowId('/abs')).toBe(false)
  expect(isSafeWorkspaceShadowId('short')).toBe(false)
  expect(isSafeWorkspaceShadowId('ws-..-traversal')).toBe(false)
})

test('resolveWorkspaceShadowRoots：主根是项目真实根，嵌套附加目录被丢弃', () => {
  const fixture = makeFixture('alpha')
  const roots = resolveWorkspaceShadowRoots(fixture.workspace)

  expect(roots[0]?.rootId).toBe(fixture.workspace.id)
  expect(roots[0]?.kind).toBe('project')
  expect(roots[0]?.rootPath).toBe(require('node:fs').realpathSync(fixture.projectRoot))
  // 附加目录只保留主根之外的那个，且 id 由路径稳定派生。
  expect(roots).toHaveLength(2)
  expect(roots[1]?.kind).toBe('attached')
  expect(roots[1]?.rootId).toBe(deriveAttachedRootId(require('node:fs').realpathSync(fixture.attachedRoot)))
  expect(roots.some((root) => root.rootPath.endsWith('docs-vendor'))).toBe(false)
})

test('resolveWorkspaceShadowRoots：会话级附加目录并入根集合，重复与嵌套被丢弃', () => {
  const fixture = makeFixture('beta')
  const sessionDir = join(baseDir, 'beta-session-attached')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'note.md'), '# session\n', 'utf8')
  const nestedSession = join(fixture.projectRoot, 'src', 'inside-project')
  mkdirSync(nestedSession, { recursive: true })

  const roots = resolveWorkspaceShadowRoots(fixture.workspace, {
    // 同一目录重复出现、嵌在主根内、以及和工作区级附加目录重复，都必须只留一份。
    sessionAttachedDirectories: [sessionDir, sessionDir, nestedSession, fixture.attachedRoot],
  })

  expect(roots.map((root) => root.kind)).toEqual(['project', 'attached', 'attached'])
  const attachedPaths = roots.filter((root) => root.kind === 'attached').map((root) => root.rootPath)
  expect(new Set(attachedPaths).size).toBe(attachedPaths.length)
  expect(attachedPaths.some((value) => value.endsWith('inside-project'))).toBe(false)
  expect(attachedPaths.some((value) => value.endsWith('beta-session-attached'))).toBe(true)
})

test.skipIf(!gitPath)(
  'capture：底座落在配置目录，tree 含 roots/ 前缀，.profer 与 node_modules 不入基线',
  async () => {
    const fixture = makeFixture('beta')
    const result = await captureWorkspaceShadow({
      workspace: fixture.workspace,
      reason: 'initial',
    })
    expect(result).not.toBeNull()
    expect(result?.ok).toBe(true)

    expect(getWorkspaceShadowDir(fixture.workspace.id)).toBe(
      join(configDir, 'workspace-shadow', fixture.workspace.id),
    )
    expect(getWorkspaceShadowRepoDir(fixture.workspace.id)).toBe(
      join(configDir, 'workspace-shadow', fixture.workspace.id, 'repo.git'),
    )

    const runner = createGitRunner({ gitPath: gitPath ?? '' })
    const tree = await runner.run(['ls-tree', '-r', '--name-only', result?.treeSha ?? ''], {
      gitDir: getWorkspaceShadowRepoDir(fixture.workspace.id),
    })
    expect(tree.ok).toBe(true)
    const paths = tree.stdout.split('\n').filter(Boolean)
    expect(paths).toContain(`roots/${fixture.workspace.id}/src/app.ts`)
    expect(paths).toContain(
      `roots/${deriveAttachedRootId(require('node:fs').realpathSync(fixture.attachedRoot))}/note.md`,
    )
    // 嵌在主根内的附加目录不被当成独立根重复记录，但仍作为主根内容被采集。
    expect(paths).toContain(`roots/${fixture.workspace.id}/docs-vendor/nested.md`)
    expect(paths.some((path) => path.includes('/node_modules/'))).toBe(false)
    expect(paths.some((path) => path.includes('/.profer/'))).toBe(false)

    // 重启后读回：同一个工作区 id 能重新解析到 head 与 tree。
    const state = await readWorkspaceShadowState(fixture.workspace.id)
    expect(state?.headCommitId).toBe(result?.commitId)
    expect(state?.headTreeSha).toBe(result?.treeSha)
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  '用户项目自己的 .git 不被采集改变',
  async () => {
    const fixture = makeFixture('gamma')
    const runner = createGitRunner({ gitPath: gitPath ?? '' })
    const init = await runner.run(['init', '--quiet', fixture.projectRoot])
    expect(init.ok).toBe(true)
    await runner.run(['add', 'src/app.ts'], { workTree: fixture.projectRoot })
    await runner.run(['-c', 'user.name=Test', '-c', 'user.email=t@local', 'commit', '-m', 'init'], {
      workTree: fixture.projectRoot,
    })
    writeFileSync(join(fixture.projectRoot, 'src', 'app.ts'), 'export const app = 2\n', 'utf8')

    const before = await runner.run(['status', '--porcelain'], { workTree: fixture.projectRoot })
    const headBefore = await runner.run(['rev-parse', 'HEAD'], { workTree: fixture.projectRoot })

    const result = await captureWorkspaceShadow({ workspace: fixture.workspace, reason: 'turn-before' })
    expect(result?.ok).toBe(true)

    const after = await runner.run(['status', '--porcelain'], { workTree: fixture.projectRoot })
    const headAfter = await runner.run(['rev-parse', 'HEAD'], { workTree: fixture.projectRoot })
    expect(after.stdout).toBe(before.stdout)
    expect(headAfter.stdout).toBe(headBefore.stdout)
    expect(before.stdout).toContain('M src/app.ts')
  },
  TEST_TIMEOUT_MS,
)

test.skipIf(!gitPath)(
  'managed 工作区：Profer 配置与技能目录不进基线，会话目录里的工作文件要进',
  async () => {
    const slug = 'managed-delta'
    const workspace: AgentWorkspace = {
      id: 'workspace-id-managed-delta',
      name: '托管工作区',
      slug,
      createdAt: 1,
      updatedAt: 1,
      type: 'personal',
      storageMode: 'managed',
    }
    const indexPath = join(configDir, 'agent-workspaces.json')
    const parsed = JSON.parse(require('node:fs').readFileSync(indexPath, 'utf8'))
    parsed.workspaces.push(workspace)
    writeFileSync(indexPath, JSON.stringify(parsed), 'utf8')

    const root = join(configDir, 'agent-workspaces', slug)
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
    mkdirSync(join(root, 'workspace-files', '.context'), { recursive: true })
    mkdirSync(join(root, '11111111-1111-4111-8111-111111111111', 'src'), { recursive: true })
    writeFileSync(join(root, 'mcp.json'), '{"servers":{}}', 'utf8')
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# skill', 'utf8')
    writeFileSync(join(root, 'workspace-files', '.context', 'note.md'), 'note', 'utf8')
    writeFileSync(join(root, '11111111-1111-4111-8111-111111111111', 'src', 'main.ts'), 'export {}\n', 'utf8')

    const result = await captureWorkspaceShadow({ workspace, reason: 'initial' })
    expect(result?.ok).toBe(true)

    const runner = createGitRunner({ gitPath: gitPath ?? '' })
    const tree = await runner.run(['ls-tree', '-r', '--name-only', result?.treeSha ?? ''], {
      gitDir: getWorkspaceShadowRepoDir(workspace.id),
    })
    const paths = tree.stdout.split('\n').filter(Boolean).map((path) => path.replace(`roots/${workspace.id}/`, ''))
    expect(paths).toContain('11111111-1111-4111-8111-111111111111/src/main.ts')
    expect(paths).not.toContain('mcp.json')
    expect(paths.some((path) => path.startsWith('skills/'))).toBe(false)
    expect(paths.some((path) => path.startsWith('workspace-files/'))).toBe(false)
  },
  TEST_TIMEOUT_MS,
)
