import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectDeckSources } from './ppt-deck-context-service'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-ppt-context-'))
  roots.push(root)
  return root
}

describe('ppt deck context service', () => {
  test('显式日期/版本优先于 mtime，旧稿不会混入 current 来源', async () => {
    const root = makeRoot()
    const oldPath = join(root, 'paper-v1.md')
    const currentPath = join(root, 'paper-2026-08-23-final.md')
    writeFileSync(oldPath, '# 旧结果\n误差为 12%\n版本 1')
    writeFileSync(currentPath, '# 最新结果\n误差为 37%\n2026-08-23 final')

    // 故意让旧稿的 mtime 更新，验证 mtime 不能覆盖显式版本/日期信号。
    const future = new Date('2026-08-25T00:00:00Z')
    utimesSync(oldPath, future, future)

    const result = await inspectDeckSources({ paths: [root], agentCwd: root, allowedRoots: [] })
    const old = result.sources.find((source) => source.relativePath === 'paper-v1.md')
    const current = result.sources.find((source) => source.relativePath === 'paper-2026-08-23-final.md')

    expect(old?.status).toBe('superseded')
    expect(current?.status).toBe('current')
    expect(current?.excerpt).toContain('误差为 37%')
    expect(current?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('同一版本等级但内容不同的来源标记为 conflicted，不擅自选择 current', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'experiment-2026-08-24-a.csv'), 'sample,value\nA,10\n')
    writeFileSync(join(root, 'experiment-2026-08-24-b.csv'), 'sample,value\nA,99\n')

    const result = await inspectDeckSources({ paths: [root], agentCwd: root, allowedRoots: [] })
    const experimentSources = result.sources.filter((source) => source.relativePath.startsWith('experiment-'))

    expect(experimentSources).toHaveLength(2)
    expect(experimentSources.every((source) => source.status === 'conflicted')).toBe(true)
    expect(result.conflicts.length).toBeGreaterThan(0)
  })

  test('显式历史资料保持 historical，不会被当作当前版本', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'baseline-historical.md'), '# 历史基线\n仅用于前后对比')

    const result = await inspectDeckSources({ paths: [root], agentCwd: root, allowedRoots: [] })

    expect(result.sources[0]?.status).toBe('historical')
  })

  test('未授权文件和越界 symlink 不会被读取', async () => {
    const root = makeRoot()
    const outside = makeRoot()
    const outsidePath = join(outside, 'secret.md')
    const linkPath = join(root, 'secret-link.md')
    writeFileSync(outsidePath, 'do not read')
    writeFileSync(join(root, 'allowed.md'), 'allowed content')

    await expect(inspectDeckSources({ paths: [outsidePath], agentCwd: root, allowedRoots: [] })).resolves.toMatchObject({
      sources: [],
    })

    let symlinkCreated = false
    try {
      symlinkSync(outsidePath, linkPath, 'file')
      symlinkCreated = true
    } catch {
      // Windows CI may disallow symlink creation; direct unauthorized path above still covers root boundary.
    }

    const result = await inspectDeckSources({ paths: [root], agentCwd: root, allowedRoots: [] })
    expect(result.sources.map((source) => source.relativePath)).toContain('allowed.md')
    expect(result.sources.map((source) => source.relativePath)).not.toContain('secret.md')
    if (symlinkCreated) expect(result.sources.map((source) => source.relativePath)).not.toContain('secret-link.md')
  })

  test('文件数量和单文件大小限制产生 gap，而不是静默扩大扫描范围', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'one.md'), 'one')
    writeFileSync(join(root, 'two.md'), 'two')

    const result = await inspectDeckSources({
      paths: [root],
      agentCwd: root,
      allowedRoots: [],
      maxFiles: 1,
      maxBytesPerFile: 2,
    })

    expect(result.sources.length).toBeLessThanOrEqual(1)
    expect(result.gaps.some((gap) => /上限|限制|size|bytes/i.test(gap))).toBe(true)
  })
})
