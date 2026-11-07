import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionStorePaths, sessionRewindPath } from './paths'
import { resolveProjectRelativePath } from './rewind-store'
import { registerSessionStorageLayout, unregisterSessionStorageLayout } from './session-layout'
import { createRewindStore } from './rewind-store'

let root = ''
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

async function setup(layout?: { kind: 'project'; dataDir: string }) {
  root = await mkdtemp(join(tmpdir(), 'profer-rewind-store-'))
  registerSessionStorageLayout('session-1', layout ?? { kind: 'managed' })
  const paths = createSessionStorePaths(root)
  return { paths, store: createRewindStore(paths, 'session-1') }
}

test('stores file and absent versions by content hash and deduplicates objects', async () => {
  const { store } = await setup()
  const a = await store.putVersion({ kind: 'file', content: Buffer.from('before'), mode: 0o640 })
  const duplicate = await store.putVersion({ kind: 'file', content: Buffer.from('before'), mode: 0o600 })
  const absent = await store.putVersion({ kind: 'absent' })
  expect(a).toEqual({ kind: 'file', contentRef: a.kind === 'file' ? a.contentRef : '', sha256: a.kind === 'file' ? a.sha256 : '', size: 6, mode: 0o640 })
  expect(duplicate.kind === 'file' && a.kind === 'file' && duplicate.contentRef).toBe(a.kind === 'file' ? a.contentRef : '')
  expect(absent).toEqual({ kind: 'absent' })
  expect(await store.readVersion(a)).toEqual(Buffer.from('before'))
})

test('manifest commits atomically and failed writes leave previous manifest readable', async () => {
  const { store } = await setup()
  await store.writeManifest({ recoveryId: 'r1', sessionId: 'session-1', status: 'ready', createdAt: 1, refs: [] })
  await mkdir(store.paths.manifestPath('r2'))
  await expect(store.writeManifest({ recoveryId: 'r2', sessionId: 'session-1', status: 'ready', createdAt: 2, refs: [] })).rejects.toThrow()
  expect(await store.readManifest('r1')).toMatchObject({ createdAt: 1 })
  const raw = await readFile(store.paths.manifestPath('r1'), 'utf8')
  expect(JSON.parse(raw).createdAt).toBe(1)
})

test('corrupt object hash is rejected and cannot be used as a backup', async () => {
  const { store } = await setup()
  const version = await store.putVersion({ kind: 'file', content: Buffer.from('trusted') })
  if (version.kind !== 'file') throw new Error('expected file version')
  await writeFile(store.paths.objectPath(version.sha256), 'tampered')
  await expect(store.readVersion(version)).rejects.toMatchObject({ code: 'OBJECT_HASH_MISMATCH' })
})

test('GC retains objects referenced by incomplete operation journal', async () => {
  const { store } = await setup()
  const version = await store.putVersion({ kind: 'file', content: Buffer.from('in-flight') })
  if (version.kind !== 'file') throw new Error('expected file version')
  await store.writeManifest({ recoveryId: 'active', sessionId: 'session-1', status: 'applying', createdAt: 1, refs: [version.contentRef] })
  await store.writeJournal({ operationId: 'op1', sessionId: 'session-1', status: 'started', phase: 'applying', createdAt: 1, updatedAt: 1, refs: [version.contentRef], actions: [] })
  const result = await store.collectGarbage({ olderThan: Number.MAX_SAFE_INTEGER })
  expect(result.deletedObjects).toBe(0)
  expect(await store.readVersion(version)).toEqual(Buffer.from('in-flight'))
})

test('enumerates manifests and journals by session with durable recovery metadata', async () => {
  const { store } = await setup()
  const metadata = { planId: 'plan-1', ownerKey: 'desktop', messageVersion: { kind: 'file', contentRef: 'ref' } }
  await store.writeManifest({ recoveryId: 'recovery-1', sessionId: 'session-1', status: 'applying', createdAt: 1, refs: [], metadata })
  await store.writeJournal({ operationId: 'recovery-1', sessionId: 'session-1', status: 'started', phase: 'applying', createdAt: 1, updatedAt: 2, refs: [], actions: [], metadata })

  expect(await store.readManifestBySession('recovery-1', 'session-1')).toMatchObject({ recoveryId: 'recovery-1', sessionId: 'session-1', status: 'applying', metadata })
  expect(await store.readJournalBySession('recovery-1', 'session-1')).toMatchObject({ operationId: 'recovery-1', sessionId: 'session-1', status: 'started', metadata })
  expect((await store.listManifestsBySession('session-1')).map(item => item.recoveryId)).toEqual(['recovery-1'])
  expect((await store.listJournalsBySession('session-1')).map(item => item.operationId)).toEqual(['recovery-1'])
})

test('project recovery artifacts resolve beneath project private data and remain relocatable', async () => {
  root = await mkdtemp(join(tmpdir(), 'profer-rewind-project-'))
  const projectRoot = join(root, 'project')
  const dataDir = join(projectRoot, '.profer', 'sessions', 'session-1')
  registerSessionStorageLayout('session-1', { kind: 'project', dataDir })
  const paths = createSessionStorePaths(root)
  const store = createRewindStore(paths, 'session-1')
  expect(sessionRewindPath(paths, 'session-1')).toBe(join(projectRoot, '.profer', 'rewind', 'session-1'))
  expect(resolveProjectRelativePath(projectRoot, 'src/main.ts')).toBe('src/main.ts')
  expect(() => resolveProjectRelativePath(projectRoot, '../outside.txt')).toThrow()
  const version = await store.putVersion({ kind: 'file', content: Buffer.from('relative') })
  await store.writeManifest({ recoveryId: 'r1', sessionId: 'session-1', status: 'ready', createdAt: 1, refs: version.kind === 'file' ? [version.contentRef] : [] })
  const movedRoot = join(root, 'moved-project')
  await cp(store.paths.rootDir, join(movedRoot, '.profer', 'rewind', 'session-1'), { recursive: true })
  registerSessionStorageLayout('session-1', { kind: 'project', dataDir: join(movedRoot, '.profer', 'sessions', 'session-1') })
  const movedStore = createRewindStore(paths, 'session-1')
  expect(await movedStore.readManifest('r1')).toBeDefined()
  expect(await movedStore.readVersion(version)).toEqual(Buffer.from('relative'))
  unregisterSessionStorageLayout('session-1')
})
