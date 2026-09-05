/**
 * Agent Preset 只读产品工具。
 *
 * 预设是能力门禁的控制面，必须由用户在设置页或会话工具栏修改。
 * Agent 运行时只注册 preset_list，避免模型通过工具切换到更高权限预设。
 */

import { listAgentPresets, getDefaultPresetId } from './agent-preset-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>
}

function jsonResult(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** 从会话推导所属工作区 slug；无工作区时仅返回内置预设。 */
function resolveSessionWorkspaceSlug(sessionId: string): string | undefined {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.workspaceId) return undefined
  return getAgentWorkspace(meta.workspaceId)?.slug
}

export interface AgentPresetToolContext {
  sessionId: string
}

export async function injectAgentPresetMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: AgentPresetToolContext,
): Promise<void> {
  const server = sdk.createSdkMcpServer({
    name: 'agent-presets',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'preset_list',
        '只读列出全部 Agent 预设（内置 + 自定义）。预设创建、修改、删除、设为默认和切换当前会话必须由用户在设置页或会话工具栏执行。',
        {},
        async () => {
          const workspaceSlug = resolveSessionWorkspaceSlug(ctx.sessionId)
          const presets = listAgentPresets(workspaceSlug)
          const defaultId = getDefaultPresetId(workspaceSlug)
          return jsonResult({
            defaultPresetId: defaultId,
            presets: presets.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              isBuiltin: p.isBuiltin,
              isDefault: p.id === defaultId,
              effort: p.effort ?? null,
              permissionMode: p.permissionMode ?? null,
              skillSlugs: p.skillSlugs ?? null,
              mcpServerNames: p.mcpServerNames ?? null,
              allowSubagents: p.allowSubagents ?? null,
              basePresetId: p.basePresetId ?? null,
              promptSections: p.promptSections ?? null,
              suppressPromptSections: p.suppressPromptSections ?? null,
              disabledToolGroups: p.disabledToolGroups ?? null,
              disabledTools: p.disabledTools ?? null,
            })),
          })
        },
      ),
    ],
  })

  mcpServers['agent-presets'] = server as unknown as Record<string, unknown>
}
