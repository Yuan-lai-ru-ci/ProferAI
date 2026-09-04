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

  test('uses visual defaults for markdown and passes sanitized visual data to the renderer', async () => {
    const { root } = await fixture()
    const calls: Array<{ filePath: string; fileName: string; scope: string; page?: number; text?: string }> = []
    const dependencies: PreviewInspectionDependencies = {
      render: async (input) => {
        calls.push(input)
        return { images: [{ data: 'png-data', mediaType: 'image/png', page: input.page }] }
      },
    }
    const result = await inspectPreview({ filePath: 'note.md', scope: 'page', page: 2 }, { agentCwd: root, allowedRoots: [] }, dependencies)
    expect('file' in result).toBe(true)
    if ('file' in result) {
      expect(result.content?.text).toContain('Hello')
      expect(result.visual?.images[0]?.mediaType).toBe('image/png')
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ fileName: 'note.md', scope: 'page', page: 2, text: '# Preview\n\nHello' })
  })

  test('renders visual-only Markdown with source text and treats an empty response as retryable failure', async () => {
    const { root } = await fixture()
    let visualText: string | undefined
    const result = await inspectPreview({ filePath: 'note.md', mode: 'visual' }, { agentCwd: root, allowedRoots: [] }, {
      render: async (input) => { visualText = input.text; return { images: [] } },
    })
    expect(visualText).toContain('Hello')
    expect('error' in result && result.error).toMatchObject({ code: 'renderer_failed', retryable: true })
  })

  test('maps renderer page bounds to the stable page_out_of_range error', async () => {
    const { root } = await fixture()
    const result = await inspectPreview({ filePath: 'note.md', mode: 'visual', scope: 'page', page: 4 }, { agentCwd: root, allowedRoots: [] }, {
      render: async () => { throw Object.assign(new Error('页码 4 超出范围'), { code: 'page_out_of_range' }) },
    })
    expect('error' in result && result.error.code).toBe('page_out_of_range')
  })

  test('reports whether the current revision differs from the previous observation', async () => {
    const { root } = await fixture()
    const first = await inspectPreview({ filePath: 'code.ts' }, { agentCwd: root, allowedRoots: [] })
    if (!('file' in first)) throw new Error('expected first inspection to succeed')
    await writeFile(join(root, 'code.ts'), 'const value = 2\n', 'utf8')
    const second = await inspectPreview({ filePath: 'code.ts', previousRevision: first.file.revision }, { agentCwd: root, allowedRoots: [] })
    expect('file' in second && second.changedSincePreviousRevision).toBe(true)
  })

  test('requires a positive integer page only for page scope', async () => {
    const { root } = await fixture()
    const missing = await inspectPreview({ filePath: 'note.md', scope: 'page' }, { agentCwd: root, allowedRoots: [] })
    const misplaced = await inspectPreview({ filePath: 'note.md', scope: 'overview', page: 2 }, { agentCwd: root, allowedRoots: [] })
    expect('error' in missing && missing.error.code).toBe('invalid_page')
    expect('error' in misplaced && misplaced.error.code).toBe('invalid_page')
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
