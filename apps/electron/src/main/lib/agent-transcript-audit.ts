/**
 * 启动期的「会话内核 / 原生 transcript 一致性」对账。
 *
 * 一个会话只能有一种 Agent 内核，历史与原生 transcript 也必须属于同一个内核。这个不变式
 * 现在由发送入口（`agent-orchestrator` / `createElectronAgentRuntimeQuery` / 模型写入 IPC）
 * 强制，**已经存在的**违规数据却不会因此消失——它们必须在启动时被看见，而不是静默修复。
 *
 * 因此本模块只做三件事：读、判定、记日志。它不写任何会话元数据、不删文件、不改 transcript：
 * - 修复一个「Claude 历史 + Pi 文件」的会话需要用户决策（继续用哪一侧），Agent 猜不起；
 * - 任何「自愈」都会把两套历史中的一套悄悄丢掉，之后再也无法取证。
 *
 * 判定项（都来自可验证的磁盘事实，不做内容猜测）：
 * 1. `cross-runtime-artifact`：会话内核与磁盘上的原生 transcript 属于不同内核
 *    （Pi 会话的 sdkSessionId 解析到 Claude transcript，或 Claude 会话存在同 id 的 Pi 文件）。
 * 2. `transcript-message-mismatch`：Pi 文件里参与上下文的消息条数与 Profer 历史不一致。
 *    这条 1:1（`user`/`assistant`（含 tool_result）↔ Pi 的 user/assistant/toolResult）是
 *    「Pi 文件是本会话历史的派生」这一前提，不符即说明两侧来自不同内核或不同时期。
 *
 * 成本控制：只处理有 `sdkSessionId` 的会话；单个 transcript 超过字节预算就跳过并计数；
 * 每处理一个会话让出事件循环，绝不与首屏渲染抢主线程。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { normalizeAgentRuntime, type AgentRuntime } from '@profer/shared'
import { findSdkSessionJsonl, getAgentSessionSDKMessages, listAgentSessions } from './agent-session-manager'
import { getPiTranscriptDirForSession } from './config-paths'
import { findPiSessionJsonlCached, resolvePiTranscriptPath } from './pi-session-files'

/** 单个 transcript 的读取上限：超过就不解析（宁可漏报，也不让启动扫盘失控）。 */
export const TRANSCRIPT_AUDIT_MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单次对账的会话上限；超出的会话留到下一次启动。 */
export const TRANSCRIPT_AUDIT_MAX_SESSIONS = 400
const READ_CHUNK_BYTES = 256 * 1024

export type AgentTranscriptFindingKind = 'cross-runtime-artifact' | 'transcript-message-mismatch'

export interface AgentTranscriptFinding {
  kind: AgentTranscriptFindingKind
  sessionId: string
  title: string
  agentRuntime: AgentRuntime
  /** 人类可读的原因；日志与设置页诊断都直接用它。 */
  detail: string
  proferMessages?: number
  transcriptMessages?: number
  transcriptFile?: string
}

export interface AgentTranscriptAuditSummary {
  scanned: number
  skippedOversize: number
  findings: AgentTranscriptFinding[]
  elapsedMs: number
}

const EMPTY_SUMMARY: AgentTranscriptAuditSummary = { scanned: 0, skippedOversize: 0, findings: [], elapsedMs: 0 }

type PiConversationRoles = 'user' | 'assistant' | 'toolResult'
const PI_CONVERSATION_ROLES = new Set<string>(['user', 'assistant', 'toolResult'])

/**
 * 流式统计 Pi 文件里参与上下文的消息条数。
 *
 * 只数 `type:'message'` 且 role 属于对话角色；header / model_change / thinking_level_change /
 * compaction / label 都不参与上下文。按需分块读取，避免把几百 MB 的 transcript 读进内存。
 */
export function countPiConversationMessages(file: string): { count: number; bytes: number } {
  const fd = openSync(file, 'r')
  let count = 0
  let rest = ''
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      rest += buffer.toString('utf8', 0, bytesRead)
      let newline = rest.indexOf('\n')
      while (newline >= 0) {
        const line = rest.slice(0, newline)
        rest = rest.slice(newline + 1)
        if (line.trim()) count += countPiEntry(line)
        newline = rest.indexOf('\n')
      }
    }
    if (rest.trim()) count += countPiEntry(rest)
  } finally {
    closeSync(fd)
  }
  return { count, bytes: statSync(file).size }
}

