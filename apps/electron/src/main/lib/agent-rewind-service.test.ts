import { describe, expect, test } from 'bun:test'
import type {
  RewindMode,
  RewindPlan,
  RewindRevision,
  RewindResult,
  RewindTarget,
} from '@profer/shared'

interface FakeSessionPort {
  read(sessionId: string): Promise<{ messages: string[]; nativeResume: string; revision: RewindRevision }>
  resolveTarget(input: { sessionId: string; target: RewindTarget }): Promise<{ messages: string[]; nativeResume: string } | undefined>
  writeConversation(sessionId: string, value: { messages: string[]; nativeResume: string }): Promise<void>
}

interface FakeResolverPort {
  resolve(input: { mode: RewindMode; target: RewindTarget }): Promise<{
    conversation?: { messages: string[]; nativeResume: string }
    files?: Array<{ path: string; action: 'restore' | 'delete'; currentRevision: string; targetRevision: string; targetValue?: string }>
  }>
}

interface FakeFilePort {
  read(path: string): Promise<{ revision: string; value: string } | undefined>
  write(path: string, value: string | undefined, expectedRevision: string): Promise<void>
}

interface FakeRecoveryPort {
  backup(input: { sessionId: string; files: string[]; messages: string[]; nativeResume: string; planId?: string; plan?: RewindPlan }): Promise<string>
  journal(input: { recoveryId: string; status: 'applying' | 'recovery-required' | 'committed' }): Promise<void>
  retain(recoveryId: string): Promise<void>
  undo(recoveryId: string): Promise<void>
  bindOwner?: (input: { sessionId: string; recoveryId: string; callerKey: string }) => Promise<void>
  readRecovery?: (sessionId: string, recoveryId: string) => Promise<{ recoveryId: string; sessionId: string; planId: string; mode: RewindMode; status: RewindResult['status']; ownerKey?: string; result?: RewindResult; undone?: RewindResult } | undefined>
  updateRecovery?: (input: { sessionId: string; recoveryId: string; patch: { status?: RewindResult['status']; result?: RewindResult; undone?: RewindResult } }) => Promise<void>
}

interface FakeLockPort {
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
}

interface FakePorts {
  session: FakeSessionPort
  resolver: FakeResolverPort
  files: FakeFilePort
  recovery: FakeRecoveryPort
  lock: FakeLockPort
  calls: string[]
  setFailure(point: string | undefined): void
  mutateFile(path: string, value: string, revision?: string): void
  recoveryOwners: Map<string, { sessionId: string; callerId: string }>
  executed: Map<string, RewindResult>
}

const initial = {
  messages: ['u1', 'a1', 'u2', 'a2'],
  nativeResume: 'a2',
  revision: { session: 4, files: 7, state: 11 },
} satisfies { messages: string[]; nativeResume: string; revision: RewindRevision }

function fakePorts(): FakePorts {
  const calls: string[] = []
  const filesState = new Map([
    ['tracked.txt', { revision: 'C', value: 'C' }],
    ['tracked-2.txt', { revision: 'E', value: 'E' }],
    ['untracked.txt', { revision: 'manual', value: 'manual' }],
  ])
  let failurePoint: string | undefined
  return {
    calls,
    recoveryOwners: new Map(),
    executed: new Map(),
    setFailure(point) { failurePoint = point },
    mutateFile(path, value, revision = `external:${value}`) { filesState.set(path, { revision, value }) },
    session: {
      async read() { calls.push('session:read'); return structuredClone(initial) },
      async resolveTarget({ target }) {
        calls.push('conversation:resolve')
        if (target.kind === 'after-turn' && target.turnId === 'missing') return undefined
        return { messages: ['u1', 'a1'], nativeResume: 'a1' }
      },
      async writeConversation() { calls.push('conversation:write') },
    },
    resolver: {
      async resolve({ mode, target }) {
        calls.push(`resolver:${mode}:${target.kind}`)
        if (failurePoint === 'resolver:both' && mode === 'both') {
          throw Object.assign(new Error('both capability unavailable'), { code: 'CAPABILITY_UNAVAILABLE' })
        }
        const isBoundary = target.kind === 'after-turn' && target.turnId === 'T1'
          || target.kind === 'before-turn' && target.turnId === 'T2'
        return {
          ...(mode !== 'files' && { conversation: { messages: ['u1', 'a1'], nativeResume: 'a1' } }),
          ...(mode !== 'conversation' && isBoundary && {
            files: [
              { path: 'tracked.txt', rootId: 'root', relativePath: 'tracked.txt', action: 'restore' as const, currentRevision: 'C', targetRevision: 'B', targetValue: 'B' },
              { path: 'tracked-2.txt', rootId: 'root', relativePath: 'tracked-2.txt', action: 'restore' as const, currentRevision: 'E', targetRevision: 'D', targetValue: 'D' },
            ],
          }),
        }
      },
    },
    files: {
      async read(path) { calls.push(`file:read:${path}`); return filesState.get(path) },
      async write(path, value, expectedRevision) {
        const writeCount = calls.filter(call => call === 'file:write').length + 1
        calls.push('file:write')
        if (failurePoint === `file:write:${writeCount}`) throw new Error('injected file write failure')
        const current = filesState.get(path)
        if ((current?.revision ?? 'absent') !== expectedRevision) throw Object.assign(new Error('revision conflict'), { code: 'CONFLICT' })
        if (value === undefined) filesState.delete(path)
        else filesState.set(path, { revision: value, value })
      },
    },
    recovery: {
      async backup() { calls.push('recovery:backup'); return 'recovery-1' },
      async journal({ status }) { calls.push(`journal:${status}`) },
      async retain() { calls.push('recovery:retain') },
      async undo() { calls.push('recovery:undo') },
    },
    lock: {
      async withSessionLock(_sessionId, operation) { calls.push('lock:acquire'); return operation() },
    },
  }
}

