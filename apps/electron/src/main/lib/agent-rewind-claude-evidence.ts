import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type {
  ClaudeRewindEvidenceCaptureInput,
  ClaudeRewindEvidencePort,
  ClaudeRewindFileSnapshot,
  ClaudeRewindToolEvidence,
} from '@profer/agent-provider-claude'
import { createRewindStore } from '@profer/session-store'
import type { SessionStorePaths } from '@profer/session-store'
import { createElectronSessionStorePaths } from './session-store-host'

const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')

/** Captures Claude Write/Edit versions into the session store's immutable object store. */
export function createElectronClaudeRewindEvidencePort(
  paths: Pick<SessionStorePaths, 'configDir' | 'rewindDir'> = createElectronSessionStorePaths(),
): ClaudeRewindEvidencePort {
  return {
    async capture(input: ClaudeRewindEvidenceCaptureInput): Promise<ClaudeRewindFileSnapshot | null> {
      let fileStat
      let content: Buffer
      try {
        fileStat = await stat(input.path)
        if (!fileStat.isFile()) return null
        content = await readFile(input.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { path: input.path, revision: sha256(`absent:${input.path}`), exists: false }
        }
        throw error
      }
      const store = createRewindStore(paths, input.sessionId)
      const stored = await store.putVersion({ kind: 'file', content, mode: fileStat.mode & 0o777 })
      if (stored.kind !== 'file') return null
      return {
        path: input.path,
        revision: sha256(`${stored.sha256}:${stored.mode ?? 0}`),
        exists: true,
        contentRef: stored.contentRef,
        backupRef: stored.contentRef,
      }
    },
    async record(evidence: ClaudeRewindToolEvidence): Promise<void> {
      const id = `claude-evidence-${sha256(`${evidence.promptId ?? ''}\0${evidence.toolUseId ?? ''}`).slice(0, 40)}`
      const refs = [...new Set([
        evidence.before?.contentRef,
        evidence.before?.backupRef,
        evidence.after?.contentRef,
        evidence.after?.backupRef,
      ].filter((ref): ref is string => typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref)))]
      const store = createRewindStore(paths, evidence.sessionId)
      const existing = await store.readManifest(id)
      const manifest = {
        recoveryId: id,
        sessionId: evidence.sessionId,
        status: 'ready' as const,
        createdAt: Date.now(),
        refs,
        metadata: { kind: 'claude-tool-evidence', evidence },
      }
      if (existing) {
        const existingComparable = { ...existing, createdAt: 0 }
        const nextComparable = { ...manifest, createdAt: 0 }
        if (JSON.stringify(existingComparable) !== JSON.stringify(nextComparable)) {
          throw new Error('Claude 回退证据标识冲突，拒绝覆盖不可变记录')
        }
        return
      }
      await store.writeManifest(manifest)
    },
  }
}
