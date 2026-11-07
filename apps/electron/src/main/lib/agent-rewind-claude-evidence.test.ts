import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRewindStore, createSessionStorePaths } from '@profer/session-store'
import { createElectronClaudeRewindEvidencePort } from './agent-rewind-claude-evidence'

describe('Electron Claude rewind evidence port', () => {
  test('持久化 Write 前后 immutable contentRef 和配对证据', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profer-claude-evidence-'))
    const sessionId = 'claude-evidence-session'
    const filePath = join(root, 'tracked.txt')
    const paths = createSessionStorePaths(root)
    const port = createElectronClaudeRewindEvidencePort(paths)

    await writeFile(filePath, 'before')
    const before = await port.capture({
      phase: 'before', sessionId, promptId: 'prompt-1', toolUseId: 'tool-1', toolName: 'Write',
      toolInput: { file_path: filePath }, path: filePath, cwd: root,
    })
    await writeFile(filePath, 'after')
    const after = await port.capture({
      phase: 'after', sessionId, promptId: 'prompt-1', toolUseId: 'tool-1', toolName: 'Write',
      toolInput: { file_path: filePath }, path: filePath, cwd: root,
    })

    expect(before).toMatchObject({ exists: true, contentRef: expect.any(String), backupRef: expect.any(String) })
    expect(after).toMatchObject({ exists: true, contentRef: expect.any(String) })
    expect(before?.contentRef).not.toBe(after?.contentRef)

    await port.record({ sessionId, promptId: 'prompt-1', toolUseId: 'tool-1', toolName: 'Write', path: filePath, before: before!, after: after!, status: 'complete' })
    const store = createRewindStore(paths, sessionId)
    const evidenceId = `claude-evidence-${digest('prompt-1\0tool-1')}`
    const manifest = await store.readManifest(evidenceId)
    expect(manifest).toMatchObject({ sessionId, status: 'ready', metadata: { kind: 'claude-tool-evidence' } })
    expect(manifest?.refs).toEqual(expect.arrayContaining([before!.contentRef, after!.contentRef]))
    const contentHash = createHash('sha256').update('before').digest('hex')
    const persistedVersion = await store.readVersion({ kind: 'file', contentRef: contentHash, sha256: contentHash, size: 6 })
    expect(persistedVersion).toEqual(Buffer.from('before'))
  })
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40)
}
