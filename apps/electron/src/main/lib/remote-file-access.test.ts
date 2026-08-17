import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAuthorizedRemoteFilePath } from './remote-file-access'

const testRoots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-remote-file-access-'))
  testRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveAuthorizedRemoteFilePath', () => {
  test('allows a file inside the current workspace root', () => {
    const root = makeRoot()
    const file = join(root, 'workspace', 'notes.md')
    mkdirSync(join(root, 'workspace'), { recursive: true })
    writeFileSync(file, 'ok')

    expect(resolveAuthorizedRemoteFilePath(file, {
      directoryRoots: [join(root, 'workspace')],
      exactFiles: [],
    })).toBe(file)
  })

  test('allows relative paths only below server-derived roots', () => {
    const root = makeRoot()
    const workspace = join(root, 'workspace')
    const file = join(workspace, 'src', 'app.ts')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(file, 'ok')

    expect(resolveAuthorizedRemoteFilePath('src/app.ts', {
      directoryRoots: [workspace],
      exactFiles: [],
    })).toBe(file)
  })

  test('rejects another workspace even when the client submits an absolute path', () => {
    const root = makeRoot()
    const currentWorkspace = join(root, 'current')
    const otherWorkspace = join(root, 'other')
    const otherFile = join(otherWorkspace, 'secret.txt')
    mkdirSync(currentWorkspace, { recursive: true })
    mkdirSync(otherWorkspace, { recursive: true })
    writeFileSync(otherFile, 'secret')

    expect(resolveAuthorizedRemoteFilePath(otherFile, {
      directoryRoots: [currentWorkspace],
      exactFiles: [],
    })).toBeNull()
  })

  test('allows an explicitly attached file without authorizing its sibling files', () => {
    const root = makeRoot()
    const attached = join(root, 'outside', 'allowed.txt')
    const sibling = join(root, 'outside', 'blocked.txt')
    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(attached, 'allowed')
    writeFileSync(sibling, 'blocked')

    const context = { directoryRoots: [], exactFiles: [attached] }
    expect(resolveAuthorizedRemoteFilePath(attached, context)).toBe(attached)
    expect(resolveAuthorizedRemoteFilePath(sibling, context)).toBeNull()
  })

  test('rejects an in-root symlink that resolves outside the authorized root', () => {
    const root = makeRoot()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside.txt')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(workspace, 'escape.txt'), 'file')

    expect(resolveAuthorizedRemoteFilePath(join(workspace, 'escape.txt'), {
      directoryRoots: [workspace],
      exactFiles: [],
    })).toBeNull()
  })
})
