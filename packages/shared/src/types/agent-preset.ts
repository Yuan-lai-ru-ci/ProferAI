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
 * 每个产品内置工具组的工具短名清单（B2-3 单工具裁剪的唯一事实来源）。
 * 短名不带 runtime 前缀（Claude 为裸名，Pi 为 mcp__server__tool 的末段），
 * 两侧注册点按短名匹配过滤，UI 与工具 schema 均从本表渲染/校验。
 */
export const AGENT_PRESET_GROUP_TOOL_NAMES: Record<AgentPresetToolGroup, readonly string[]> = {
  'task-graph': ['proma_task_create', 'proma_task_update'],
  memory: ['search_memory', 'list_team_memories', 'read_team_memory', 'search_team_memories', 'create_team_memory', 'update_team_memory'],
  collaboration: [
    'list_available_agent_models',
    'delegate_agent',
    'delegate_agents',
    'wait_for_delegations',
    'list_delegations',
    'get_delegation_results',
    'stop_delegation',
    'stop_delegations',
    'answer_delegation_question',
    'continue_delegation',
  ],
  automation: ['list_automations', 'get_automation', 'create_automation', 'update_automation', 'delete_automation', 'run_automation_now'],
}

/** 全部可裁剪单工具短名（disabledTools 校验用） */
export const AGENT_PRESET_TOOL_NAMES: readonly string[] = Object.values(AGENT_PRESET_GROUP_TOOL_NAMES).flat()

/**
 * 按 disabledTools 短名过滤工具定义（Claude/Pi 注册点共用）。
 * 短名口径：Claude 工具名为裸短名，Pi 为 mcp__server__tool，取 name 按 '__' 分割的末段。
 */
export function filterDisabledTools<T extends { name: string }>(tools: T[], disabledTools: readonly string[] | undefined): T[] {
  if (!disabledTools?.length) return tools
  const disabled = new Set(disabledTools)
  return tools.filter((tool) => !disabled.has(tool.name.split('__').at(-1) ?? tool.name))
}

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
  /** [B2-3] 禁用的单个产品内置工具（短名，见 AGENT_PRESET_GROUP_TOOL_NAMES）；与 disabledToolGroups 叠加生效，组已禁用时无需重复列 */
  disabledTools?: string[]
  /** 覆盖全局设置的推理档位；undefined 表示跟随全局设置 */
  effort?: AgentEffort
  /** 覆盖会话默认权限模式；undefined 表示跟随全局/会话默认 */
  permissionMode?: ProferPermissionMode
  /** [Phase 1] 限定启用的 Skill slugs；undefined=不裁剪（全量注入），[]=0 个 skill（全部隐藏），非空=白名单 */
  skillSlugs?: string[]
  /** [Phase 1] 限定启用的 MCP 服务器名；undefined=不裁剪，[]=不加载任何用户 MCP，非空=白名单（产品内置 MCP 不受影响） */
  mcpServerNames?: string[]
  /** [Phase 1 扩展位] 是否允许委派子 Agent；undefined 表示跟随默认策略 */
  allowSubagents?: boolean
  /**
   * [Phase B] 派生基座（仅限内置预设 ID：standard / code / minimal）。
   * 设置后本预设只存储与基座的差异，读取时按 resolveAgentPresetMerge 合并；
   * 内置预设升级会自动传导到派生预设，无需手动同步。
   */
  basePresetId?: string
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
  /** 禁用的单个产品内置工具（短名，见 AGENT_PRESET_GROUP_TOOL_NAMES） */
  disabledTools?: string[]
  effort?: AgentEffort
  permissionMode?: ProferPermissionMode
  skillSlugs?: string[]
  mcpServerNames?: string[]
  allowSubagents?: boolean
  /** 派生基座（仅限内置预设 ID）；省略=独立预设 */
  basePresetId?: string
}

/**
 * 更新预设输入（全部可选；内置预设不可更新）。
 *
 * 语义：字段省略 = 不修改；字段传 null = 清除（回退为跟随默认/不裁剪）；传值 = 设置。
 * basePresetId 传 null = 脱离基座（把当前生效配置冻结为独立预设，不再跟随内置升级）。
 */
export interface AgentPresetUpdateInput {
  name?: string
  description?: string
  promptSections?: string[] | null
  suppressPromptSections?: AgentPresetSuppressKey[] | null
  disabledToolGroups?: AgentPresetToolGroup[] | null
  disabledTools?: string[] | null
  effort?: AgentEffort | null
  permissionMode?: ProferPermissionMode | null
  skillSlugs?: string[] | null
  mcpServerNames?: string[] | null
  allowSubagents?: boolean | null
  basePresetId?: string | null
}

// ===== 预设导出 / 导入（跨机器分享文件） =====

