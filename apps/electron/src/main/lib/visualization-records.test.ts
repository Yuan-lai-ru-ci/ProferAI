import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, renameSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listVisualizations,
  presentVisualization,
  readVisualization,
  readVisualizationViewState,
  saveVisualizationViewState,
} from './visualization-records'
import type { VisualizationContext } from '@profer/shared'

const roots: string[] = []
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'profer-visualizations-'))
  roots.push(base)
  // 会话工作区与会话可视化存储刻意分离：存储不能落在会被回退/清理的工作区里。
  const root = join(base, 'session-workspace')
  const store = join(base, 'agent-visualizations', 'session-a')
  mkdirSync(root, { recursive: true })
  const html = join(root, 'chart.html')
  writeFileSync(html, '<!doctype html><html><head><style>body{color:red}</style></head><body><img src="data:image/svg+xml,%3Csvg/%3E"><script>document.body.dataset.ready="1"</script></body></html>')
  const context: VisualizationContext = { sessionId: 'session-a', agentCwd: root, storageDir: store, allowedRoots: [root] }
  return { root, store, html, context }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('visualization records', () => {
  test('presents immutable revisions and reads old revisions after update', async () => {
    const f = fixture()
    const first = await presentVisualization({ filePath: f.html, title: 'Chart', kind: 'data', summary: 'First', objects: [{ id: 'a', label: 'A', text: 'one' }] }, f.context, 'tool-1')
    expect((await readVisualization(f.context, first.id)).html).toContain('color:red')

    writeFileSync(f.html, '<html><body><p>second</p></body></html>')
    const second = await presentVisualization({ filePath: f.html, title: 'Chart 2', summary: 'Second', visualizationId: first.id, baseRevision: first.revision, objects: [{ id: 'b', label: 'B' }] }, f.context, 'tool-2')
    expect(second.toolCallId).toBe(first.toolCallId)
    expect(second.revision).not.toBe(first.revision)
    expect((await readVisualization(f.context, first.id, first.revision)).record.summary).toBe('First')
    expect((await readVisualization(f.context, second.id)).html).toContain('second')
    expect((await listVisualizations(f.context)).map((item) => item.id)).toEqual([first.id])
  })

  test('会话存储超额度时拒绝修订，旧结果不被删除或替换', async () => {
    const f = fixture()
    const first = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'First' }, f.context, 'tool-1')
    const padding = join(f.store, 'quota-padding')
    writeFileSync(padding, '')
    truncateSync(padding, 64 * 1024 * 1024)
    await expect(presentVisualization({ filePath: f.html, title: 'Chart', summary: 'New', visualizationId: first.id, baseRevision: first.revision }, f.context, 'tool-2')).rejects.toThrow('存储额度')
    expect((await readVisualization(f.context, first.id)).record.revision).toBe(first.revision)
  })
  test('同一工具调用重试创建只返回一个结果', async () => {
    const f = fixture()
    const input = { filePath: f.html, title: 'Chart', summary: 'First' }
    const [a, b] = await Promise.all([presentVisualization(input, f.context, 'same-call'), presentVisualization(input, f.context, 'same-call')])
    expect(a.id).toBe(b.id)
    expect(await listVisualizations(f.context)).toHaveLength(1)
  })
  test('取消或计划门禁在公布前拒绝，保留最后可用 revision', async () => {
    const f = fixture()
    const input = { filePath: f.html, title: 'Chart', summary: 'First' }
    const first = await presentVisualization(input, f.context, 'tool-1')
    let calls = 0
    await expect(presentVisualization({ ...input, summary: 'Cancelled', visualizationId: first.id, baseRevision: first.revision }, f.context, 'tool-2', () => {
      if (++calls > 1) throw new Error('cancelled or plan')
    })).rejects.toThrow('cancelled or plan')
    expect((await readVisualization(f.context, first.id)).record.revision).toBe(first.revision)
    expect((await listVisualizations(f.context))).toHaveLength(1)
  })
  test('rejects stale CAS updates and preserves the current revision', async () => {
    const f = fixture()
    const first = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'First' }, f.context, 'tool-1')
    await expect(presentVisualization({ filePath: f.html, title: 'Stale', summary: 'bad', visualizationId: first.id, baseRevision: '0'.repeat(64) }, f.context, 'tool-2')).rejects.toThrow(/revision|版本/i)
    expect((await readVisualization(f.context, first.id)).record.summary).toBe('First')
  })

  test('rejects unauthorized files and symlink escapes', async () => {
    const f = fixture()
    const outside = join(f.root, '..', `outside-${Date.now()}.html`)
    writeFileSync(outside, '<html><body>secret</body></html>')
    const link = join(f.root, 'escape.html')
    symlinkSync(outside, link)
    await expect(presentVisualization({ filePath: link, title: 'Escape', summary: 'x' }, f.context, 'tool')).rejects.toThrow(/授权|路径|文件/i)
    rmSync(outside, { force: true })
  })

  test('rejects external resources and oversized metadata', async () => {
    const f = fixture()
    writeFileSync(f.html, '<html><head><link rel="stylesheet" href="https://example.com/a.css"></head><body></body></html>')
    await expect(presentVisualization({ filePath: f.html, title: 'External', summary: 'x' }, f.context, 'tool')).rejects.toThrow(/资源|外部|自包含/i)
    writeFileSync(f.html, '<html><body></body></html>')
    await expect(presentVisualization({ filePath: f.html, title: 'x'.repeat(121), summary: 'x' }, f.context, 'tool')).rejects.toThrow(/标题|title/i)
  })

  test('saves bounded plain JSON view state per revision', async () => {
    const f = fixture()
    const record = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x' }, f.context, 'tool')
    await saveVisualizationViewState(f.context, record.id, record.revision, { selected: 'a', zoom: 2 })
    expect(await readVisualizationViewState(f.context, record.id, record.revision)).toEqual({ selected: 'a', zoom: 2 })
    await expect(saveVisualizationViewState(f.context, record.id, record.revision, { __proto__: { polluted: true } })).rejects.toThrow(/JSON|原型|状态/i)
    await expect(saveVisualizationViewState(f.context, record.id, record.revision, { value: 'x'.repeat(17 * 1024) })).rejects.toThrow(/状态|大小|16/i)
  })

  test('only one concurrent update wins the same CAS base revision', async () => {
    const f = fixture()
    const first = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'First' }, f.context, 'tool-1')
    const updates = await Promise.allSettled(['a', 'b'].map((summary) => presentVisualization({ filePath: f.html, title: 'Chart', summary, visualizationId: first.id, baseRevision: first.revision }, f.context, `tool-${summary}`)))
    expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(updates.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await readVisualization(f.context, first.id)).record.recordVersion).toBe(2)
    expect((await readVisualization(f.context, first.id, first.revision)).record.summary).toBe('First')
  })

  test('changes revision when only semantic objects change', async () => {
    const f = fixture()
    const first = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'Same', objects: [{ id: 'a', label: 'A', text: 'old' }] }, f.context, 'tool')
    const second = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'Same', objects: [{ id: 'a', label: 'A', text: 'new' }], visualizationId: first.id, baseRevision: first.revision }, f.context, 'tool')
    expect(first.revision).not.toBe(second.revision)
    expect((await readVisualization(f.context, first.id, first.revision)).record.objects[0]?.text).toBe('old')
  })

  test('rejects unpaired update fields, duplicate objects, oversized HTML and sourceText', async () => {
    const f = fixture()
    const input = { filePath: f.html, title: 'Chart', summary: 'x' }
    await expect(presentVisualization({ ...input, baseRevision: '0'.repeat(64) }, f.context, 'tool')).rejects.toThrow()
    await expect(presentVisualization({ ...input, sourceText: 'x'.repeat(20_001) }, f.context, 'tool')).rejects.toThrow(/sourceText/)
    await expect(presentVisualization({ ...input, objects: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, f.context, 'tool')).rejects.toThrow(/对象/)
    await expect(presentVisualization({ ...input, objects: [{ id: 'a', label: 'A', extra: 'bad' } as never] }, f.context, 'tool')).rejects.toThrow(/对象/)
    writeFileSync(f.html, '<html>' + 'x'.repeat(512 * 1024) + '</html>')
    await expect(presentVisualization(input, f.context, 'tool')).rejects.toThrow(/512|大小/)
    await expect(presentVisualization({ ...input, filePath: f.root }, f.context, 'tool')).rejects.toThrow(/普通文件/)
  })

  test('rejects cross-session records and unsafe result paths', async () => {
    const f = fixture()
    const first = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x' }, f.context, 'tool')
    const other = { ...f.context, sessionId: 'session-b' }
    expect(await listVisualizations(other)).toEqual([])
    await expect(readVisualization(other, first.id)).rejects.toThrow(/会话/)
    await expect(readVisualizationViewState(other, first.id, first.revision)).rejects.toThrow(/会话/)
    await expect(saveVisualizationViewState(other, first.id, first.revision, {})).rejects.toThrow(/会话/)
    await expect(presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x', visualizationId: first.id, baseRevision: first.revision }, other, 'tool')).rejects.toThrow(/会话/)
    await expect(readVisualization(f.context, '../escape')).rejects.toThrow(/id|路径/)
  })

  test('accepts authorized attachments and rejects resource indirection', async () => {
    const f = fixture()
    const attached = mkdtempSync(join(tmpdir(), 'profer-attached-'))
    roots.push(attached)
    const html = join(attached, 'chart.html')
    writeFileSync(html, '<html><body><svg><use href="#node"/></svg></body></html>')
    const record = await presentVisualization({ filePath: html, title: 'Chart', summary: 'x' }, { ...f.context, allowedRoots: [attached] }, 'tool')
    expect(record.id).toBeTruthy()
    for (const fragment of [
      '<img src="&#104;ttps://example.com/a.png">',
      '<script src="data:text/javascript,alert(1)"></script>',
      '<style>body{background:u\\72l(https://example.com/a.png)}</style>',
      '<style>@\\69mport "https://example.com/a.css";</style>',
      '<style>body{background:image-set("https://example.com/a.png" 1x)}</style>',
      '<svg><use href="https://example.com/a.svg#x"/></svg>',
      '<meta http-equiv="refresh" content="0;url=https://example.com">',
      '<div style="background:url(https://example.com/a.png)"></div>',
    ]) {
      writeFileSync(f.html, `<html><head></head><body>${fragment}</body></html>`)
      await expect(presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x' }, f.context, 'tool')).rejects.toThrow(/资源|自包含|外部|CSS/)
    }
  })

  test('does not follow storage symlinks or trust disk HTML and metadata', async () => {
    const f = fixture()
    const record = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x' }, f.context, 'tool')
    const dir = join(f.store, record.id)
    const html = join(dir, 'revisions', `${record.revision}.html`)
    writeFileSync(html, '<html><body>tampered</body></html>')
    await expect(readVisualization(f.context, record.id)).rejects.toThrow(/hash|损坏/)
    const old = join(f.root, 'old-storage')
    renameSync(dir, old)
    symlinkSync(old, dir, 'dir')
    await expect(readVisualization(f.context, record.id)).rejects.toThrow(/路径|目录|符号/)
    await expect(presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x', visualizationId: record.id, baseRevision: record.revision }, f.context, 'tool')).rejects.toThrow(/路径|目录|符号/)
  })

  test('rejects non JSON states and keeps the previous state on failure', async () => {
    const f = fixture()
    const record = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x' }, f.context, 'tool')
    expect(await readVisualizationViewState(f.context, record.id, record.revision)).toEqual({})
    await saveVisualizationViewState(f.context, record.id, record.revision, { selected: 'a' })
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    for (const state of [{ date: new Date() }, { value: NaN }, { fn: () => 1 }, { value: undefined }, cyclic, JSON.parse('{"nested":{"constructor":1}}'), { large: Array.from({ length: 3_000 }, () => 1) }]) {
      await expect(saveVisualizationViewState(f.context, record.id, record.revision, state)).rejects.toThrow(/状态|JSON|原型/)
    }
    expect(await readVisualizationViewState(f.context, record.id, record.revision)).toEqual({ selected: 'a' })
    const second = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'updated', visualizationId: record.id, baseRevision: record.revision }, f.context, 'tool')
    expect(await readVisualizationViewState(f.context, record.id, second.revision)).toEqual({})
    expect(await readVisualizationViewState(f.context, record.id, record.revision)).toEqual({ selected: 'a' })
  })

  test('ignores damaged records in list but gives an explicit read error', async () => {
    const f = fixture()
    const record = await presentVisualization({ filePath: f.html, title: 'Chart', summary: 'x' }, f.context, 'tool')
    const dir = join(f.store, record.id)
    writeFileSync(join(dir, 'record.json'), '{bad json')
    expect(await listVisualizations(f.context)).toEqual([])
    await expect(readVisualization(f.context, record.id)).rejects.toThrow(/损坏|无效|记录/i)
    expect(readFileSync(join(dir, 'revisions', `${record.revision}.html`), 'utf8')).toContain('<html')
  })
})
