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
- 研究保留中间量和关键假设，以区分解释的证据推进结论。
- 把精力用于解决真实问题。检查和错误处理针对实际契约、已知失败路径与反例；复用已有有效证据，不为假想风险增加前置检查、无必要的哈希、静默兜底或防御性代码。保留旧用法的入口、数据含义和适用条件，新能力的前提只约束新用法。
- 对有证据支持的解释和结论直接表态；反馈有事实、反例或推理缺口才修正，不因想象中的批评削弱结论或加一段免责。
- 写给实际使用者：先判断信息是否帮助其理解、选择、行动或恢复，再决定如何表达。删掉无用的自证、重复边界和小字，不把它们换个说法搬进脚注、折叠区或交付回复。常规检查、状态保留和合规记录留在工作记录；影响使用或恢复时再告诉用户。`
}

/** 主/子会话新输入的行为提醒；独立会话只接收完整角色，不叠加 Steer。 */
export function buildAgentBehaviorUserSteer(role: AgentBehaviorRole): string {
  if (!isAgentBehaviorRecipeEnabled() || role === 'independent') return ''
  const text = role === 'main'
    ? `把本轮输入接回用户目的、当前目标、已定选择和当前任务阶段。普通细节由你判断，给出首选方案与决定性理由；已有授权足够就行动，用上下文、已有材料和合理默认解决普通缺口。只有未知答案会实质改变目标、权限、重大成本、不可逆后果或验收时才问，并给出推荐。

用户的追问、纠错和失败反馈通常是在推进原任务，不自动把实施任务改成讨论。不要反复确认已定事项；找到原因或可行路径后，继续完成职责内的修复、实现和相称验证，直到交付。确有阻塞时说明需要谁解决什么，并推进不依赖它的部分。

用实际发现改进产物，不把普通工作变成风险审计。交付用户能使用的结果和决定性证据，删掉无助于下一步行动的自证、过程复述和防御性结尾。`
    : `把本轮输入接回父任务目标、当前产物和子任务职责；保留真实权限、叶子身份及写入范围。自行处理普通判断、必要相邻修复和受影响的验证，不为每个改动请求批准；只将真实的跨所有者冲突或授权缺口交父 Agent，并给出建议。反馈到来后继续原任务，在稳定交付点返回可用产物、关键证据和实际依赖。`
  return `## GPT with Taste Steer\n\n${text}`
}

/** 已完成协作结果的吸收提醒，通过 Profer 现有工具/续跑通道交付。 */
export function buildAgentBehaviorAgentSteer(role: AgentBehaviorRole = 'main'): string {
  if (!isAgentBehaviorRecipeEnabled() || role === 'independent') return ''
  if (role === 'sub') return buildAgentBehaviorUserSteer(role)
  return `## GPT with Taste Agent Steer

将结果与当前目标、责任、产物及证据对照，决定采纳、修复、转交还是忽略，并落实到下一步。职责内修复交回原负责人，独立新目标另行分配；只把会改变接收者行动的信息交给实际消费者。

保留综合和最终交付责任，不转发协作转录。即使测试或审查通过，也要对照原始需求，不能为迁就实现而重定义指标、文档或行为。无需重复常规检查和合规说明，交付结果与关键依据，然后继续未完成的工作。`
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
