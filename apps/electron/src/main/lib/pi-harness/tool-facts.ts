import { createHash, randomUUID } from 'node:crypto'
import type { ToolFact } from './types'

export interface ToolFactInput {
  toolUseId?: string
  toolName: string
  input: Record<string, unknown>
  result: unknown
  isError?: boolean
  timestamp?: number
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function textFromResult(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((block) => (
    block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''
  )).join('\n')
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  return normalizePath(input.file_path ?? input.path)
}

function commandCategory(command: string): 'test' | 'typecheck' | 'build' | 'command' {
  if (/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:vitest|jest|mocha)\b/i.test(command)) return 'test'
  if (/\b(?:tsc|typecheck)\b/i.test(command)) return 'typecheck'
  if (/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b/i.test(command)) return 'build'
  return 'command'
}

function exitCodeFromResult(text: string): number | undefined {
  const match = text.match(/(?:exit\s*code|退出码)\s*(?:is|为|=|:)?\s*(-?\d+)/i)
  return match?.[1] ? Number(match[1]) : undefined
}

function normalizedName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '').toLowerCase()
}

/**
 * Converts a completed tool result into a bounded, redacted fact. No result
 * body, command text or secret-bearing input is persisted.
 */
export function createToolFact(context: {
  goalId: string
  turnId: string
  taskId?: string
}, input: ToolFactInput): ToolFact | undefined {
  const name = normalizedName(input.toolName)
  const timestamp = input.timestamp ?? Date.now()
  const resultText = textFromResult(input.result)
  const path = pathFromInput(input.input)
  const isError = input.isError === true
  const base = {
    id: randomUUID(),
    goalId: context.goalId,
    turnId: context.turnId,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    timestamp,
    toolName: input.toolName,
  }

  if (name === 'read' || name === 'grep' || name === 'glob' || name === 'find' || name === 'ls') {
    const kind = name === 'read' ? 'file_read' : 'observation'
    const outcome: ToolFact['outcome'] = isError ? 'failure' : path ? 'success' : 'unknown'
    return {
      ...base,
      kind,
      outcome,
      subject: { ...(path ? { path } : {}), resultHash: digest(resultText) },
      summary: `${input.toolName} ${outcome}${path ? ` ${path}` : ''}`,
      fingerprint: input.toolUseId ?? digest(`${input.toolName}|${path ?? ''}|${outcome}|${resultText}`),
    }
  }

  if (name === 'write' || name === 'edit' || name === 'multiedit') {
    const outcome: ToolFact['outcome'] = isError ? 'failure' : path ? 'success' : 'unknown'
    return {
      ...base,
      kind: 'file_mutation',
      outcome,
      subject: { ...(path ? { path } : {}), outputHash: digest(resultText) },
      summary: `${input.toolName} ${outcome}${path ? ` ${path}` : ''}`,
      fingerprint: input.toolUseId ?? digest(`${input.toolName}|${path ?? ''}|${outcome}|${resultText}`),
    }
  }

  if (name === 'bash' || name === 'powershell') {
    const command = typeof input.input.command === 'string' ? input.input.command : ''
    const exitCode = exitCodeFromResult(resultText)
    const category = commandCategory(command)
    // Pi's native Bash tool reports a successful execution structurally through
    // tool_result.is_error=false, but its human-readable text does not always
    // include an `exit code 0` marker. That protocol flag is execution evidence
    // (unlike model prose), so it may establish success for the already-finite
    // test/typecheck/build categories. Explicit non-zero output and is_error
    // remain failures; arbitrary commands remain non-verifying below.
    const outcome: ToolFact['outcome'] = isError || (exitCode !== undefined && exitCode !== 0)
      ? 'failure'
      : exitCode === 0 || (!isError && exitCode === undefined && category !== 'command')
        ? 'success'
        : 'unknown'
    return {
      ...base,
      kind: category === 'command' ? 'command' : 'verification_command',
      outcome,
      subject: {
        commandHash: digest(command),
        category,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(exitCode === undefined && !isError && category !== 'command' ? { executionEvidence: 'tool_result_success' } : {}),
        outputHash: digest(resultText),
      },
      summary: `${input.toolName} ${category} ${outcome}${exitCode !== undefined ? ` exit=${exitCode}` : ''}`,
      fingerprint: input.toolUseId ?? digest(`${input.toolName}|${command}|${exitCode ?? 'unknown'}|${resultText}`),
    }
  }

  if (name === 'taskcreate' || name === 'taskupdate' || name.includes('proma_task_')) {
    return {
      ...base,
      kind: 'task_graph',
      outcome: isError ? 'failure' : 'success',
      subject: { taskId: input.input.taskId ?? input.input.task_id ?? input.input.id ?? null, status: input.input.status ?? null },
      summary: `${input.toolName} ${isError ? 'failure' : 'success'}`,
      fingerprint: input.toolUseId ?? digest(`${input.toolName}|${JSON.stringify(input.input)}|${resultText}`),
    }
  }

  // Browser/MCP/unknown tools are retained only as opaque, non-verifying facts.
  return {
    ...base,
    kind: 'external_or_unknown',
    outcome: isError ? 'failure' : 'unknown',
    subject: { resultHash: digest(resultText) },
    summary: `${input.toolName} ${isError ? 'failure' : 'unknown'}`,
    fingerprint: input.toolUseId ?? digest(`${input.toolName}|${resultText}`),
  }
}
