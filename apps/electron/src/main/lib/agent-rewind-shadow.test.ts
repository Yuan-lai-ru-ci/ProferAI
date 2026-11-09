/**
 * Phase 4：会话回退里的「文件由工作区历史承担」这条分支。
 *
 * 这里刻意让 legacy 文件端口一旦被调用就抛错：如果服务在执行 shadow 计划时
 * 还去读/写文件，说明两条文件链路没切干净，测试会立刻红。
 */

import { describe, expect, test } from 'bun:test'
import type { RewindMode, RewindPlan, RewindRevision, RewindTarget } from '@profer/shared'

const initial = {
  messages: ['u1', 'a1', 'u2', 'a2'],
  nativeResume: 'a2',
  revision: { session: 4, files: 7, state: 11 } satisfies RewindRevision,
}

function makePorts(options: { shadowOk?: boolean; mode?: RewindMode } = {}) {
  const calls: string[] = []
  const journal: string[] = []
  const shadowApplied: string[][] = []
  const state = { ...initial, messages: [...initial.messages] }

  const ports = {
    session: {
      async read() { return { ...state, revision: state.revision } },
      async resolveTarget(input: { target: RewindTarget }) {
        calls.push(`conversation:resolve:${input.target.kind}`)
        return { messages: ['u1', 'a1'], nativeResume: 'a1' }
      },
      async writeConversation(_sessionId: string, value: { messages: string[]; nativeResume: string }) {
        calls.push('conversation:write')
        state.messages = [...value.messages]
        state.nativeResume = value.nativeResume
      },
    },
    resolver: {
      async resolve(input: { mode: RewindMode; target: RewindTarget }) {
        calls.push(`resolver:${input.mode}`)
        const files = [
          { itemId: 'shadow:a:src/a.ts', path: 'src/a.ts', rootId: 'main', relativePath: 'src/a.ts', action: 'restore' as const, evidence: 'tracked-write' as const },
          { itemId: 'shadow:a:src/b.ts', path: 'src/b.ts', rootId: 'main', relativePath: 'src/b.ts', action: 'delete' as const, evidence: 'tracked-write' as const },
        ]
        return {
          supported: true,
          conversation: { messages: ['u1', 'a1'], nativeResume: 'a1' },
          files,
          shadow: { turns: ['T1', 'T2'] },
        }
      },
    },
    files: {
      async read(): Promise<never> { throw new Error('shadow 计划不应走 legacy 文件读') },
      async write(): Promise<never> { throw new Error('shadow 计划不应走 legacy 文件写') },
    },
    shadow: {
      async apply(input: { sessionId: string; turns: string[] }) {
        calls.push('shadow:apply')
        shadowApplied.push(input.turns)
        if (options.shadowOk === false) {
          return { ok: false, restoredPaths: [], deletedPaths: [], keptPaths: [], error: '保护快照失败' }
        }
        return { ok: true, restoredPaths: ['src/a.ts'], deletedPaths: ['src/b.ts'], keptPaths: ['src/c.ts'] }
      },
    },
    recovery: {
      async backup() { calls.push('recovery:backup'); return 'recovery-1' },
      async journal(input: { recoveryId: string; status: string }) { journal.push(input.status) },
      async retain() { calls.push('recovery:retain') },
      async undo() { calls.push('recovery:undo') },
      async readPlan() { return undefined },
    },
    lock: { async withSessionLock<T>(_id: string, operation: () => Promise<T>): Promise<T> { return operation() } },
  }
  return { ports, calls, journal, shadowApplied, state }
}

async function createService(ports: unknown) {
  const module = await import('./agent-rewind-service') as {
    createAgentRewindService(options: { ports: unknown }): {
      prepare(input: { sessionId: string; mode: RewindMode; target: RewindTarget }): Promise<{ plan: RewindPlan }>
      execute(input: { sessionId: string; planId: string; expectedRevision: RewindRevision }): Promise<import('@profer/shared').RewindResult>
      refine(input: { sessionId: string; previousPlanId: string; excludedItemIds: string[] }): Promise<{ plan: RewindPlan }>
      undo(input: { sessionId: string; recoveryId: string; expectedRevision?: RewindRevision }): Promise<import('@profer/shared').RewindResult>
    }
  }
  return module.createAgentRewindService({ ports })
}

const target: RewindTarget = { kind: 'before-turn', turnId: 'T1' }

describe('Phase 4：文件回退交给工作区历史', () => {
  test('both 模式：计划带 shadowTurns，执行只调 shadow，不碰 legacy 文件端口', async () => {
    const { ports, calls, journal, shadowApplied, state } = makePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })

    expect(plan.shadowTurns).toEqual(['T1', 'T2'])
    expect(plan.files?.map((item) => item.action)).toEqual(['restore', 'delete'])
    expect(plan.capability.supportsFiles).toBe(true)

    const result = await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })

    expect(result.status).toBe('committed')
    expect(shadowApplied).toEqual([['T1', 'T2']])
    expect(result.files).toEqual({ restored: ['src/a.ts'], deleted: ['src/b.ts'], conflicts: ['src/c.ts'] })
    // 对话截断照旧发生，且和文件在同一个 recovery 里。
    expect(state.messages).toEqual(['u1', 'a1'])
    expect(calls).toEqual(expect.arrayContaining(['recovery:backup', 'shadow:apply', 'conversation:write']))
    expect(journal).toEqual(['applying', 'committed'])
    // 会话 ID 不变、revision 前进一格（files + 1）。
    expect(result.sessionId).toBe('session-1')
    expect(result.revision.files).toBe(initial.revision.files + 1)
  })

  test('工作区回退失败：转成 recovery-required，不谎报成功', async () => {
    const { ports, journal } = makePorts({ shadowOk: false })
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    const result = await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    expect(result.status).toBe('recovery-required')
    expect(journal).toEqual(['applying', 'recovery-required'])
  })

  test('conversation 模式不携带 shadowTurns，也不调用工作区历史', async () => {
    const { ports, calls, shadowApplied } = makePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'conversation', target })
    expect(plan.shadowTurns).toBeUndefined()
    expect(plan.files).toBeUndefined()
    await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    expect(shadowApplied).toEqual([])
    expect(calls).not.toContain('shadow:apply')
  })
})

describe('Phase 4：不给出会骗人的按钮', () => {
  test('工作区回退的能力上报里关掉撤销与按文件剔除', async () => {
    const { ports } = makePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    expect(plan.capability.supportsFiles).toBe(true)
    expect(plan.capability.supportsUndo).toBe(false)
    expect(plan.capability.supportsRefine).toBe(false)
  })

  test('按文件剔除被拒绝：工作区回退无法只跳过一个文件', async () => {
    const { ports } = makePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    await expect(
      service.refine({ sessionId: 'session-1', previousPlanId: plan.planId, excludedItemIds: ['shadow:a:src/a.ts'] }),
    ).rejects.toThrow('不支持按文件剔除')
  })

  test('撤销被拒绝：旧恢复流程会把文件留在回退后的状态', async () => {
    const { ports } = makePorts()
    const service = await createService(ports)
    const { plan } = await service.prepare({ sessionId: 'session-1', mode: 'both', target })
    const result = await service.execute({ sessionId: 'session-1', planId: plan.planId, expectedRevision: plan.revision })
    await expect(
      service.undo({ sessionId: 'session-1', recoveryId: result.recoveryId! }),
    ).rejects.toThrow('暂不支持撤销')
  })
})
