import type { Automation, AutomationNotificationTarget, AutomationRun, SDKAssistantMessage, SDKMessage } from '@profer/shared'

export interface AutomationNotificationCardPayload {
  automation: Automation
  run: AutomationRun
  summary: string
}

export function shouldNotifyAutomationTarget(target: AutomationNotificationTarget, status: AutomationRun['status']): boolean {
  if (!target.enabled || status === 'skipped') return false
  return target.trigger === 'always' || target.trigger === status
}

export function extractAssistantText(messages: readonly SDKMessage[]): string {
  return messages.flatMap(message => message.type === 'assistant'
    ? (message as SDKAssistantMessage).message.content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    : []).join('\n\n').trim()
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '未知'
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms / 60_000)} 分钟`
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n\n... [内容过长，请在 Profer 中查看完整会话]`
}

export function buildAutomationFeishuCard({ automation, run, summary }: AutomationNotificationCardPayload): Record<string, unknown> {
  const success = run.status === 'success'
  const lines = [
    `**任务**: ${automation.name}`,
    `**状态**: ${success ? '完成' : '失败'}`,
    `**耗时**: ${formatDuration(run.durationMs)}`,
    run.sessionId ? `**会话 ID**: ${run.sessionId}` : '',
    '',
    truncate(summary.trim() || (success ? 'Agent 已完成（无文本输出）' : '没有错误详情'), 12000),
  ].filter(Boolean)
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: success ? '定时任务已完成' : '定时任务失败' }, template: success ? 'green' : 'red' },
    elements: [{ tag: 'markdown', content: lines.join('\n') }],
  }
}
