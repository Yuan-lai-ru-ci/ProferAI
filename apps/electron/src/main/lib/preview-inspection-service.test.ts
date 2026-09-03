import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  inspectPreview,
  type PreviewInspectionDependencies,
} from './preview-inspection-service'

let temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })))
  temporaryDirectories = []
})

async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), 'profer-preview-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'profer-preview-outside-'))
  temporaryDirectories.push(root, outside)
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'code.ts'), 'const value = 1\n', 'utf8')
  await writeFile(join(root, 'note.md'), '# Preview\n\nHello', 'utf8')
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
  return { root, outside }
}

describe('preview inspection service', () => {
  test('resolves relative paths against the agent cwd and applies content defaults', async () => {
    const { root } = await fixture()
    const result = await inspectPreview({ filePath: 'code.ts' }, { agentCwd: root, allowedRoots: [] })
    expect('file' in result).toBe(true)
    if ('file' in result) {
      expect(result.file.name).toBe('code.ts')
      expect(result.file.kind).toBe('text')
      expect(result.content?.text).toContain('const value')
      expect(result.visual).toBeUndefined()
    }
  })

  test('allows an explicitly authorized root and keeps absolute paths out of results', async () => {
    const { root, outside } = await fixture()
    const result = await inspectPreview({ filePath: join(outside, 'secret.txt') }, { agentCwd: root, allowedRoots: [outside] })
    expect('file' in result).toBe(true)
    if ('file' in result) expect(result.file.name).toBe('secret.txt')
    expect(JSON.stringify(result)).not.toContain(outside)
  })

  test('rejects a path outside authorized roots and a symlink escaping the root', async () => {
    const { root, outside } = await fixture()
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))

    const direct = await inspectPreview({ filePath: join(outside, 'secret.txt') }, { agentCwd: root, allowedRoots: [] })
    const escaped = await inspectPreview({ filePath: 'escape.txt' }, { agentCwd: root, allowedRoots: [] })
    expect('error' in direct && direct.error.code).toBe('unauthorized_path')
    expect('error' in escaped && escaped.error.code).toBe('unauthorized_path')
  })

  test('uses visual defaults for markdown and passes explicit scope to the renderer', async () => {
    const { root } = await fixture()
    const calls: Array<{ filePath: string; scope: string; page?: number }> = []
    const dependencies: PreviewInspectionDependencies = {
      render: async (input) => {
        calls.push(input)
        return { images: [{ data: 'png-data', mediaType: 'image/png', page: input.page }] }
      },
    }
    const result = await inspectPreview({ filePath: 'note.md', scope: 'page', page: 2 }, { agentCwd: root, allowedRoots: [] }, dependencies)
    expect('file' in result).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.scope).toBe('page')
    expect(calls[0]?.page).toBe(2)
  })

  test('reports whether the current revision differs from the previous observation', async () => {
    const { root } = await fixture()
    const first = await inspectPreview({ filePath: 'code.ts' }, { agentCwd: root, allowedRoots: [] })
    if (!('file' in first)) throw new Error('expected first inspection to succeed')
    await writeFile(join(root, 'code.ts'), 'const value = 2\n', 'utf8')
    const second = await inspectPreview({ filePath: 'code.ts', previousRevision: first.file.revision }, { agentCwd: root, allowedRoots: [] })
    expect('file' in second && second.changedSincePreviousRevision).toBe(true)
  })

  test('requires a positive integer page for page scope', async () => {
    const { root } = await fixture()
    const result = await inspectPreview({ filePath: 'note.md', scope: 'page' }, { agentCwd: root, allowedRoots: [] })
    expect('error' in result && result.error.code).toBe('invalid_page')
  })

  test('does not return a mixed result when the file changes during inspection', async () => {
    const { root } = await fixture()
    const dependencies: PreviewInspectionDependencies = {
      readText: async (path) => {
        const text = await Bun.file(path).text()
        await writeFile(path, `${text}!`, 'utf8')
        return text
      },
    }
    const result = await inspectPreview({ filePath: 'code.ts' }, { agentCwd: root, allowedRoots: [] }, dependencies)
    expect('error' in result && result.error.code).toBe('file_changed_during_inspection')
    expect('error' in result && result.error.retryable).toBe(true)
  })
})
