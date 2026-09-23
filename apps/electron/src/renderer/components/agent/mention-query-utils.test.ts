import { describe, expect, test } from 'bun:test'
import {
  createFileSnapshotKey,
  createLatestQueryRunner,
  filterFileSnapshot,
  limitMentionGroups,
} from './mention-query-utils'

const entry = (name: string, path: string, source: 'session' | 'workspace', type: 'file' | 'dir' = 'file') => ({
  name,
  path,
  source,
  type,
})

describe('mention query helpers', () => {
  test('file snapshot key is stable for equivalent directory combinations', () => {
    expect(createFileSnapshotKey('/workspace', ['/b', '/a', '/a'], ['/session'])).toBe(
      createFileSnapshotKey('/workspace', ['/a', '/b'], ['/session']),
    )
  })

  test('filters and sorts a cached file snapshot without IPC', () => {
    const result = filterFileSnapshot({
      entries: [],
      total: 0,
      sessionEntries: [entry('README.md', 'README.md', 'session'), entry('src', 'src', 'session', 'dir')],
      workspaceEntries: [entry('agent.md', '/docs/agent.md', 'workspace'), entry('other.txt', '/docs/other.txt', 'workspace')],
    }, 'age')

    expect(result.entries.map(({ name }) => name)).toEqual(['agent.md'])
    expect(result.total).toBe(1)
  })

  test('keeps both sources represented when capping candidates', () => {
    const result = limitMentionGroups(
      [entry('a', 'a', 'session'), entry('b', 'b', 'session')],
      [entry('c', 'c', 'workspace'), entry('d', 'd', 'workspace')],
      2,
    )
    expect(result.sessionEntries).toHaveLength(1)
    expect(result.workspaceEntries).toHaveLength(1)
  })

  test('keeps the total candidate count within the limit for skewed groups', () => {
    const result = limitMentionGroups(
      Array.from({ length: 1999 }, (_, index) => entry(`s${index}`, `s${index}`, 'session')),
      [entry('w', 'w', 'workspace')],
      200,
    )
    expect(result.sessionEntries.length + result.workspaceEntries.length).toBe(200)

    const minimum = limitMentionGroups(
      [entry('s', 's', 'session')],
      [entry('w', 'w', 'workspace')],
      1,
    )
    expect(minimum.sessionEntries.length + minimum.workspaceEntries.length).toBe(1)
  })

  test('resolves superseded in-flight queries without waiting for old operation', async () => {
    const run = createLatestQueryRunner<string>('', 0)
    const never = run(() => new Promise<string>(() => {}))
    await new Promise((resolve) => setTimeout(resolve, 5))
    const latest = run(async () => 'new')

    expect(await Promise.race([
      never,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ])).toBe('')
    expect(await latest).toBe('new')
  })

  test('only resolves the latest debounced query', async () => {
    const run = createLatestQueryRunner<string>('')
    const first = run(async () => 'old')
    const second = run(async () => 'new')

    expect(await first).toBe('')
    expect(await second).toBe('new')
  })
})
