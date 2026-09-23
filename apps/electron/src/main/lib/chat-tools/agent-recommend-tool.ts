/**
 * Agent 模式推荐工具模块（Chat 模式）
 *
 * 智能识别适合 Agent 模式的任务，推荐用户切换。
 * 工具本身不执行切换，只产出推荐数据（reason + suggestedPrompt），
 * 由渲染进程的 AgentRecommendBanner 负责展示和执行迁移。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@profer/core'
import type { ChatToolMeta } from '@profer/shared'

// ===== 工具元数据 =====

export const AGENT_RECOMMEND_TOOL_META: ChatToolMeta = {
  id: 'agent-mode-recommend',
  name: 'Agent 模式推荐',
  description: '智能识别适合 Agent 模式的任务，推荐用户切换',
  params: [
    { name: 'reason', type: 'string', description: '推荐理由', required: true },
    { name: 'suggestedPrompt', type: 'string', description: '建议的 Agent 初始提示词', required: true },
  ],
  icon: 'Sparkles',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<agent_mode_recommendation>
只有任务需要当前 Chat 缺少的执行能力时，才调用 suggest_agent_mode 推荐切换；该工具只展示建议，不会自动切换或执行任务。

- 需要直接读写用户本地文件、修改项目并运行测试、执行命令，或使用当前未提供的 MCP/Skill 时，说明 Agent 可以帮助完成的具体操作；实际可用能力仍取决于用户的配置和权限。
- 已提供文本的分析、代码示例、方案比较、写作和可由当前工具完成的检索，直接在 Chat 完成。内容较长、涉及编程或步骤较多，本身不构成切换理由。
- 用户只要求解释或草稿、明确不要切换，或已经拒绝同一建议时，不再推荐。
- reason 说明当前缺少什么能力、切换能解决什么；suggestedPrompt 准确保留用户目标、上下文和限制，不扩大授权或承诺尚未核实的能力。
- 每轮最多推荐一次；推荐后继续提供当前可完成的实用内容，不用推荐替代回答。
</agent_mode_recommendation>`,
}

// ===== 工具定义（ToolDefinition 格式，传给 Provider） =====

export const AGENT_RECOMMEND_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'suggest_agent_mode',
    description: 'Recommend Agent mode only when the task requires execution capabilities unavailable in the current Chat, such as local file changes or shell commands. This only shows a suggestion; it does not switch modes or execute work. Do not recommend solely because a task involves writing, coding, research, or multiple steps, or when the user has declined switching.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Specific explanation of how Agent mode can better help the user achieve their goal',
        },
        suggestedPrompt: {
          type: 'string',
          description: 'Suggested initial prompt for the Agent session, summarizing the user\'s core task',
        },
      },
      required: ['reason', 'suggestedPrompt'],
    },
  },
]

// ===== 可用性检查 =====

/**
 * Agent 推荐工具始终可用（无需外部凭据）
 */
export function isAgentRecommendAvailable(): boolean {
  return true
}

// ===== 工具执行 =====

/** 推荐工具名称集合 */
const AGENT_RECOMMEND_TOOL_NAMES = new Set(['suggest_agent_mode'])

/**
 * 判断是否为 Agent 推荐工具调用
 */
export function isAgentRecommendToolCall(toolName: string): boolean {
  return AGENT_RECOMMEND_TOOL_NAMES.has(toolName)
}

/**
 * 执行 Agent 推荐工具调用
 *
 * 返回结构化 JSON 数据，供渲染进程解析并展示推荐横幅。
 */
export async function executeAgentRecommendTool(toolCall: ToolCall): Promise<ToolResult> {
  const reason = toolCall.arguments.reason as string | undefined
  const suggestedPrompt = toolCall.arguments.suggestedPrompt as string | undefined

  if (!reason || !suggestedPrompt) {
    return {
      toolCallId: toolCall.id,
      content: '参数缺失: reason 和 suggestedPrompt 均为必填',
      isError: true,
    }
  }

  return {
    toolCallId: toolCall.id,
    content: JSON.stringify({
      type: 'agent_recommendation',
      reason,
      suggestedPrompt,
    }),
  }
}