function countPiEntry(line: string): number {
  try {
    const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown } }
    if (entry.type !== 'message') return 0
    const role = entry.message?.role
    return typeof role === 'string' && PI_CONVERSATION_ROLES.has(role as PiConversationRoles) ? 1 : 0
  } catch {
    // 坏行不属于任何内核的上下文；条数统计直接跳过，不把损坏当成证据。
    return 0
  }
}

/**
 * Profer 历史里参与 Pi 上下文的对话消息条数。
 *
 * `user`（含 tool_result 行）与 `assistant` 落 Pi；`system` / `result` 不落。
 *
 * 必须排除 Profer 自己合成的**错误占位** assistant 消息（带 `_errorCode`、没有 uuid）：
 * 它们只用于界面展示错误，从未发给模型，Pi 里自然没有对应 entry。把它们算进去会让
 * 每一次失败请求都把会话误报成「条数不符」。
 */
function countProferConversationMessages(sessionId: string): number {
  return getAgentSessionSDKMessages(sessionId)
    .filter((message) => {
      const record = message as { type?: unknown; _errorCode?: unknown }
      if (record.type !== 'user' && record.type !== 'assistant') return false
      return record.type === 'user' || record._errorCode === undefined
    })
    .length
}

/**
 * 纯判定：把「磁盘上有什么」映射成一个不一致结论（或「一致」）。
 *
 * 刻意不读会话元数据、不写盘，才能被单测逐条覆盖；也保证判定顺序与优先级只有一份。
 */
export function classifyTranscriptEvidence(input: {
  runtime: AgentRuntime
  /** 是否存在 header id 匹配的 Pi transcript。 */
  piTranscript: boolean
  /** 是否存在 header id 匹配的 Claude transcript。 */
  claudeTranscript: boolean
  /** Pi transcript 的对话消息条数（`piTranscript` 为 true 时给出）。 */
  piMessageCount?: number
  /** Profer 历史的对话消息条数（`piTranscript` 为 true 时给出）。 */
  proferMessageCount?: number
}): { kind: AgentTranscriptFindingKind; detail: string } | null {
  if (input.runtime === 'pi') {
    if (!input.piTranscript) {
      // Pi 会话却只有 Claude transcript：历史与原生恢复资产分属两个内核。
      return input.claudeTranscript
        ? { kind: 'cross-runtime-artifact', detail: '会话使用 Pi 引擎，但原生恢复记录属于 Claude；两侧历史不能续写' }
        : null
    }
    const piCount = input.piMessageCount ?? 0
    const proferCount = input.proferMessageCount ?? 0
    if (piCount !== proferCount) {
      return {
        kind: 'transcript-message-mismatch',
        detail: `Pi 记录有 ${piCount} 条对话消息，Profer 历史有 ${proferCount} 条`,
      }
    }
    return null
  }
  // Claude 会话：同 id 的 Pi 记录存在即视为跨内核产物（Pi 文件必然由另一套历史写出）。
  return input.piTranscript
    ? { kind: 'cross-runtime-artifact', detail: '会话使用 Claude 引擎，但磁盘上存在同 id 的 Pi 记录；两侧历史不能续写' }
    : null
}

/**
 * 启动对账入口：只读、只记日志，返回发现的问题供设置页 / 诊断使用。
 *
 * 失败一律吞掉并记日志：诊断不能成为启动失败的原因。
 */