const target: RewindTarget = { kind: 'after-turn', turnId: 'T1' }
const modes: RewindMode[] = ['conversation', 'files', 'both']

async function createService(ports: FakePorts) {
  // D4 实现尚未创建；动态导入让骨架先通过静态检查并在当前阶段明确红灯。
  const modulePath: string = './agent-rewind-service'
  const serviceModule = await import(modulePath) as {
      createAgentRewindService(options: { ports: FakePorts }): {
      prepare(input: { sessionId: string; mode: RewindMode; target: RewindTarget }): Promise<{ plan: RewindPlan }>
      execute(input: { sessionId: string; planId: string; expectedRevision: RewindRevision }): Promise<RewindResult>
      undo(input: { sessionId: string; recoveryId: string; expectedRevision?: RewindRevision }, callerId?: string): Promise<RewindResult>
      bindRecoveryOwner(input: { sessionId: string; recoveryId: string; callerKey: string }): Promise<void>
    }
  }
  return serviceModule.createAgentRewindService({ ports })
}

describe('D4 agent rewind service failure and port harness', () => {
  test('conversation and files modes are isolated from the other mutation ports', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    for (const mode of modes) {
      ports.calls.length = 0
      const { plan } = await service.prepare({ sessionId: 'session-1', mode, target })
      expect(plan.mode).toBe(mode)
      if (mode === 'conversation') expect(plan.files).toBeUndefined()
      if (mode === 'files') expect(plan.conversation).toBeUndefined()
    }
    expect(ports.calls).toContain('conversation:resolve')
    expect(ports.calls).toContain('resolver:files:after-turn')
  })

  test('unknown target is rejected without treating it as session-start or mutating state', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    await expect(service.prepare({ sessionId: 'session-1', mode: 'conversation', target: { kind: 'after-turn', turnId: 'missing' } }))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect(ports.calls).not.toContain('conversation:write')
    expect(ports.calls).not.toContain('file:write')
  })

  test('both is rejected when either provider capability is unavailable', async () => {
    const ports = fakePorts()
    ports.setFailure('resolver:both')
    const service = await createService(ports)
    await expect(service.prepare({ sessionId: 'session-1', mode: 'both', target }))
      .rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(ports.calls).not.toContain('recovery:backup')
  })

  test('file revision conflict leaves the target unchanged', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'files', target })
    ports.mutateFile('tracked.txt', 'manual-edit')
    await expect(service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(ports.calls).not.toContain('conversation:write')
  })

  test('stale revision is rejected before backup, journal, or destructive writes', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    const stale = { ...plan.revision, files: plan.revision.files + 1 }
    await expect(service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: stale }))
      .rejects.toMatchObject({ code: 'PLAN_STALE' })
    expect(ports.calls).not.toContain('recovery:backup')
    expect(ports.calls).not.toContain('file:write')
    expect(ports.calls).not.toContain('conversation:write')
  })

  test('recovery backup and applying journal precede the first destructive file write', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'files', target })
    await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    expect(ports.calls.indexOf('recovery:backup')).toBeGreaterThanOrEqual(0)
    expect(ports.calls.indexOf('journal:applying')).toBeGreaterThan(ports.calls.indexOf('recovery:backup'))
    expect(ports.calls.indexOf('file:write')).toBeGreaterThan(ports.calls.indexOf('journal:applying'))
    expect(ports.calls).not.toContain('conversation:write')
  })

  test('partial file failure remains recovery-required and keeps recovery material', async () => {
    const ports = fakePorts()
    ports.setFailure('file:write:2')
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    const result = await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    expect(result.status).toBe('recovery-required')
    expect(ports.calls).toContain('journal:recovery-required')
    expect(ports.calls).toContain('recovery:retain')
  })

  test('undo rejects a different owner, restores once, and is idempotent for the same owner', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    const result = await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    if (!result.recoveryId) throw new Error('expected recovery id')
    ports.recoveryOwners.set(result.recoveryId, { sessionId: 'session-1', callerId: 'desktop' })
    await expect(service.undo({ sessionId: 'session-1', recoveryId: result.recoveryId }, 'remote:other'))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    const undo = await service.undo({ sessionId: 'session-1', recoveryId: result.recoveryId }, 'desktop')
    const repeated = await service.undo({ sessionId: 'session-1', recoveryId: result.recoveryId }, 'desktop')
    expect(repeated).toEqual(undo)
  })

  test('a fresh service discovers a persisted recovery and can undo it', async () => {
    const ports = fakePorts()
    const durable = new Map<string, {
      recoveryId: string
      sessionId: string
      planId: string
      mode: RewindMode
      status: RewindResult['status']
      result?: RewindResult
      undone?: RewindResult
      ownerKey?: string
    }>()
    Object.assign(ports.recovery, {
      async bindOwner({ sessionId, recoveryId, callerKey }: { sessionId: string; recoveryId: string; callerKey: string }) {
        const record = durable.get(recoveryId)
        if (!record || record.sessionId !== sessionId || (record.ownerKey && record.ownerKey !== callerKey)) throw new Error('owner mismatch')
        record.ownerKey = callerKey
      },
      async readRecovery(sessionId: string, recoveryId: string) {
        const record = durable.get(recoveryId)
        return record?.sessionId === sessionId ? structuredClone(record) : undefined
      },
      async updateRecovery({ sessionId, recoveryId, patch }: { sessionId: string; recoveryId: string; patch: { status?: RewindResult['status']; result?: RewindResult; undone?: RewindResult } }) {
        const record = durable.get(recoveryId)
        if (!record || record.sessionId !== sessionId) throw new Error('missing recovery')
        Object.assign(record, patch)
      },
    })
    const originalBackup = ports.recovery.backup
      ports.recovery.backup = async (input: Parameters<FakeRecoveryPort['backup']>[0] & { planId?: string; plan?: RewindPlan }) => {
      const recoveryId = await originalBackup(input)
      durable.set(recoveryId, {
        recoveryId, sessionId: input.sessionId, planId: input.planId!, mode: input.plan!.mode,
        status: 'recovery-required',
      })
      return recoveryId
    }
    const first = await createService(ports)
    const { plan } = await first.prepare({ sessionId: 'session-1', mode: 'conversation', target })
    const executed = await first.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    if (!executed.recoveryId) throw new Error('expected recovery id')
    await first.bindRecoveryOwner({ sessionId: 'session-1', recoveryId: executed.recoveryId, callerKey: 'desktop' })

    const restarted = await createService(ports)
    const recovered = await restarted.undo({ sessionId: 'session-1', recoveryId: executed.recoveryId }, 'desktop')
    expect(recovered.status).toBe('committed')
    expect(ports.calls).toContain('recovery:undo')
    expect(durable.get(executed.recoveryId)?.undone).toEqual(recovered)
  })

  test('after T1 and before T2 resolve to the same conversation and file boundary', async () => {
    const ports = fakePorts()
    const service = await createService(ports)
    const after = await service.prepare({ sessionId: 'session-1', mode: 'both', target: { kind: 'after-turn', turnId: 'T1' } })
    const before = await service.prepare({ sessionId: 'session-1', mode: 'both', target: { kind: 'before-turn', turnId: 'T2' } })
    expect(after.plan.conversation).toEqual(before.plan.conversation)
    expect(after.plan.files).toEqual(before.plan.files)
  })
})
