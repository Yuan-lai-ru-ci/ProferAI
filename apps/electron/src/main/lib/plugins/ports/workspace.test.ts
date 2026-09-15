import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginRpcError } from '../plugin-rpc-errors'
import { pluginConfirmations } from '../plugin-confirmation'
import { createLocalWorkspaceProvider, LocalWorkspaceFilePort, StaticWorkspaceResolver, validateWorkspaceRelativePath, type WorkspaceProvider, type WorkspaceResolution } from './workspace'

let root = ''
let workspace: WorkspaceResolution
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-plugin-workspace-'))
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes', 'first.txt'), 'hello')
  mkdirSync(join(root, '.profer'))
  workspace = { workspaceId: 'editor', displayName: 'Editor workspace', rootPath: root }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function errorCode(action: () => unknown): string | undefined {
  try { action(); return undefined } catch (error) { return error instanceof PluginRpcError ? error.code : undefined }
}

test('workspace path accepts only relative POSIX file names and rejects traversal forms', () => {
  expect(validateWorkspaceRelativePath('notes/first.txt')).toBe('notes/first.txt')
  for (const value of ['/etc/passwd', 'C:/secret', '\\\\server\\share', 'notes\\first.txt', 'notes//first.txt', 'notes/./first.txt', 'notes/../first.txt', 'notes/\0x']) {
    expect(errorCode(() => validateWorkspaceRelativePath(value))).toBe('PLUGIN_INVALID_ARGUMENT')
  }
  expect(errorCode(() => validateWorkspaceRelativePath(''))).toBe('PLUGIN_INVALID_ARGUMENT')
  expect(errorCode(() => validateWorkspaceRelativePath(undefined, true))).toBeUndefined()
})

test('local provider returns opaque workspace DTO and never exposes root path', async () => {
  const provider = createLocalWorkspaceProvider([workspace])
  const listed = await provider.resolver.list()
  expect(listed).toEqual({ items: [{ workspaceId: 'editor', displayName: 'Editor workspace', revision: 0 }], revision: 0 })
  expect(JSON.stringify(listed)).not.toContain(root)
  const files = await provider.files.list({ workspaceId: 'editor', path: 'notes', depth: 1 })
  expect(files.entries).toEqual([{ path: 'notes/first.txt', kind: 'file', size: 5, modifiedAt: expect.any(String) }])
  expect(JSON.stringify(files)).not.toContain(root)
})

test('write requires confirmation, uses integer CAS, and atomically creates or replaces one file', async () => {
  const resolver = new StaticWorkspaceResolver([workspace])
  const port = new LocalWorkspaceFilePort(resolver)
  const signal = new AbortController().signal
  await expect(port.write({ workspaceId: 'editor', path: 'notes/new.txt', content: 'new', mode: 'create', expectedRevision: 0, signal })).resolves.toMatchObject({ committed: true, revision: 1 })
  await expect(port.write({ workspaceId: 'editor', path: 'notes/new.txt', content: 'overwrite', mode: 'create', expectedRevision: 1, signal })).rejects.toMatchObject({ code: 'PLUGIN_REVISION_CONFLICT' })
  await expect(port.write({ workspaceId: 'editor', path: 'notes/new.txt', content: 'overwrite', mode: 'replace', expectedRevision: 0, signal })).rejects.toMatchObject({ code: 'PLUGIN_REVISION_CONFLICT' })
  await expect(port.write({ workspaceId: 'editor', path: 'notes/new.txt', content: 'overwrite', mode: 'replace', expectedRevision: 1, signal })).resolves.toMatchObject({ committed: true, revision: 2 })
  expect(pluginConfirmations).toBeDefined()
})

test('abort before commit prevents write and symlink ancestors are rejected', async () => {
  const resolver = new StaticWorkspaceResolver([workspace])
  const port = new LocalWorkspaceFilePort(resolver)
  const controller = new AbortController(); controller.abort()
  await expect(port.write({ workspaceId: 'editor', path: 'notes/aborted.txt', content: 'no', mode: 'create', expectedRevision: 0, signal: controller.signal })).rejects.toMatchObject({ code: 'PLUGIN_REQUEST_CANCELLED' })
  expect(() => symlinkSync(join(root, 'notes'), join(root, 'link'), 'junction')).not.toThrow()
  await expect(port.read({ workspaceId: 'editor', path: 'link/first.txt' })).rejects.toMatchObject({ code: 'PLUGIN_PERMISSION_DENIED' })
})

test('two provider-neutral consumers can implement the same port without domain fields', async () => {
  const local = createLocalWorkspaceProvider([workspace])
  const external: WorkspaceProvider = {
    resolver: { list: async () => ({ items: [{ workspaceId: 'board', displayName: 'Task board', revision: 4 }], revision: 4 }), resolve: async (workspaceId) => ({ workspaceId, displayName: 'Task board', rootPath: root }) },
    files: { list: async () => ({ entries: [{ path: 'tasks.txt', kind: 'file' }], revision: 4 }), read: async (input) => ({ workspaceId: input.workspaceId, path: input.path, content: 'task', encoding: 'utf8', truncated: false, revision: 4 }), write: async (input) => ({ workspaceId: input.workspaceId, path: input.path, bytesWritten: input.content.length, revision: 5, committed: true }) },
  }
  expect(await local.resolver.list()).toMatchObject({ items: [{ workspaceId: 'editor' }] })
  expect(await external.resolver.list()).toMatchObject({ items: [{ workspaceId: 'board' }] })
  expect(Object.keys((await external.resolver.list()).items[0]!)).toEqual(['workspaceId', 'displayName', 'revision'])
})
