import type { AgentRuntime } from '@profer/shared'
import type { RewindMode, RewindPlan, RewindTarget } from '@profer/shared'

export type FixtureMessageRole = 'user' | 'assistant' | 'tool' | 'status'
export type FixtureMessagePhase = 'before-turn' | 'during-turn' | 'after-turn'

export interface RewindFixtureMessage {
  uuid: string
  role: FixtureMessageRole
  turnId: string
  phase: FixtureMessagePhase
  content: string
  terminal?: boolean
}

export interface RewindFixtureFile {
  path: string
  values: { before: string; afterT1: string; afterT2: string; afterT3: string }
  evidence: 'tracked-write'
}

export interface RewindFixture {
  runtime: AgentRuntime
  messages: RewindFixtureMessage[]
  files: RewindFixtureFile[]
  failedFirstTurn: { turnId: string; hasTerminalMessage: false; hasFileEvidence: false }
}

/**
 * Claude/Pi 共用的逻辑轮次样例。文件值和 transcript 只作为测试输入，
 * 不读取或写入真实工作区；两个 runtime 必须使用同一组 turnId。
 */
export function createRewindFixture(runtime: AgentRuntime): RewindFixture {
  return {
    runtime,
    messages: [
      { uuid: 'u-t1', role: 'user', turnId: 'T1', phase: 'before-turn', content: '修改 tracked.txt 为 B' },
      { uuid: 'tool-t1', role: 'tool', turnId: 'T1', phase: 'during-turn', content: 'write tracked.txt', terminal: false },
      { uuid: 'a-t1', role: 'assistant', turnId: 'T1', phase: 'after-turn', content: '已修改为 B', terminal: true },
      { uuid: 'u-t2', role: 'user', turnId: 'T2', phase: 'before-turn', content: '修改 tracked.txt 为 C' },
      { uuid: 'tool-t2', role: 'tool', turnId: 'T2', phase: 'during-turn', content: 'write tracked.txt', terminal: false },
      { uuid: 'a-t2', role: 'assistant', turnId: 'T2', phase: 'after-turn', content: '已修改为 C', terminal: true },
      { uuid: 'u-t3', role: 'user', turnId: 'T3', phase: 'before-turn', content: '修改 tracked.txt 为 D' },
      { uuid: 'tool-t3', role: 'tool', turnId: 'T3', phase: 'during-turn', content: 'write tracked.txt', terminal: false },
      { uuid: 'a-t3', role: 'assistant', turnId: 'T3', phase: 'after-turn', content: '已修改为 D', terminal: true },
    ],
    files: [{ path: 'tracked.txt', values: { before: 'A', afterT1: 'B', afterT2: 'C', afterT3: 'D' }, evidence: 'tracked-write' }],
    failedFirstTurn: { turnId: 'T0', hasTerminalMessage: false, hasFileEvidence: false },
  }
}

export function fixtureTarget(kind: 'after-t1' | 'before-t2'): RewindTarget {
  return kind === 'after-t1'
    ? { kind: 'after-turn', turnId: 'T1' }
    : { kind: 'before-turn', turnId: 'T2' }
}

export function fixtureMessageAtTarget(fixture: RewindFixture, target: RewindTarget): RewindFixtureMessage[] {
  if (target.kind === 'session-start') return []
  if (target.kind === 'message') {
    const index = fixture.messages.findIndex(message => message.uuid === target.messageUuid)
    return index < 0 ? [] : fixture.messages.slice(0, index + 1)
  }
  const turnIndex = fixture.messages.findIndex(message => message.turnId === target.turnId && message.phase === 'after-turn')
  if (target.kind === 'after-turn') return turnIndex < 0 ? [] : fixture.messages.slice(0, turnIndex + 1)
  const beforeIndex = fixture.messages.findIndex(message => message.turnId === target.turnId && message.phase === 'before-turn')
  return beforeIndex < 0 ? [] : fixture.messages.slice(0, beforeIndex)
}

export function fixturePlan(runtime: AgentRuntime, mode: RewindMode, target: RewindTarget): RewindPlan {
  const conversation = mode === 'files' ? undefined : {
    keepThroughMessageUuid: target.kind === 'after-turn' && target.turnId === 'T1' ? 'a-t1' : undefined,
    turnId: target.kind === 'after-turn' || target.kind === 'before-turn' ? target.turnId : undefined,
    removedMessageUuids: ['u-t2', 'tool-t2', 'a-t2', 'u-t3', 'tool-t3', 'a-t3'],
    nativeResume: { kind: runtime as 'claude' | 'pi', resumeAt: 'a-t1' },
  }
  const files = mode === 'conversation' ? undefined : [{
    itemId: 'file-tracked-t2-t3',
    path: 'tracked.txt',
    action: 'restore' as const,
    currentRevision: 'sha256:D',
    targetRevision: 'sha256:B',
    evidence: 'tracked-write' as const,
    reason: '回退到 T1 完成后的文件版本',
  }]
  return {
    protocolVersion: 1,
    planId: `${runtime}-${mode}-${target.kind}-${'turnId' in target ? target.turnId : 'start'}`,
    sessionId: 'fixture-session',
    mode,
    target,
    runtime,
    createdAt: 1,
    revision: { session: 3, files: 3, state: 3 },
    turnId: target.kind === 'after-turn' || target.kind === 'before-turn' ? target.turnId : undefined,
    capability: {
      runtime,
      supportsConversation: true,
      supportsFiles: mode !== 'conversation',
      supportsBoth: mode === 'both',
      supportsUndo: true,
      supportsRefine: true,
      supportsSubmission: true,
    },
    ...(conversation ? { conversation } : {}),
    ...(files ? { files } : {}),
  }
}
