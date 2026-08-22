import { selectHarnessFocus, type HarnessFocus, type TaskGraph } from '@profer/project-core'

export type GoalIntakeKind = 'manual_compact' | 'existing_graph' | 'minimal_root' | 'graphless'

export interface GoalIntakeRequest {
  userMessage: string
  graph: TaskGraph
  previousFocusTaskId?: string
  /** A caller that has already established a conflicting goal must not silently reuse it. */
  goalConflict?: boolean
}

export interface GoalIntakeDecision {
  kind: GoalIntakeKind
  focus: HarnessFocus
  reason: string
  /** A proposal only. Phase 2 must not write this task itself. */
  rootTask?: { subject: string; description: string }
}

const EXECUTION_SIGNAL = /(?:\b(?:implement|build|create|modify|fix|debug|refactor|migrate|test|deploy)\b|实现|开发|创建|新增|修改|修复|排查|重构|迁移|测试|构建|部署)/i
const MULTI_STEP_SIGNAL = /(?:\b(?:step by step|multi[- ]step|plan|workflow)\b|多步骤|分阶段|制定计划|工作流|先.+再)/i
const SIMPLE_QUESTION = /(?:[?？]|\b(?:what|why|how|explain|介绍|什么是|为什么|怎么(?:样|做)))/i

function rootSubject(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim()
  const codepoints = [...compact]
  const clipped = codepoints.slice(0, 80).join('')
  return clipped || '推进用户委托'
}

/**
 * Carries only declaration-shaped, line-local verification metadata into the
 * Host-created root. General prose remains user context only: it must never be
 * interpreted as a command, artifact, or completion contract.
 */
function rootVerificationMarkers(message: string): string[] {
  const markers: string[] = []
  for (const line of message.split(/\r?\n/)) {
    const match = line.trim().match(/^@?(verify|artifact):\s*(\S.*)$/i)
    if (!match) continue
    const kind = match[1]!.toLowerCase()
    const value = match[2]!.trim()
    if (value.length > 240) continue
    const marker = `@${kind}: ${value}`
    if (!markers.includes(marker)) markers.push(marker)
    // A minimal root accepts at most one finite contract and two artifacts.
    if (markers.length >= 3) break
  }
  return markers
}

/**
 * Determines whether an incoming user request needs a minimal visible task
 * skeleton. It intentionally fails conservative: unclear/chat-only requests
 * remain graphless until the agent itself expands the graph.
 */
export function decideGoalIntake(request: GoalIntakeRequest): GoalIntakeDecision {
  const message = request.userMessage.trim()
  const focus = selectHarnessFocus(request.graph, request.previousFocusTaskId)

  if (message === '/compact') {
    return { kind: 'manual_compact', focus, reason: '用户显式请求手动压缩；这是任务级边界' }
  }
  if (Object.keys(request.graph.nodes).length > 0 && !request.goalConflict) {
    return { kind: 'existing_graph', focus, reason: '现有任务图优先；不重复建立最小骨架' }
  }

  const shouldCreateRoot = Boolean(message)
    && EXECUTION_SIGNAL.test(message)
    && (MULTI_STEP_SIGNAL.test(message) || !SIMPLE_QUESTION.test(message))
  if (shouldCreateRoot) {
    const subject = rootSubject(message)
    return {
      kind: 'minimal_root',
      focus,
      reason: request.goalConflict ? '用户目标已分叉，建议建立新的最小骨架' : '检测到明确的持续执行委托，建议建立最小骨架',
      rootTask: {
        subject,
        description: [
          '由 Pi Host Harness 建立的最小任务骨架；Agent 应依据实际发现补充子任务、依赖与分支。',
          ...rootVerificationMarkers(message),
        ].join('\n'),
      },
    }
  }
  return { kind: 'graphless', focus, reason: '请求未满足最小骨架准入条件；仅记录 graphless Goal' }
}
