/**
 * Agent Preset（预设）类型定义
 *
 * 预设 = 岗位 + 工作环境：把「提示词段 + 能力集 + 推理档位 + 权限模式 + 子 Agent 策略」
 * 组合成一个可复用的命名配置，会话内随时自由切换（下一轮消息完整生效，含工具裁剪）。
 *
 * 心智模型（对齐 DeepSeek Harness，2026-08-15 调研）：
 * - 模型 = 大脑；Skill = 操作手册；Tool/插件 = 软件与权限；预设 = 岗位 + 工作环境。
 *
 * 分层：
 * - Phase 0（已落地）：内置 standard/code/minimal 三预设 + 提示词段注入 + effort/permissionMode 覆盖位 + 会话记忆。
 * - Phase 1（已落地）：Skill 子集 / MCP 子集过滤、预设复制/自定义 CRUD、设置页管理、能力裁剪（disabledToolGroups/suppressPromptSections）。
 * - Phase 2（预留扩展位）：预设共享市场（复用 Skills 市场机制）。
 */

import type { AgentEffort, ProferPermissionMode } from './agent'

/** 产品内置工具组（预设可禁用，注入时直接不注册对应工具） */
export const AGENT_PRESET_TOOL_GROUPS = ['task-graph', 'memory', 'collaboration', 'automation'] as const
export type AgentPresetToolGroup = (typeof AGENT_PRESET_TOOL_GROUPS)[number]

/** 可被 suppressPromptSections 隐藏的内置提示词段 key（运行时校验与 Zod/TypeBox schema 的唯一事实来源） */
export const AGENT_PRESET_SUPPRESS_KEYS = ['subagents', 'memory', 'task-graph', 'automation'] as const
export type AgentPresetSuppressKey = (typeof AGENT_PRESET_SUPPRESS_KEYS)[number]

/**
 * 工具组禁用 → 提示词段隐藏 key 的自动映射（三层一致）。
 * orchestrator 与设置页共用此表，避免硬编码漂移；禁止新工具组不在本表登记。
 */
export const AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP: Record<AgentPresetToolGroup, AgentPresetSuppressKey> = {
  'task-graph': 'task-graph',
  memory: 'memory',
  collaboration: 'subagents',
  automation: 'automation',
}

