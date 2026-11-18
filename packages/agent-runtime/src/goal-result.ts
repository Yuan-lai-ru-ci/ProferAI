import type { AgentGoalIterationResult } from '@profer/shared'

function normalizeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 20)
}

export function normalizeGoalToolResult(input: { status: unknown; summary: unknown; evidence: unknown }): AgentGoalIterationResult {
  const status = input.status === 'complete' || input.status === 'blocked' ? input.status : 'continue'
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const evidence = normalizeEvidence(input.evidence)
  const validStatus = input.status === 'continue' || input.status === 'complete' || input.status === 'blocked'
  if (!validStatus || summary.length === 0 || input.status === 'complete' && evidence.length === 0) {
    return { status: 'continue', summary, evidence, outcome: 'failed', error: 'Goal 报告格式无效或缺少真实证据' }
  }
  return { status, summary, evidence, outcome: 'success' }
}

export function normalizeGoalIterationResult(input: AgentGoalIterationResult): AgentGoalIterationResult {
  return normalizeGoalToolResult(input)
}
