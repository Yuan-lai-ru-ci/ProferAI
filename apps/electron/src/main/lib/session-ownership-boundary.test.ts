import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./agent-session-manager.ts', import.meta.url), 'utf8')
const mutators = ['enqueueSDKMessages', 'restoreAgentRuntimeMeta', 'createDelegatedChildSessionMeta', 'ensureAgentSessionWriteLayout', 'createAgentSession', 'ensureProjectDraftAgentSession', 'appendAgentMessage', 'appendSDKMessages', 'updateAgentSessionMeta', 'cleanupResidualSessionFiles', 'deleteAgentSession', 'deleteAgentSessionsByWorkspace', 'moveSessionToWorkspace', 'migrateChatToAgentSession', 'rewindPiSession', 'resetPiSession', 'forkAgentSession', 'truncateSDKMessages', 'clearSDKMessages', 'resetClaudeSession', 'rewindFilesFromSnapshot', 'autoArchiveAgentSessions', 'cleanupStaleAttachedPaths', 'migrateProjectSessionLayouts', 'ensureProjectSessionPortability', 'rollbackProjectSessionLayouts']

describe('桌面会话持久化写权边界', () => {
  for (const name of mutators) test(`${name} 在任何业务操作前拒绝 Core ownership`, () => {
    const start = source.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    // 参数可能包含对象类型；以明确的保护调用验证入口，且不加载真实宿主模块。
    const guard = source.indexOf('assertDesktopSessionWriteAllowed()', start)
    expect(guard).toBeGreaterThan(start)
    expect(guard - start).toBeLessThan(2500)
  })
  test('索引实例只读、写边界保护及 shutdown 不刷回 Core 数据', () => {
    expect(source).toContain('{ readOnly: coreOwnsSessionStore }')
    expect(source).toContain('const writeIndex = (index: AgentSessionsIndex) => {\n  assertDesktopSessionWriteAllowed()')
    expect(source).toContain('if (coreOwnsSessionStore()) {\n    persistenceQueue.dispose()')
  })
})
