import type { AgentRuntime, Todo } from '@profer/shared'

/**
 * 构建"处理关联 Todo"的 Agent 首条消息。
 *
 * Claude/Pi 都提供规划 Todo MCP；工具名仅因 runtime 的 MCP 暴露形式不同而不同。
 * 仍保留 Todo 快照作为首条消息的降级上下文，避免工具暂时不可用时丢失用户目标。
 */
export function buildTodoAgentPrompt(todoId: string, agentRuntime: AgentRuntime, todo?: Todo): string {
  const planningGetTool = agentRuntime === 'pi' ? 'mcp__planning__get_todo' : 'get_todo'
  const todoLine = todo
    ? [
        `- 标题：${todo.title}`,
        todo.notes ? `- 说明：${todo.notes}` : null,
        `- 优先级：${todo.priority === 'high' ? '高' : todo.priority === 'low' ? '低' : '中'}`,
        todo.dueAt ? `- 计划完成时间：${new Date(todo.dueAt).toLocaleString('zh-CN', { hour12: false })}` : null,
        todo.group ? `- 分组：${todo.group.name}` : null,
        todo.tags.length > 0 ? `- 标签：${todo.tags.map((tag) => `#${tag.name}`).join('、')}` : null,
      ].filter((line): line is string => line !== null)
    : []

  return [
    `请处理关联的 Todo（ID: ${todoId}）。`,
    '',
    `开始前必须调用 \`${planningGetTool}({ id: "${todoId}" })\`，读取此 Todo 的原始最新信息（标题、说明、优先级、计划完成时间及关联上下文）。`,
    '',
    ...(todoLine.length > 0 ? ['当前 Todo 快照（仅作上下文，以上工具结果为准）：', ...todoLine, ''] : []),
    '随后检查当前项目状态，并根据任务目标推进工作；需要澄清或遇到高风险操作时先询问用户。不要把 Todo 标记为完成，除非工作确实完成或用户明确要求。',
  ].join('\n')
}
