import { afterEach, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRewindFilePort, type RewindFileRoot } from './agent-rewind-file-port'

let temp = ''
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = '' })
async function setup(kind: RewindFileRoot['kind'] = 'managed') {
  temp = await mkdtemp(join(tmpdir(), 'profer-rewind-port-'))
  const root = join(temp, 'workspace')
  await mkdir(root)
  let roots: RewindFileRoot[] = [{ rootId: 'workspace-1', rootPath: root, kind }]
  return { root, setRoots(value: RewindFileRoot[]) { roots = value }, port: createRewindFilePort({ roots: async () => roots, protectedPaths: [join(temp, 'attachments'), join(temp, 'recovery')] }) }
}

test('authorizes managed and project roots and re-resolves root bindings on each operation', async () => {
  const managed = await setup()
  await writeFile(join(managed.root, 'note.txt'), 'managed')
  expect((await managed.port.inspect('workspace-1', 'note.txt')).version.kind).toBe('file')
  managed.setRoots([{ rootId: 'workspace-1', rootPath: managed.root, kind: 'project' }])
  await expect(managed.port.resolve('workspace-1', '.profer/private.txt')).rejects.toMatchObject({ code: 'PROTECTED_PATH' })
  managed.setRoots([])
  await expect(managed.port.resolve('workspace-1', 'note.txt')).rejects.toMatchObject({ code: 'ROOT_UNAUTHORIZED' })
})

test('rejects absolute, traversal, symlink, directory, special and hard-linked targets', async () => {
  const { root, port } = await setup()
  await mkdir(join(root, 'dir'))
  await writeFile(join(root, 'outside'), 'secret')
  await symlink(join(root, 'outside'), join(root, 'link'))
  await link(join(root, 'outside'), join(root, 'hardlink'))
  for (const value of ['../outside', '/tmp/secret', 'dir/../outside', 'link', 'dir', 'hardlink']) {
    await expect(port.inspect('workspace-1', value)).rejects.toThrow()
  }
  await expect(port.inspect('missing-root', 'outside')).rejects.toMatchObject({ code: 'ROOT_UNAUTHORIZED' })
})

test('protects project private data, git metadata, recovery and attachment originals', async () => {
  const { root, port } = await setup('project')
  await mkdir(join(root, '.profer'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(temp, 'attachments'))
  await mkdir(join(temp, 'recovery'))
  for (const value of ['.profer/rewind/file', '.git/config', '.runtime/skills/a']) {
    await expect(port.resolve('workspace-1', value)).rejects.toMatchObject({ code: 'PROTECTED_PATH' })
  }
  for (const value of [join(temp, 'attachments', 'file'), join(temp, 'recovery', 'file')]) {
    await expect(port.resolve('workspace-1', value)).rejects.toMatchObject({ code: 'INVALID_RELATIVE_PATH' })
  }
})

test('performs CAS writes and deletes while preserving unrelated external changes', async () => {
  const { root, port } = await setup()
  await writeFile(join(root, 'note.txt'), 'before')
  const before = await port.inspect('workspace-1', 'note.txt')
  const after = await port.write('workspace-1', 'note.txt', Buffer.from('restored'), 0o640, before.version)
  expect(after).toMatchObject({ kind: 'file', size: 8, mode: 0o640 })
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('restored')
  await writeFile(join(root, 'note.txt'), 'external')
  await expect(port.write('workspace-1', 'note.txt', Buffer.from('stale'), undefined, after)).rejects.toMatchObject({ code: 'CAS_MISMATCH' })
  const external = await port.inspect('workspace-1', 'note.txt')
  expect(await port.write('workspace-1', 'note.txt', undefined, undefined, external.version)).toEqual({ kind: 'absent' })
})

test('persists inspected content through the D1 object callback', async () => {
  const { root } = await setup()
  await writeFile(join(root, 'tracked.txt'), 'tracked')
  const stored: Buffer[] = []
  const port = createRewindFilePort({
    roots: async () => [{ rootId: 'root', rootPath: root, kind: 'managed' }],
    storeVersion: async content => {
      if (!content) return { kind: 'absent' }
      stored.push(content)
      const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
      return { kind: 'file', contentRef: sha256, sha256, size: content.length }
    },
  })
  const result = await port.inspect('root', 'tracked.txt')
  expect(result.version.kind).toBe('file')
  expect(stored.map(item => item.toString())).toEqual(['tracked'])
})


test('does not follow a parent symlink and supports project root relocation by reauthorization', async () => {
  const { root, setRoots, port } = await setup('project')
  const moved = join(temp, 'moved')
  await mkdir(moved)
  await writeFile(join(moved, 'ok.txt'), 'moved')
  await symlink(moved, join(root, 'linked'))
  await expect(port.inspect('workspace-1', 'linked/ok.txt')).rejects.toMatchObject({ code: 'UNSAFE_PARENT' })
  setRoots([{ rootId: 'workspace-1', rootPath: moved, kind: 'project' }])
  expect((await port.inspect('workspace-1', 'ok.txt')).content?.toString()).toBe('moved')
})
