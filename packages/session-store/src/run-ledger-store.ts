import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunLedgerPort, RunLedgerSnapshot } from '@profer/agent-runtime'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 损坏日志必须阻止执行；回退为空会丢失去重事实并重复产生副作用。 */
function validateSnapshot(value: unknown): asserts value is RunLedgerSnapshot {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.runs) || !Array.isArray(value.triggers) || !Array.isArray(value.events)) {
    throw new Error('Run 日志格式或 schemaVersion 无效')
  }
  const triggers = new Set<string>()
  for (const trigger of value.triggers) {
    if (!record(trigger) || trigger.schemaVersion !== 1 || typeof trigger.id !== 'string' || !trigger.id || triggers.has(trigger.id)
      || !['user_message', 'delegation', 'automation', 'external_request', 'resume'].includes(String(trigger.kind))
      || !record(trigger.actor) || !['user', 'agent', 'automation', 'external', 'system', 'unknown'].includes(String(trigger.actor.type))
      || typeof trigger.createdAt !== 'number' || !Number.isFinite(trigger.createdAt)) {
      throw new Error('Run 日志含无效或重复 Trigger')
    }
    triggers.add(trigger.id)
  }
  const runs = new Set<string>()
  for (const run of value.runs) {
    if (!record(run) || run.schemaVersion !== 1 || typeof run.id !== 'string' || !run.id || runs.has(run.id)
      || typeof run.triggerId !== 'string' || !triggers.has(run.triggerId)
      || typeof run.executorRef !== 'string' || !run.executorRef || typeof run.runtime !== 'string' || !run.runtime
      || !['queued', 'running', 'waiting', 'completed', 'failed', 'stopped'].includes(String(run.status))
      || typeof run.createdAt !== 'number' || !Number.isFinite(run.createdAt)) {
      throw new Error('Run 日志含无效或重复 Run')
    }
    runs.add(run.id)
  }
  for (const event of value.events) {
    if (!record(event) || event.schemaVersion !== 1 || typeof event.id !== 'string' || !event.id
      || typeof event.runId !== 'string' || !runs.has(event.runId) || typeof event.type !== 'string'
      || typeof event.at !== 'number' || !Number.isFinite(event.at)) {
      throw new Error('Run 日志含无效事件')
    }
  }
}

/** Node-only 同步原子 adapter；路径由宿主注入，不解释会话或 Provider 身份。 */
export function createFileRunLedgerPort(path: string): RunLedgerPort {
  return {
    load() {
      let text: string
      try { text = readFileSync(path, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, triggers: [], runs: [], events: [] }
        throw error
      }
      const snapshot: unknown = JSON.parse(text)
      validateSnapshot(snapshot)
      return snapshot
    },
    save(snapshot) {
      validateSnapshot(snapshot)
      mkdirSync(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${randomUUID()}.tmp`
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporaryPath, 'wx', 0o600)
        writeFileSync(descriptor, `${JSON.stringify(snapshot)}\n`, 'utf8')
        fsyncSync(descriptor)
        closeSync(descriptor)
        descriptor = undefined
        renameSync(temporaryPath, path)
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      }
    },
  }
}