export async function auditAgentTranscriptConsistency(
  options: { maxSessions?: number; maxFileBytes?: number } = {},
): Promise<AgentTranscriptAuditSummary> {
  const startedAt = Date.now()
  const maxSessions = options.maxSessions ?? TRANSCRIPT_AUDIT_MAX_SESSIONS
  const maxFileBytes = options.maxFileBytes ?? TRANSCRIPT_AUDIT_MAX_FILE_BYTES
  let scanned = 0
  let skippedOversize = 0
  const findings: AgentTranscriptFinding[] = []

  try {
    const sessions = listAgentSessions(true)
      .filter((session) => typeof session.sdkSessionId === 'string' && session.sdkSessionId.length > 0)
      .slice(0, maxSessions)

    for (const session of sessions) {
      scanned += 1
      // 让出事件循环：启动阶段的对账不能把首屏卡住。
      await new Promise((resolve) => setImmediate(resolve))
      const runtime = normalizeAgentRuntime(session.agentRuntime)
      const sdkSessionId = session.sdkSessionId!
      const piRootDir = getPiTranscriptDirForSession(session.id)

      if (runtime === 'pi') {
        const piFile = resolvePiTranscriptPath(sdkSessionId, session.piSessionFile, { rootDir: piRootDir })
        if (!piFile) {
          const verdict = classifyTranscriptEvidence({
            runtime,
            piTranscript: false,
            claudeTranscript: Boolean(findSdkSessionJsonl(sdkSessionId)),
          })
          if (verdict) findings.push({ ...verdict, sessionId: session.id, title: session.title, agentRuntime: runtime })
          continue
        }
        let size = 0
        try {
          size = statSync(piFile).size
        } catch {
          continue
        }
        if (size > maxFileBytes) {
          skippedOversize += 1
          continue
        }
        let transcriptMessages = 0
        try {
          transcriptMessages = countPiConversationMessages(piFile).count
        } catch (error) {
          console.warn(`[会话对账] 读取 Pi transcript 失败（已跳过）: ${piFile}`, error)
          continue
        }
        const proferMessages = countProferConversationMessages(session.id)
        const verdict = classifyTranscriptEvidence({
          runtime,
          piTranscript: true,
          claudeTranscript: false,
          piMessageCount: transcriptMessages,
          proferMessageCount: proferMessages,
        })
        if (verdict) {
          findings.push({
            ...verdict,
            sessionId: session.id,
            title: session.title,
            agentRuntime: runtime,
            proferMessages,
            transcriptMessages,
            transcriptFile: piFile,
          })
        }
        continue
      }

      const verdict = classifyTranscriptEvidence({
        runtime,
        piTranscript: Boolean(findPiSessionJsonlCached(sdkSessionId, { rootDir: piRootDir })),
        claudeTranscript: true,
      })
      if (verdict) findings.push({ ...verdict, sessionId: session.id, title: session.title, agentRuntime: runtime })
    }
  } catch (error) {
    console.warn('[会话对账] 一致性检查未完成:', error)
  }

  if (findings.length > 0) {
    // 先报「跨内核」——这类会话的续写与回退必然错位；再按偏差大小报条数不符的那批。
    const ordered = [...findings].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'cross-runtime-artifact' ? -1 : 1
      const delta = (finding: AgentTranscriptFinding): number =>
        Math.abs((finding.transcriptMessages ?? 0) - (finding.proferMessages ?? 0))
      return delta(b) - delta(a)
    })
    console.warn(
      `[会话对账] 发现 ${findings.length} 个内核/transcript 不一致会话（不会自动修复，请用户处理）：`,
    )
    for (const finding of ordered.slice(0, 10)) {
      console.warn(
        `[会话对账] - ${finding.kind} session=${finding.sessionId} runtime=${finding.agentRuntime} ${finding.detail}`,
      )
    }
    if (ordered.length > 10) console.warn(`[会话对账] - 其余 ${ordered.length - 10} 个已省略（见审计摘要）`)
  }
  const summary: AgentTranscriptAuditSummary = {
    scanned,
    skippedOversize,
    findings,
    elapsedMs: Date.now() - startedAt,
  }
  if (scanned > 0) {
    console.log(
      `[会话对账] 完成: 扫描 ${scanned} 个会话，${findings.length} 个不一致，跳过 ${skippedOversize} 个超大文件，${summary.elapsedMs}ms`,
    )
  }
  return summary
}

/** 最近一次启动对账结果：供诊断界面读取；未跑过时为空。 */
let lastSummary: AgentTranscriptAuditSummary = EMPTY_SUMMARY

export function getLastAgentTranscriptAuditSummary(): AgentTranscriptAuditSummary {
  return lastSummary
}

/** 启动期调用：跑一次并保留结果，供诊断读取。 */
export async function runStartupAgentTranscriptAudit(): Promise<AgentTranscriptAuditSummary> {
  lastSummary = await auditAgentTranscriptConsistency()
  return lastSummary
}