/** Agent 预设 */
export interface AgentPreset {
  /** 唯一标识：内置使用 'standard' | 'code' | 'minimal'，自定义使用 UUID */
  id: string
  /** 预设名称 */
  name: string
  /** 一句话描述（UI 展示） */
  description: string
  /** 是否为内置预设（不可编辑/删除） */
  isBuiltin: boolean
  /** 追加到标准系统提示词之后的预设专属提示词段 */
  promptSections?: string[]
  /** [方案 1] 隐藏与预设矛盾的内置提示词段落 key（见 AGENT_PRESET_SUPPRESS_KEYS）：'subagents' | 'memory' | 'task-graph' | 'automation'；用于极简类预设消除矛盾指令 */
  suppressPromptSections?: AgentPresetSuppressKey[]
  /** [方案 3] 禁用的产品内置工具组（注入时直接不注册）：task-graph / memory / collaboration / automation；与 suppressPromptSections 配合使提示词与工具一致 */
  disabledToolGroups?: AgentPresetToolGroup[]
  /** 覆盖全局设置的推理档位；undefined 表示跟随全局设置 */
  effort?: AgentEffort
  /** 覆盖会话默认权限模式；undefined 表示跟随全局/会话默认 */
  permissionMode?: ProferPermissionMode
  /** [Phase 1 扩展位] 限定启用的 Skill slugs；undefined 表示不裁剪 */
  skillSlugs?: string[]
  /** [Phase 1 扩展位] 限定启用的 MCP 服务器名；undefined 表示不裁剪 */
  mcpServerNames?: string[]
  /** [Phase 1 扩展位] 是否允许委派子 Agent；undefined 表示跟随默认策略 */
  allowSubagents?: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/** 预设配置（存储在每个工作区的 agent-presets.json：~/.profer/agent-workspaces/{slug}/agent-presets.json） */
export interface AgentPresetConfig {
  /** 该工作区的用户自定义预设 */
  presets: AgentPreset[]
  /** 该工作区新建会话时默认使用的预设 ID */
  defaultPresetId: string
}

/** 其他工作区的预设分组（导入用，对齐 OtherWorkspaceSkillsGroup） */
export interface OtherWorkspacePresetsGroup {
  workspaceName: string
  workspaceSlug: string
  presets: AgentPreset[]
}

// ===== 内置预设 =====

/** 内置预设 ID 常量 */
export const BUILTIN_PRESET_STANDARD = 'standard'
export const BUILTIN_PRESET_CODE = 'code'
export const BUILTIN_PRESET_MINIMAL = 'minimal'

/** 代码预设提示词段 */
const CODE_PROMPT_SECTIONS: string[] = [
  `## 代码任务模式

当前会话使用「代码」预设。执行代码相关任务时：

- 修改前先读取相关实现、现有约定和必要的工作树状态，做最小改动
- 修改后必须执行最小相关验证（typecheck / 测试 / 重新读取确认），如实报告实际结果，绝不虚构"已验证通过"
- 优先沿用仓库既有模式与工具，不引入新依赖
- 完成前自检：错误处理、边界情况、类型安全、对既有行为的回归影响`,
]

/** 极简预设提示词段 */
const MINIMAL_PROMPT_SECTIONS: string[] = [
  `## 极简模式

当前会话使用「极简」预设：任务图、长期记忆、子 Agent 委派等重型能力已为本会话精简关闭，追求最小动作与最快响应：

- 直接完成用户请求，不做冗长的过程汇报
- 只有用户明确要求时才写文件或记忆
- 用最短路径给出结果`,
]

/** 内置预设表 */
export const BUILTIN_AGENT_PRESETS: AgentPreset[] = [
  {
    id: BUILTIN_PRESET_STANDARD,
    name: '标准',
    description: '完整能力：任务图、子 Agent、记忆维护、知识沉淀，适合日常复杂任务',
    isBuiltin: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PRESET_CODE,
    name: '代码',
    description: '面向代码任务的验证闭环：最小改动、必验结果、尊重既有约定',
    isBuiltin: true,
    promptSections: CODE_PROMPT_SECTIONS,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PRESET_MINIMAL,
    name: '极简',
    description: '最小动作：不建任务图、不写记忆、不委派，适合快速问答和简单修改',
    isBuiltin: true,
    promptSections: MINIMAL_PROMPT_SECTIONS,
    suppressPromptSections: ['subagents', 'memory', 'task-graph'],
    disabledToolGroups: ['task-graph', 'memory', 'collaboration'],
    createdAt: 0,
    updatedAt: 0,
  },
]

/** 默认预设 ID */
export const DEFAULT_PRESET_ID = BUILTIN_PRESET_STANDARD

/**
 * 预设 ID 规范化：未知/缺失一律回退 standard（历史会话兼容）。
 *
 * @deprecated 只认内置 ID，自定义预设会被误回退 standard。主进程请用
 * agent-preset-manager 的 resolvePresetId / normalizeSessionPresetId（内置 → 自定义 → standard）。
 */
export function normalizePresetId(presetId: string | undefined): string {
  if (!presetId) return DEFAULT_PRESET_ID
  return BUILTIN_AGENT_PRESETS.some((p) => p.id === presetId) ? presetId : DEFAULT_PRESET_ID
}

/** 创建预设输入 */
export interface AgentPresetCreateInput {
  name: string
  description: string
  promptSections?: string[]
  /** 隐藏与预设矛盾的内置提示词段落 key（'subagents' | 'memory' | 'task-graph' | 'automation'） */
  suppressPromptSections?: AgentPresetSuppressKey[]
  /** 禁用的产品内置工具组（task-graph / memory / collaboration / automation） */
  disabledToolGroups?: AgentPresetToolGroup[]
  effort?: AgentEffort
  permissionMode?: ProferPermissionMode
  skillSlugs?: string[]
  mcpServerNames?: string[]
  allowSubagents?: boolean
}

/**
 * 更新预设输入（全部可选；内置预设不可更新）。
 *
 * 语义：字段省略 = 不修改；字段传 null = 清除（回退为跟随默认/不裁剪）；传值 = 设置。
 */
export interface AgentPresetUpdateInput {
  name?: string
  description?: string
  promptSections?: string[] | null
  suppressPromptSections?: AgentPresetSuppressKey[] | null
  disabledToolGroups?: AgentPresetToolGroup[] | null
  effort?: AgentEffort | null
  permissionMode?: ProferPermissionMode | null
  skillSlugs?: string[] | null
  mcpServerNames?: string[] | null
  allowSubagents?: boolean | null
}

/** Agent 预设 IPC 通道常量 */
export const AGENT_PRESET_IPC_CHANNELS = {
  /** 获取全部可用预设（内置 + 自定义） */
  LIST_PRESETS: 'agent:list-presets',
  /** 获取默认预设 ID */
  GET_DEFAULT_PRESET: 'agent:get-default-preset',
  /** 更新会话绑定的预设 */
  UPDATE_SESSION_PRESET: 'agent:update-session-preset',
  /** 设置默认预设（新建会话使用） */
  SET_DEFAULT_PRESET: 'agent:set-default-preset',
  /** 新建自定义预设 */
  CREATE_PRESET: 'agent:create-preset',
  /** 复制预设（内置或自定义）为新的自定义预设 */
  COPY_PRESET: 'agent:copy-preset',
  /** 更新自定义预设 */
  UPDATE_PRESET: 'agent:update-preset',
  /** 删除自定义预设 */
  DELETE_PRESET: 'agent:delete-preset',
  /** 获取其他工作区的预设列表（按工作区分组，导入用） */
  GET_OTHER_WORKSPACE_PRESETS: 'agent:get-other-workspace-presets',
  /** 从其他工作区导入预设到当前工作区 */
  IMPORT_PRESET_FROM_WORKSPACE: 'agent:import-preset-from-workspace',
} as const
