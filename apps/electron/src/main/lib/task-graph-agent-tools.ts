/**
 * 任务图结构化 MCP 工具
 *
 * 通过 SDK MCP Server 暴露 proma_task_create / proma_task_update 工具。
 * 这些工具的 schema 直接包含 dependsOn、forkFrom、abandonReason 等结构化参数，
 * 从根本上解决 AI 遗忘内联标记的问题。
 *
 * 设计要点：
 * - MCP handler 直接将结构化参数格式化为标记行写入 description，
 *   然后调用 appendGraphEvent() 写入 JSONL（持久化路径）。
 * - 返回结果格式与 SDK TaskCreate/TaskUpdate 兼容，渲染层可通过
 *   parseTaskCreateResult 识别，保证流式路径也可见。
 * - 与 SDK 原生 TaskCreate/TaskUpdate 不冲突——AI 可任选其一，
 *   也可同时使用（proma_task_create 的结构化参数会被注入到 enrichedDescription）。
 */

import { randomUUID } from 'node:crypto'
import type { GraphEvent } from '@profer/project-core'
import {
  parseDependsOn,
  parseForkFrom,
  parseAbandon,
} from '@profer/project-core'
import { appendGraphEvent } from './project-graph-service'
import { filterDisabledTools } from '@profer/shared'

// ===== 类型 =====

interface TaskGraphToolContext {
  sessionId: string
}

interface McpToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
}

// ===== 辅助函数 =====

/**
 * 将结构化参数格式化为 description 前面的标记行。
 * 如果 AI 在 description 中已经手写了同名标记，结构化参数优先。
 */
function buildEnrichedDescription(
  description: string,
  dependsOn: string[] | undefined,
  forkFrom: string | undefined,
): string {
  const lines: string[] = []

  if (dependsOn && dependsOn.length > 0) {
    const existing = parseDependsOn(description)
    const merged = [...new Set([...dependsOn, ...existing])]
    lines.push(`dependsOn: ${merged.join(', ')}`)
  }

  if (forkFrom) {
    const existing = parseForkFrom(description)
    const final = existing ?? forkFrom
    lines.push(`forkFrom: ${final}`)
  }

  if (lines.length === 0) return description
  return lines.join('\n') + '\n' + description
}

function jsonResult(payload: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

// ===== Zod Schema 构建 =====

type ZodModule = typeof import('zod')

function buildTaskGraphSchemas(z: ZodModule['z']) {
  return {
    create: {
      subject: z.string().describe('任务标题'),
      description: z.string().optional().describe('任务说明'),
      dependsOn: z.array(z.string()).optional().describe('必须先完成的任务 ID（此任务等它们完成才能开始）'),
    },
    update: {
      taskId: z.string().describe('要更新的任务 ID'),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']).optional()
        .describe('新状态'),
      dependsOn: z.array(z.string()).optional().describe('必须先完成的任务 ID（发现遗漏的依赖关系时在此补上）'),
      abandonReason: z.string().optional().describe('放弃原因'),
    },
  }
}

// ===== MCP 工具注入 =====

export async function injectTaskGraphMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: TaskGraphToolContext,
  disabledTools?: string[],
): Promise<void> {
  // Electron ASAR 环境下动态 ESM import 可能间歇性失败，回退到 CommonJS require 兜底
  let z: ZodModule['z']
  try {
    ({ z } = await import('zod') as ZodModule)
  } catch {
    z = require('zod').z
  }
  const schemas = buildTaskGraphSchemas(z)
  const now = () => Date.now()

  const tools = [
      // ===== proma_task_create =====
      sdk.tool(
        'proma_task_create',
        '创建任务。依赖用 dependsOn 数组直填。用此工具替代 TaskCreate。',
        schemas.create,
        async (args) => {
          const taskId = randomUUID()
          const subject = args.subject
          const rawDescription = args.description ?? ''
          const dependsOn = args.dependsOn ?? []

          const description = buildEnrichedDescription(rawDescription, dependsOn, undefined)

          const createdEvent: GraphEvent = {
            type: 'task_created',
            taskId,
            timestamp: now(),
            payload: {
              subject,
              description,
              dependsOn,
            },
          }
          appendGraphEvent(ctx.sessionId, createdEvent)

          // 写入 task_session_linked 事件
          const linkedEvent: GraphEvent = {
            type: 'task_session_linked',
            taskId,
            timestamp: now(),
            payload: { sessionId: ctx.sessionId },
          }
          appendGraphEvent(ctx.sessionId, linkedEvent)


          // 返回与 SDK TaskCreate 兼容的格式，让渲染层的 parseTaskCreateResult 能识别
          return jsonResult({
            task: { id: taskId, subject },
            enrichedDescription: description,
          })
        },
      ),

      // ===== proma_task_update =====
      sdk.tool(
        'proma_task_update',
        '更新任务状态/依赖/放弃。发现遗漏的依赖关系时在此补 dependsOn。用此工具替代 TaskUpdate。',
        schemas.update,
        async (args) => {
          const taskId = args.taskId
          const status = args.status
          let rawDescription = ''
          const dependsOn = args.dependsOn
          const abandonReason = args.abandonReason

          // 处理结构化参数 → 注入到 description
          if (abandonReason) {
            const existing = parseAbandon(rawDescription)
            if (!existing) {
              rawDescription = `abandon: ${abandonReason}\n` + rawDescription
            }
          }
          const description = dependsOn
            ? buildEnrichedDescription(rawDescription, dependsOn, undefined)
            : rawDescription

          const ts = now()

          // 状态变更（deleted 由原生 TaskUpdate 的 status='deleted' 处理）
          if (status) {
            appendGraphEvent(ctx.sessionId, {
              type: 'task_status_changed',
              taskId,
              timestamp: ts,
              payload: { newStatus: status },
            })
          }

          // 依赖更新。dependsOn 存在时（包括 []）代表完整替换，
          // 由 graph-state 清理被移除的边和反向 dependedBy。
          if (dependsOn !== undefined) {
            appendGraphEvent(ctx.sessionId, {
              type: 'task_updated',
              taskId,
              timestamp: ts,
              payload: {
                description: buildEnrichedDescription(rawDescription, dependsOn, undefined),
                dependsOn,
              },
            })
          }

          // 放弃标注
          if (abandonReason) {
            appendGraphEvent(ctx.sessionId, {
              type: 'task_abandon_annotated',
              taskId,
              timestamp: ts,
              payload: {
                reason: abandonReason,
                confidence: 1,
                evidenceTurns: [],
                source: 'agent',
              },
            })
          }

          return jsonResult({ taskId, updated: true })
        },
      ),
  ]

  const server = sdk.createSdkMcpServer({
    name: 'task-graph',
    version: '1.0.0',
    tools: filterDisabledTools(tools, disabledTools),
  })

  // 注册到 mcpServers（SDK 统一 MCP 通道）
  mcpServers['task-graph'] = server as unknown as Record<string, unknown>
}
