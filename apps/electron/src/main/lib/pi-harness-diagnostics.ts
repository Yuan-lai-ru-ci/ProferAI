import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigDir } from './config-paths'
import type { PiHarnessDecision } from './pi-harness'

/** 事件 schema 版本：字段变更时递增，回放/审计工具据此兼容旧行 */
export const PI_HARNESS_DIAGNOSTIC_SCHEMA_VERSION = 2

export interface PiHarnessDiagnosticEvent {
  schemaVersion: number
  timestamp: string
  sessionId: string
  /** 可选：关联到 Agent 会话的某轮 turn；无则仅能按 sessionId 聚合 */
  turnId?: string
  /** 来源 runtime：B1-5 起 harness 同时服务 Pi 与 Claude，两侧事件写入同一审计流 */
  runtime: 'pi' | 'claude'
  action: PiHarnessDecision['action']
  reason: PiHarnessDecision['reason']
  pendingPathCount: number
  pendingPaths: string[]
  validationAttempted: boolean
}

const MAX_PATHS = 20
const MAX_PATH_LENGTH = 500
/** sessionId 写入长度上限，防异常 id 撑爆单行 */
const MAX_SESSION_ID_LENGTH = 128
/** 事件文件轮转阈值（字节）；超过后按天归档，防长期磁盘膨胀 */
const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024

/** 自上次告警以来的写入失败次数（进程内累计，供日志聚合观测） */
let diagnosticWriteFailures = 0

export function getPiHarnessDiagnosticsPath(): string {
  return join(getConfigDir(), 'diagnostics', 'pi-harness-events.jsonl')
}

export function toPiHarnessDiagnosticEvent(
  sessionId: string,
  decision: PiHarnessDecision,
  now = new Date(),
  turnId?: string,
  runtime: 'pi' | 'claude' = 'pi',
): PiHarnessDiagnosticEvent {
  // 截断后的 pendingPaths 用于展示；pendingPathCount 必须与之一致（用截断后长度），
  // 否则 >20 路径时计数与列表对不上。
  const pendingPaths = decision.pendingPaths.slice(0, MAX_PATHS).map((path) => path.slice(0, MAX_PATH_LENGTH))
  return {
    schemaVersion: PI_HARNESS_DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: now.toISOString(),
    sessionId: sessionId.slice(0, MAX_SESSION_ID_LENGTH),
    ...(turnId ? { turnId: turnId.slice(0, MAX_SESSION_ID_LENGTH) } : {}),
    runtime,
    action: decision.action,
    reason: decision.reason,
    pendingPathCount: pendingPaths.length,
    pendingPaths,
    validationAttempted: decision.validationAttempted,
  }
}

/** 事件文件超过阈值时轮转：旧文件改名 .1.jsonl（仅保留最近两代），避免无限增长 */
function rotateEventFileIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const size = statSync(filePath).size
    if (size < MAX_EVENT_FILE_BYTES) return
    const archive = `${filePath}.1`
    const oldArchive = `${filePath}.2`
    rmSync(oldArchive, { force: true })
    if (existsSync(archive)) renameSync(archive, oldArchive)
    renameSync(filePath, archive)
  } catch (error) {
    console.warn('[Pi Harness] 诊断事件轮转失败（继续追加）:', error)
  }
}

export function appendPiHarnessDiagnostic(
  sessionId: string,
  decision: PiHarnessDecision,
  filePath = getPiHarnessDiagnosticsPath(),
  turnId?: string,
  runtime: 'pi' | 'claude' = 'pi',
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    rotateEventFileIfNeeded(filePath)
    appendFileSync(filePath, `${JSON.stringify(toPiHarnessDiagnosticEvent(sessionId, decision, new Date(), turnId, runtime))}\n`, 'utf-8')
    // 失败计数在下次成功时清零（表示已恢复）
    diagnosticWriteFailures = 0
  } catch (error) {
    diagnosticWriteFailures += 1
    // 首次失败完整打日志；连续失败只打频率摘要，避免日志洪泛
    if (diagnosticWriteFailures <= 3 || diagnosticWriteFailures % 20 === 0) {
      console.warn(`[Pi Harness] 写入诊断事件失败（累计 ${diagnosticWriteFailures} 次）:`, error)
    }
  }
}

/** 当前进程内的诊断写入失败次数（测试/观测用） */
export function getDiagnosticWriteFailureCount(): number {
  return diagnosticWriteFailures
}
