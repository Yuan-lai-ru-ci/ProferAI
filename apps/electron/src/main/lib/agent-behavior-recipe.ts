/**
 * Profer 对 GPT with Taste 行为配方的宿主适配。
 *
 * 只保留行为契约，不搬入上游宿主安装器或第二套运行时；Profer 自己的
 * preset、权限、协作和任务图仍是唯一能力来源。行为原则参考
 * https://github.com/NB-Corp/gpt-with-taste/tree/079fb262b4d7932515ba4e6341fd57b6f2122f4a。
 *
 * Adapted behavioral text under the MIT License:
 * Copyright (c) 2026 GPT with Taste contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type AgentBehaviorRole = 'main' | 'sub' | 'independent'

/** 运维回滚出口，不改变预设/工具门禁；重启进程后生效。 */
export function isAgentBehaviorRecipeEnabled(): boolean {
  return process.env.PROFER_AGENT_TASTE !== '0'
}

export function resolveAgentBehaviorRole(input: {
  sourceDelegationId?: string
  parentSessionId?: string
  delegationRelation?: 'subtask' | 'independent'
}): AgentBehaviorRole {
  if (input.delegationRelation === 'independent') return 'independent'
  if (input.sourceDelegationId || input.parentSessionId) return 'sub'
  return 'main'
}

export function buildAgentBehaviorRolePrompt(role: AgentBehaviorRole): string {
  if (!isAgentBehaviorRecipeEnabled()) return ''
  const roleText = role === 'main'
    ? '你负责用户最终要达成的结果，收齐并核验影响结论的协作产物，持续推进到可交付状态。'
    : role === 'sub'
      ? '你负责父 Agent 分配给你的完整子任务；父 Agent 负责跨任务整合和最终验收。不要创建新的协作子会话，跨边界冲突交给父 Agent 判断。'
      : '你负责一个独立工作目标，不是来源会话的隐式子任务；保持独立责任边界，不替其他会话假设权限。'
  return `## 任务责任\n\n${roleText}`
}

/** 通用行为留在 core，这里只保留 Taste 的质量增量。 */
export function buildAgentBehaviorCraftPrompt(): string {
  if (!isAgentBehaviorRecipeEnabled()) return ''
  return `## 产物质量

- 保留数字、单位、版本、状态和负面要求；界面用排版、间距与色彩建立层级，按可用能力检查呈现。
- 研究保留中间量和关键假设，以区分解释的证据推进结论。`
}

/** 主/子会话新输入的行为提醒；独立会话只接收完整角色，不叠加 Steer。 */
export function buildAgentBehaviorUserSteer(role: AgentBehaviorRole): string {
  if (!isAgentBehaviorRecipeEnabled() || role === 'independent') return ''
  const text = role === 'main'
    ? '将本轮输入接回用户目的、当前目标与已定选择，继续下一步授权工作。'
    : '将本轮输入接回父任务目标和当前子任务；跨所有者或授权缺口交父 Agent。'
  return `## GPT with Taste Steer\n\n${text}`
}

/** 已完成协作结果的吸收提醒，通过 Profer 现有工具/续跑通道交付。 */
export function buildAgentBehaviorAgentSteer(role: AgentBehaviorRole = 'main'): string {
  if (!isAgentBehaviorRecipeEnabled() || role === 'independent') return ''
  if (role === 'sub') return buildAgentBehaviorUserSteer(role)
  return '## GPT with Taste Agent Steer\n\n核对这份结果与当前目标及证据，决定采纳、修复或交给实际消费者；保留最终交付责任，不转发协作转录。'
}

/** 只改本轮 provider 输入；原始用户消息与历史存储不携带提醒。 */
export function appendAgentBehaviorUserSteer(
  message: string,
  role: AgentBehaviorRole,
  mode: 'light' | 'standard',
  rawMessage = message,
): string {
  if (mode === 'light' || rawMessage.trim() === '/compact') return message
  const steer = buildAgentBehaviorUserSteer(role)
  return steer ? `${steer}\n\n${message}` : message
}
