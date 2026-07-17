import type { GraphEvent, TaskStatus } from '@profer/project-core'
import { parseAbandon, parseDependsOn, parseForkFrom } from '@profer/project-core'
import type { ToolActivity } from '@/atoms/agent-atoms'
import { parseTaskCreateResult } from '@/components/agent/task-progress'

export interface TaskGraphEventConversion {
  events: GraphEvent[]
  nextCurrentTaskId?: string
}

const TASK_STATUSES = new Set<TaskStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
])

function taskIdFromInput(input: Record<string, unknown>): string | undefined {
  const value = input.taskId ?? input.task_id ?? input.id
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return undefined
}

/** 从 input 中提取字符串数组（支持 dependsOn 作为结构化参数传入） */
function stringArrayFromInput(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  if (Array.isArray(value)) {
    return value.map(v => String(v)).filter(s => s.length > 0)
  }
  return []
}

/** 从 input 中提取字符串（支持 forkFrom / abandonReason 作为结构化参数传入） */
function stringFromInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

/**
 * 将结构化参数注入 description 前面（作为标记行），供下游解析器统一处理。
 * 这是 Phase D MCP 工具包装的桥接层——MCP 工具传入结构化参数，
 * 此函数将其"翻译"为标记行拼到 description 前，后续链路完全不变。
 */
function enrichDescription(description: string, input: Record<string, unknown>): string {
  const lines: string[] = []

  // 结构化 dependsOn（数组）
  const structuredDependsOn = stringArrayFromInput(input, 'dependsOn')
  if (structuredDependsOn.length > 0) {
    const alreadyInDesc = parseDependsOn(description)
    const missing = structuredDependsOn.filter(d => !alreadyInDesc.includes(d))
    if (missing.length > 0) {
      lines.push(`dependsOn: ${missing.join(', ')}`)
    }
  }

  // 结构化 forkFrom（字符串）
  const structuredForkFrom = stringFromInput(input, 'forkFrom')
  if (structuredForkFrom) {
    const alreadyInDesc = parseForkFrom(description)
    if (!alreadyInDesc) {
      lines.push(`forkFrom: ${structuredForkFrom}`)
    }
  }

  // 结构化 abandonReason（字符串）
  const structuredAbandon = stringFromInput(input, 'abandonReason')
  if (structuredAbandon) {
    const alreadyInDesc = parseAbandon(description)
    if (!alreadyInDesc) {
      lines.push(`abandon: ${structuredAbandon}`)
    }
  }

  if (lines.length === 0) return description
  return lines.join('\n') + '\n' + description
}

/**
 * 同 turn 启发式推断：当同一轮对话中连续创建多个 Task 时，
 * 如果它们没有显式依赖，则自动推断为顺序依赖（后创建的依赖先创建的）。
 * 这降低了 AI 遗忘标记时的图完整性损失。
 *
 * @param currentTaskId — 当前 Task 的 ID
 * @param prevTaskId — 同 turn 中前一个 TaskCreate 产出的 Task ID
 * @param dependsOn — 当前 Task 已解析的依赖列表
 * @returns 增强后的依赖列表
 */
function inferSequentialDependency(
  _currentTaskId: string,
  prevTaskId: string | null,
  dependsOn: string[],
): string[] {
  // 已有显式依赖 → 不推断
  if (dependsOn.length > 0) return dependsOn
  // 没有前一个任务 → 不推断
  if (!prevTaskId) return dependsOn
  // 推断为顺序依赖
  return [prevTaskId]
}

export function taskActivityToGraphEvents(
  activity: ToolActivity,
  sessionId: string,
  timestamp: number,
  /** 同 turn 中上一个 TaskCreate 产出的 Task ID（用于启发式推断） */
  prevTaskId?: string | null,
): TaskGraphEventConversion {
  if (activity.toolName === 'TaskCreate') {
    const parsedResult = parseTaskCreateResult(activity.result)
    const taskId = parsedResult?.id ?? activity.toolUseId
    const subject = typeof activity.input.subject === 'string'
      ? activity.input.subject
      : (parsedResult?.subject ?? '未命名任务')
    let description = typeof activity.input.description === 'string'
      ? activity.input.description
      : ''

    // 将结构化参数注入 description（Phase D 桥接层）
    description = enrichDescription(description, activity.input)

    // 解析依赖（优先 description 文本标记，因为 enrichDescription 已经注入了结构化参数）
    const dependsOnFromDescription = parseDependsOn(description)
    let dependsOn = dependsOnFromDescription.length > 0
      ? dependsOnFromDescription
      : parseDependsOn(subject)

    // 启发式推断：同 turn 连续创建 → 自动依赖
    if (dependsOn.length === 0 && prevTaskId) {
      dependsOn = inferSequentialDependency(taskId, prevTaskId, dependsOn)
    }

    return {
      nextCurrentTaskId: taskId,
      events: [
        {
          type: 'task_created',
          taskId,
          timestamp,
          payload: {
            subject,
            description,
            dependsOn,
          },
        },
        {
          type: 'task_session_linked',
          taskId,
          timestamp,
          payload: { sessionId },
        },
      ],
    }
  }

  if (activity.toolName !== 'TaskUpdate') return { events: [] }

  const taskId = taskIdFromInput(activity.input)
  if (!taskId) return { events: [] }

  const events: GraphEvent[] = []
  const status = activity.input.status
  if (status === 'deleted') {
    events.push({
      type: 'task_deleted',
      taskId,
      timestamp,
      payload: { source: 'agent' },
    })
  } else if (typeof status === 'string' && TASK_STATUSES.has(status as TaskStatus)) {
    events.push({
      type: 'task_status_changed',
      taskId,
      timestamp,
      payload: { newStatus: status as TaskStatus },
    })
  }

  const subject = typeof activity.input.subject === 'string'
    ? activity.input.subject
    : undefined
  let description = typeof activity.input.description === 'string'
    ? activity.input.description
    : undefined

  // 将结构化参数注入 description（Phase D 桥接层 — TaskUpdate 支持 abandonReason）
  if (description !== undefined) {
    description = enrichDescription(description, activity.input)
  }

  if (subject !== undefined || description !== undefined) {
    events.push({
      type: 'task_updated',
      taskId,
      timestamp,
      payload: {
        ...(subject !== undefined && { subject }),
        ...(description !== undefined && { description }),
      },
    })
  }

  // 解析 dependsOn：优先从 description，回退到 subject，再回退到结构化参数
  const structuredDependsOn = stringArrayFromInput(activity.input, 'dependsOn')
  const dependsOnFromDescription = description ? parseDependsOn(description) : []
  const dependsOn = dependsOnFromDescription.length > 0
    ? dependsOnFromDescription
    : (structuredDependsOn.length > 0
      ? structuredDependsOn
      : (subject ? parseDependsOn(subject) : []))

  if (status !== 'deleted') {
    for (const dep of dependsOn) {
      events.push({
        type: 'task_dependency_added',
        taskId,
        timestamp,
        payload: { dependsOn: dep },
      })
    }
  }

  // 放弃标记：优先从 description，回退到结构化参数 abandonReason
  const abandonReason = (description ? parseAbandon(description) : null)
    ?? stringFromInput(activity.input, 'abandonReason')
  if (abandonReason) {
    events.push({
      type: 'task_abandon_annotated',
      taskId,
      timestamp,
      payload: {
        reason: abandonReason,
        confidence: 1,
        evidenceTurns: [],
        source: 'agent',
      },
    })
  }

  return { events, nextCurrentTaskId: taskId }
}
