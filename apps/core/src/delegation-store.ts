import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecoveredDelegationState } from '@profer/agent-runtime/delegation-tools'

export interface CoreDelegationRecord extends RecoveredDelegationState {
  schemaVersion: 1
  sourceRunId?: string
  workspaceId: string
  channelId: string
  modelId: string
  triggerId: string
  presetReference?: import('@profer/shared').PresetReference
  rootSessionId: string
  error?: string
  resultSummary?: string
  resultConsumedAt?: number
  cancelRequested?: 'parent_cancel' | 'delegation_cancel'
  parentPolicy?: import('@profer/shared').EffectiveAgentPresetPolicy
  updatedAt: number
  blockedEvents: Array<import('@profer/shared').DelegationBlockedEvent & { runId: string }>
}
interface DelegationIndex { version: 1; records: CoreDelegationRecord[]; operations: Array<{ operationId: string; fingerprint: string; result: unknown }> }

/** Core私有单写者持久层；损坏/未知版本拒绝写入，不降级为空数据。 */
export class CoreDelegationStore {
  constructor(private readonly path: string) {}
  read(): DelegationIndex {
    if (!existsSync(this.path)) return { version: 1, records: [], operations: [] }
    const index = JSON.parse(readFileSync(this.path, 'utf8')) as DelegationIndex
    if (index.version !== 1 || !Array.isArray(index.records) || !Array.isArray(index.operations)) throw new Error('Core Delegation存储格式无效，拒绝覆盖')
    const ids = new Set<string>()
    for (const record of index.records) {
      if (!record || record.schemaVersion !== 1 || !record.delegationId || ids.has(record.delegationId)
        || !record.parentSessionId || !record.childSessionId || !Array.isArray(record.blockedEvents)
        || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.status)) throw new Error('Core Delegation记录无效')
      ids.add(record.delegationId)
    }
    return index
  }
  write(value: DelegationIndex): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${randomUUID()}.tmp`
    try { writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); renameSync(tmp, this.path) }
    finally { if (existsSync(tmp)) unlinkSync(tmp) }
  }
}
export type { DelegationIndex }
