import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigDir } from './config-paths'
import type { PiHarnessDecision } from './pi-harness'

export interface PiHarnessDiagnosticEvent {
  timestamp: string
  sessionId: string
  runtime: 'pi'
  action: PiHarnessDecision['action']
  reason: PiHarnessDecision['reason']
  pendingPathCount: number
  pendingPaths: string[]
  validationAttempted: boolean
}

const MAX_PATHS = 20
const MAX_PATH_LENGTH = 500

export function getPiHarnessDiagnosticsPath(): string {
  return join(getConfigDir(), 'diagnostics', 'pi-harness-events.jsonl')
}

export function toPiHarnessDiagnosticEvent(
  sessionId: string,
  decision: PiHarnessDecision,
  now = new Date(),
): PiHarnessDiagnosticEvent {
  return {
    timestamp: now.toISOString(),
    sessionId,
    runtime: 'pi',
    action: decision.action,
    reason: decision.reason,
    pendingPathCount: decision.pendingPaths.length,
    pendingPaths: decision.pendingPaths.slice(0, MAX_PATHS).map((path) => path.slice(0, MAX_PATH_LENGTH)),
    validationAttempted: decision.validationAttempted,
  }
}

export function appendPiHarnessDiagnostic(
  sessionId: string,
  decision: PiHarnessDecision,
  filePath = getPiHarnessDiagnosticsPath(),
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(toPiHarnessDiagnosticEvent(sessionId, decision))}\n`, 'utf-8')
  } catch (error) {
    console.warn('[Pi Harness] 写入诊断事件失败:', error)
  }
}
