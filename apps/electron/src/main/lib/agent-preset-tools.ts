/**
 * Agent Preset 产品工具组
 *
 * 把预设管理能力（CRUD + 默认 + 会话切换）包装成 SDK MCP 工具，
 * 让会话内 Agent 可以直接创建/复制/编辑/删除预设，不必引导用户去设置页操作。
 * 与 task-graph-agent-tools 同一注入模式（SDK 统一 MCP 通道）。
 */

import { randomUUID } from 'node:crypto'
import { AGENT_PRESET_SUPPRESS_KEYS } from '@profer/shared'
import {
  listAgentPresets,
  getDefaultPresetId,
  setDefaultPresetId,
  createAgentPreset,
  copyAgentPreset,
  updateAgentPreset,
  deleteAgentPreset,
  getAgentPreset,
} from './agent-preset-manager'
import { updateAgentSessionMeta, getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'

interface McpToolResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function jsonResult(payload: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

function jsonError(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  }
}

/** 从会话推导所属工作区 slug（预设为工作区级配置）；无工作区返回 undefined（仅内置预设） */
function resolveSessionWorkspaceSlug(sessionId: string): string | undefined {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.workspaceId) return undefined
  return getAgentWorkspace(meta.workspaceId)?.slug
}

export interface AgentPresetToolContext {
  sessionId: string
}

// ===== Zod Schema 构建 =====

type ZodModule = typeof import('zod')

function buildPresetSchemas(z: ZodModule['z']) {
  return {
    create: {
      name: z.string().min(1).describe('预设名称'),
      description: z.string().default('').describe('一句话描述'),
      promptSections: z.array(z.string()).optional().describe('追加到系统提示词的专属段落（空行分段）'),
      suppressPromptSections: z.array(z.enum(AGENT_PRESET_SUPPRESS_KEYS)).optional().describe('隐藏的内置提示词段 key：subagents / memory / task-graph / automation'),
      disabledToolGroups: z.array(z.enum(['task-graph', 'memory', 'collaboration', 'automation'])).optional().describe('禁用的产品内置工具组（不注入对应工具）'),
      disabledTools: z.array(z.string()).optional().describe('禁用的单个产品内置工具短名（如 proma_task_create / delegate_agent；组已禁用时无需重复列）'),
      effort: z.enum(['low', 'medium', 'high', 'max']).optional().describe('覆盖全局推理强度；省略跟随全局'),
      permissionMode: z.enum(['auto', 'bypassPermissions', 'plan']).optional().describe('覆盖会话默认权限模式；省略跟随默认'),
      skillSlugs: z.array(z.string()).optional().describe('Skill 白名单；省略=不裁剪'),
      mcpServerNames: z.array(z.string()).optional().describe('工作区 MCP 白名单；省略=不裁剪'),
      allowSubagents: z.boolean().optional().describe('是否允许委派子 Agent；省略跟随默认'),
      basePresetId: z.string().optional().describe('派生基座（内置预设 ID：standard / code / minimal）；省略=独立预设，内置升级自动跟随派生预设'),
    },
    copy: {
      fromId: z.string().describe('源预设 ID（内置或自定义）'),
      name: z.string().optional().describe('新预设名称；省略自动加「副本」后缀'),
    },
    update: {
      presetId: z.string().describe('要更新的自定义预设 ID（内置不可更新）'),
      name: z.string().optional(),
      description: z.string().optional(),
      // 可选能力字段：省略=不修改；null=清除（回退跟随默认）
      promptSections: z.array(z.string()).nullable().optional(),
      suppressPromptSections: z.array(z.enum(AGENT_PRESET_SUPPRESS_KEYS)).nullable().optional(),
      disabledToolGroups: z.array(z.enum(['task-graph', 'memory', 'collaboration', 'automation'])).nullable().optional(),
      disabledTools: z.array(z.string()).nullable().optional(),
      effort: z.enum(['low', 'medium', 'high', 'max']).nullable().optional(),
      permissionMode: z.enum(['auto', 'bypassPermissions', 'plan']).nullable().optional(),
      skillSlugs: z.array(z.string()).nullable().optional(),
      mcpServerNames: z.array(z.string()).nullable().optional(),
      allowSubagents: z.boolean().nullable().optional(),
      basePresetId: z.string().nullable().optional().describe('切换派生基座（内置预设 ID）；null=脱离基座，冻结当前生效配置为独立预设'),
    },
    idOnly: {
      presetId: z.string().describe('预设 ID'),
    },
  }
}

// ===== MCP 工具注入 =====

