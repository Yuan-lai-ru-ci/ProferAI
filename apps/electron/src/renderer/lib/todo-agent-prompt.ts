import type { Todo } from '@profer/shared'

/**
 * 构建"处理关联 Todo"的 Agent 首条消息。
 *
 * - Pi runtime：提供 `mcp__planning__get_todo` MCP 工具，提示 Agent 调用它读取数据层原始最新记录，
 *   因此首条消息不复制 Todo 详情（避免快照过期误导）。
 * - 非 Pi runtime（如 Claude）：没有该 MCP。调用方（PlanningView / 主窗口激活 handler）传入当前 Todo
 *   快照，本题内联到首条消息，Agent 凭消息里的原始详情即可工作，不依赖运行时不存在的注入通道。
 *
 * 注意：仓库当前没有实现系统级 referenced_planning 快照注入，mentionedTodoIds 也仅是接口占位、
 * 无消费方。非 Pi runtime 必须通过本函数的快照参数携带详情，不能在提示词里要求 Agent 去读
 * 一个不存在的"注入快照"。
 */
export function buildTodoAgentPrompt(todoId: string, supportsPlanningMcp: boolean, todo?: Todo): string {
  if (supportsPlanningMcp) {
    return [
      `请处理关联的 Todo（ID: ${todoId}）。`,
      '',
      `开始前必须调用 \`mcp__planning__get_todo({ id: "${todoId}" })\`，读取此 Todo 的原始最新信息（标题、说明、优先级、计划完成时间及关联上下文）。`,
      '',
      '随后检查当前项目状态，并根据任务目标推进工作；需要澄清或遇到高风险操作时先询问用户。不要把 Todo 标记为完成，除非工作确实完成或用户明确要求。',
    ].join('\n')
  }

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
    ...(todoLine.length > 0 ? ['Todo 原始详情：', ...todoLine, ''] : ['（当前未提供 Todo 详情快照，如需完整内容请结合已提供的信息确认。）', '']),
    '随后检查当前项目状态，并根据任务目标推进工作；需要澄清或遇到高风险操作时先询问用户。不要把 Todo 标记为完成，除非工作确实完成或用户明确要求。',
  ].join('\n')
}
