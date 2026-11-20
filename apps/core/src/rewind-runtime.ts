import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentSessionMeta } from '@profer/shared'
import type { AgentRuntimeQuery } from '@profer/agent-runtime'
import type { PiAgentQueryOptions } from '@profer/agent-provider-pi'
import type { ClaudeRewindEvidencePort, ClaudeRewindToolEvidence } from '@profer/agent-provider-claude'
import { createSessionStorePaths, createRewindStore, WorkspaceShadowRepository, deriveAttachedRootId, normalizeShadowRoots, createGitRunner, diffShadowCommits, buildShadowTurnAttribution, appendShadowTurnAttribution, type ShadowTurnEvidenceItem, type ShadowRoot } from '@profer/session-store'
import type { CoreConfig } from './config'
import type { CoreAgentRuntime } from './runtime'
import { loadPiRewindTracker, persistPiRewindTracker } from './native-rewind-pi'

/** 每次 prepareRun 对应一个实际 run；finalize 必须在 provider 终态后调用。 */
export function createCoreRewindRuntime(config: CoreConfig, runtime: CoreAgentRuntime) {
  const paths = createSessionStorePaths(config.configDir)
  return {
    async prepareRun(session: AgentSessionMeta, query: AgentRuntimeQuery, cwd: string) {
      const workspace = runtime.workspaces.list().find(item => item.id === session.workspaceId)
      if (!workspace) throw new Error('回退证据缺少所属工作区')
      const turnId = query.context?.trigger.id
      if (!turnId) throw new Error('运行缺少稳定用户消息身份')
      const startedAt = Date.now()
      const primary = realpathSync(workspace.storageMode === 'project' ? workspace.rootPath! : join(config.workspaceRoot, workspace.slug))
      const attached = [...(session.attachedDirectories ?? [])]
      const settingsPath = join(workspace.storageMode === 'project' ? join(primary, '.profer') : join(config.configDir, 'workspaces', workspace.slug), 'config.json')
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { attachedDirectories?: unknown }
        if (Array.isArray(settings.attachedDirectories)) attached.push(...settings.attachedDirectories.filter((path): path is string => typeof path === 'string'))
      }
      const roots: ShadowRoot[] = normalizeShadowRoots([{ rootId: workspace.id, rootPath: primary, kind: workspace.storageMode === 'project' ? 'project' : 'managed' }, ...attached.filter(path => existsSync(path)).map(path => { const canonical = realpathSync(path); return { rootId: deriveAttachedRootId(canonical), rootPath: canonical, kind: 'attached' as const } })])
      const shadowDir = join(config.configDir, 'workspace-shadow', workspace.id)
      const repoDir = join(shadowDir, 'repo.git')
      const repository = await WorkspaceShadowRepository.open({ workspaceId: workspace.id, repoDir, journalPath: join(shadowDir, 'journal.json'), gitPath: 'git', excludeAbsolutePaths: () => [config.configDir, join(primary, '.profer'), join(primary, '.context')] })
      const before = await repository.capture({ reason: 'turn-before', roots })
      if (!before.ok) throw new Error(`回退证据开始快照失败: ${before.error}`)
      const evidence: ShadowTurnEvidenceItem[] = []
      let queue: Promise<void> = Promise.resolve()
      const failures: unknown[] = []
      const serial = (action: () => Promise<void>) => { const result = queue.then(action); queue = result.catch(error => { failures.push(error) }); return result }
      const trackerFile = join(paths.rewindDir, session.id, 'pi-tracker.json')
      const store = createRewindStore(paths, session.id)
      const scope = (path: string) => {
        const absolute = resolve(cwd, path)
        for (const root of roots) { const rel = relative(root.rootPath, absolute); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { rootId: root.rootId, relativePath: rel, coverage: root.kind === 'project' ? 'project' as const : 'managed' as const } }
        throw new Error('写入证据路径越出当前运行授权根')
      }
      const pi: Pick<PiAgentQueryOptions, 'metadata' | 'onRewindTurn' | 'onFileMutation'> = {
        metadata: { rewindTurnId: turnId },
        onRewindTurn: event => serial(async () => {
          const tracker = await loadPiRewindTracker(trackerFile, session.id)
          if (event.phase === 'begin') tracker.beginTurn(event.turnId, event.timestamp)
          else if (event.phase === 'complete') tracker.completeTurn(event.turnId, event.terminalEntryId, event.timestamp)
          else tracker.failTurn(event.turnId, event.timestamp)
          await persistPiRewindTracker(trackerFile, tracker)
        }),
        onFileMutation: fact => serial(async () => {
          const location = scope(fact.path)
          const beforeBackup = fact.beforeContent !== undefined ? await store.putVersion({ kind: 'file', content: fact.beforeContent }) : fact.before?.kind === 'absent' ? { kind: 'absent' as const } : undefined
          const afterBackup = fact.afterContent !== undefined ? await store.putVersion({ kind: 'file', content: fact.afterContent }) : fact.after?.kind === 'absent' ? { kind: 'absent' as const } : undefined
          evidence.push({ seq: evidence.length + 1, toolUseId: fact.toolCallId, path: resolve(cwd, fact.path), source: fact.source, beforeRef: beforeBackup?.kind === 'file' ? beforeBackup.contentRef : undefined, afterRef: afterBackup?.kind === 'file' ? afterBackup.contentRef : undefined })
          const tracker = await loadPiRewindTracker(trackerFile, session.id)
          tracker.recordMutation(turnId, { ...fact, ...location, beforeBackup, afterBackup })
          await persistPiRewindTracker(trackerFile, tracker)
        }),
      }
      const claudeEvidence: ClaudeRewindEvidencePort = {
        async capture(input) {
          if (input.sessionId !== session.id) throw new Error('证据会话不匹配')
          scope(input.path)
          try {
            const stat = await lstat(input.path)
            if (!stat.isFile() || stat.isSymbolicLink()) return null
            const content = await readFile(input.path)
            const stored = await store.putVersion({ kind: 'file', content, mode: stat.mode & 0o777 })
            if (stored.kind !== 'file') return null
            return { path: input.path, revision: createHash('sha256').update(`${stored.sha256}:${stored.mode ?? 0}`).digest('hex'), exists: true, contentRef: stored.contentRef, backupRef: stored.contentRef }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: input.path, revision: createHash('sha256').update(`absent:${input.path}`).digest('hex'), exists: false }
            throw error
          }
        },
        record: fact => serial(async () => {
          if (fact.sessionId !== session.id) throw new Error('证据会话不匹配')
          const file = join(paths.rewindDir, session.id, 'claude-evidence.jsonl')
          mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(fact) + '\n', { mode: 0o600 })
          const record = { ...fact, turnId }
          const recoveryId = `claude-evidence-${createHash('sha256').update(`${turnId}:${fact.toolUseId ?? ''}`).digest('hex').slice(0, 40)}`
          await store.writeManifest({ recoveryId, sessionId: session.id, status: 'ready', createdAt: Date.now(), refs: [fact.before?.contentRef, fact.after?.contentRef].filter((ref): ref is string => !!ref), metadata: { kind: 'claude-tool-evidence', evidence: record } })
          if (fact.status !== 'complete') return
          scope(fact.path)
          evidence.push({ seq: evidence.length + 1, toolUseId: fact.toolUseId, toolName: fact.toolName, path: fact.path, source: fact.toolName === 'Write' ? 'write' : 'edit', beforeRef: fact.before?.contentRef, afterRef: fact.after?.contentRef })
        }),
      }
      let finalization: Promise<void> | undefined
      return { pi, claude: { rewindEvidence: claudeEvidence, enableFileCheckpointing: true }, finalize: (options: { failed?: boolean } = {}) => finalization ??= (async () => {
        await queue
        const tracker = await loadPiRewindTracker(trackerFile, session.id)
        if (session.agentRuntime === 'pi' && options.failed) { tracker.failTurn(turnId); await persistPiRewindTracker(trackerFile, tracker) }
        const after = await repository.capture({ reason: 'turn-after', roots })
        if (!after.ok) throw new Error(`回退证据结束快照失败: ${after.error}`)
        const diff = await diffShadowCommits(createGitRunner({ gitPath: 'git' }), repoDir, before.commitId, after.commitId)
        if (!diff.ok) throw new Error(diff.error)
        appendShadowTurnAttribution(shadowDir, buildShadowTurnAttribution({ workspaceId: workspace.id, sessionId: session.id, turnId, runtime: session.agentRuntime ?? query.runtime, beforeCommitId: before.commitId, afterCommitId: after.commitId, roots, evidence, diff: diff.entries, startedAt, endedAt: Date.now(), beforeTreeSha: before.treeSha, afterTreeSha: after.treeSha, partial: !!options.failed || failures.length > 0, note: failures.length ? `写入证据持久化失败 ${failures.length} 次` : undefined }))
      })() }
    },
  }
}