export async function injectAgentPresetMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: AgentPresetToolContext,
): Promise<void> {
  // Electron ASAR 环境下动态 ESM import 可能间歇性失败，回退到 CommonJS require 兜底
  let z: ZodModule['z']
  try {
    ({ z } = await import('zod') as ZodModule)
  } catch {
    z = require('zod').z
  }
  const schemas = buildPresetSchemas(z)

  const server = sdk.createSdkMcpServer({
    name: 'agent-presets',
    version: '1.0.0',
    tools: [
      // ===== preset_list =====
      sdk.tool(
        'preset_list',
        '列出全部 Agent 预设（内置 + 自定义），标注哪个是默认预设。',
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

      // ===== preset_create =====
      sdk.tool(
        'preset_create',
        '创建一个新的自定义预设。预设 = 岗位 + 工作环境：把提示词段、推理强度、权限模式、Skill/MCP 白名单、子 Agent 策略组合成命名配置。用户说「帮我建个 XX 预设」或「把这类任务固化」时使用。',
        schemas.create,
        async (args) => {
          try {
            const preset = createAgentPreset(resolveSessionWorkspaceSlug(ctx.sessionId), {
              name: args.name,
              description: args.description,
              ...(args.promptSections && { promptSections: args.promptSections }),
              ...(args.suppressPromptSections && { suppressPromptSections: args.suppressPromptSections }),
              ...(args.disabledToolGroups && { disabledToolGroups: args.disabledToolGroups }),
              ...(args.disabledTools && { disabledTools: args.disabledTools }),
              ...(args.effort && { effort: args.effort }),
              ...(args.permissionMode && { permissionMode: args.permissionMode }),
              ...(args.skillSlugs !== undefined && { skillSlugs: args.skillSlugs }),
              ...(args.mcpServerNames !== undefined && { mcpServerNames: args.mcpServerNames }),
              ...(args.allowSubagents !== undefined && { allowSubagents: args.allowSubagents }),
              ...(args.basePresetId !== undefined && { basePresetId: args.basePresetId }),
            })
            return jsonResult({
              preset,
              hint: '新预设已创建。会话内可用 preset_switch_session 随时切换；新建会话将使用默认预设（preset_set_default 可改）。',
            })
          } catch (error) {
            return jsonError(error instanceof Error ? error.message : String(error))
          }
        },
      ),

      // ===== preset_copy =====
      sdk.tool(
        'preset_copy',
        '复制一个预设（内置或自定义）为新的自定义预设，保留源配置。',
        schemas.copy,
        async (args) => {
          try {
            const preset = copyAgentPreset(resolveSessionWorkspaceSlug(ctx.sessionId), args.fromId, args.name)
            return jsonResult({
              preset,
              hint: '副本已创建（含能力裁剪字段）。会话内可用 preset_switch_session 随时切换；新建会话将使用默认预设（preset_set_default 可改）。',
            })
          } catch (error) {
            return jsonError(error instanceof Error ? error.message : String(error))
          }
        },
      ),

      // ===== preset_update =====
      sdk.tool(
        'preset_update',
        '更新自定义预设（内置预设不可更新；字段省略表示不修改，传 null 清除该字段回退跟随默认）。',
        schemas.update,
        async (args) => {
          try {
            const { presetId, ...updates } = args
            const preset = updateAgentPreset(resolveSessionWorkspaceSlug(ctx.sessionId), presetId, updates)
            return jsonResult({ preset })
          } catch (error) {
            return jsonError(error instanceof Error ? error.message : String(error))
          }
        },
      ),

      // ===== preset_delete =====
      sdk.tool(
        'preset_delete',
        '删除自定义预设（内置不可删除；被删预设若是默认则自动回退 standard）。',
        schemas.idOnly,
        async (args) => {
          try {
            const workspaceSlug = resolveSessionWorkspaceSlug(ctx.sessionId)
            deleteAgentPreset(workspaceSlug, args.presetId)
            return jsonResult({ deleted: args.presetId, defaultPresetId: getDefaultPresetId(workspaceSlug) })
          } catch (error) {
            return jsonError(error instanceof Error ? error.message : String(error))
          }
        },
      ),

      // ===== preset_set_default =====
      sdk.tool(
        'preset_set_default',
        '设置默认预设（新建会话自动使用）。',
        schemas.idOnly,
        async (args) => {
          try {
            const id = setDefaultPresetId(resolveSessionWorkspaceSlug(ctx.sessionId), args.presetId)
            return jsonResult({ defaultPresetId: id })
          } catch (error) {
            return jsonError(error instanceof Error ? error.message : String(error))
          }
        },
      ),

      // ===== preset_switch_session =====
      sdk.tool(
        'preset_switch_session',
        '切换当前会话绑定的预设（下一轮消息完整生效，含工具裁剪）。用户说「这个会话换成 XX 模式」时使用。',
        schemas.idOnly,
        async (args) => {
          try {
            // 按会话工作区校验预设存在：getAgentPreset 对未知 ID 回退 standard，id 不一致即拒绝
            const workspaceSlug = resolveSessionWorkspaceSlug(ctx.sessionId)
            const resolved = getAgentPreset(workspaceSlug, args.presetId)
            if (resolved.id !== args.presetId) {
              return jsonError(`预设不存在: ${args.presetId}`)
            }
            const session = getAgentSessionMeta(ctx.sessionId)
            if (!session) return jsonError('会话不存在')
            const updated = updateAgentSessionMeta(ctx.sessionId, { presetId: args.presetId })
            return jsonResult({ sessionId: ctx.sessionId, presetId: updated.presetId })
          } catch (error) {
            return jsonError(error instanceof Error ? error.message : String(error))
          }
        },
      ),
    ],
  })

  // 注册到 mcpServers（SDK 统一 MCP 通道）
  mcpServers['agent-presets'] = server as unknown as Record<string, unknown>
}