/**
 * 预设导出文件条目：只携带能力字段，不携带 id/时间戳等本地元数据。
 * 内置预设导出后按普通条目导入（导入侧统一生成新 UUID，转为自定义预设）。
 */
export interface AgentPresetExportEntry {
  name: string
  description: string
  promptSections?: string[]
  suppressPromptSections?: AgentPresetSuppressKey[]
  disabledToolGroups?: AgentPresetToolGroup[]
  disabledTools?: string[]
  effort?: AgentEffort
  permissionMode?: ProferPermissionMode
  skillSlugs?: string[]
  mcpServerNames?: string[]
  allowSubagents?: boolean
  /** 派生基座（内置预设 ID，跨机器通用）；导入侧校验必须为内置 ID */
  basePresetId?: string
}

/** 预设导出文件信封（JSON，供跨机器分享；格式不合规时导入整体拒绝） */
export interface AgentPresetExportFile {
  format: 'profer-agent-presets'
  version: 1
  /** ISO 时间戳（仅展示用） */
  exportedAt: string
  presets: AgentPresetExportEntry[]
}

/** 导入结果：imported 为新建成功的预设；renamed 为因重名自动追加后缀的条目 */
export interface AgentPresetImportResult {
  imported: AgentPreset[]
  /** 导入时因与工作区已有预设重名而自动追加「（导入）」后缀的条目名 */
  renamedNames: string[]
}

/** 从预设提取可导出条目（内置与自定义通用，剥离本地元数据） */
export function toAgentPresetExportEntry(preset: AgentPreset): AgentPresetExportEntry {
  return {
    name: preset.name,
    description: preset.description,
    ...(preset.promptSections?.length && { promptSections: preset.promptSections }),
    ...(preset.suppressPromptSections?.length && { suppressPromptSections: preset.suppressPromptSections }),
    ...(preset.disabledToolGroups?.length && { disabledToolGroups: preset.disabledToolGroups }),
    ...(preset.disabledTools?.length && { disabledTools: preset.disabledTools }),
    ...(preset.effort && { effort: preset.effort }),
    ...(preset.permissionMode && { permissionMode: preset.permissionMode }),
    ...(preset.skillSlugs !== undefined && { skillSlugs: preset.skillSlugs }),
    ...(preset.mcpServerNames?.length && { mcpServerNames: preset.mcpServerNames }),
    ...(preset.allowSubagents !== undefined && { allowSubagents: preset.allowSubagents }),
    ...(preset.basePresetId !== undefined && { basePresetId: preset.basePresetId }),
  }
}

/**
 * 派生预设合并（纯函数）：把基座能力字段与子预设差异合并为生效配置。
 *
 * 合并语义：
 * - id/name/description/isBuiltin/时间戳等实体字段：始终取子预设（派生预设是独立实体）
 * - promptSections：基座在前 + 子预设追加（子预设只能增加提示词段）
 * - suppressPromptSections / disabledToolGroups / disabledTools：并集（子预设只能增加隐藏/禁用）
 * - effort/permissionMode/skillSlugs/mcpServerNames/allowSubagents：子预设定义则覆盖，未定义继承基座
 */
export function mergeAgentPreset(base: AgentPreset, child: AgentPreset): AgentPreset {
  const promptSections = [...(base.promptSections ?? []), ...(child.promptSections ?? [])]
  const suppressPromptSections = [...new Set([...(base.suppressPromptSections ?? []), ...(child.suppressPromptSections ?? [])])]
  const disabledToolGroups = [...new Set([...(base.disabledToolGroups ?? []), ...(child.disabledToolGroups ?? [])])]
  const disabledTools = [...new Set([...(base.disabledTools ?? []), ...(child.disabledTools ?? [])])]
  return {
    ...child,
    ...(promptSections.length > 0 && { promptSections }),
    ...(suppressPromptSections.length > 0 && { suppressPromptSections }),
    ...(disabledToolGroups.length > 0 && { disabledToolGroups }),
    ...(disabledTools.length > 0 && { disabledTools }),
    effort: child.effort ?? base.effort,
    permissionMode: child.permissionMode ?? base.permissionMode,
    skillSlugs: child.skillSlugs !== undefined ? child.skillSlugs : base.skillSlugs,
    mcpServerNames: child.mcpServerNames !== undefined ? child.mcpServerNames : base.mcpServerNames,
    allowSubagents: child.allowSubagents !== undefined ? child.allowSubagents : base.allowSubagents,
  }
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
  /** 导出预设为 JSON 文件（主进程弹出保存对话框并写盘；返回 null 表示用户取消） */
  EXPORT_PRESETS: 'agent:export-presets',
  /** 从 JSON 文件导入预设（主进程弹出打开对话框并解析；返回 null 表示用户取消） */
  IMPORT_PRESETS: 'agent:import-presets',
} as const
