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

import type { AgentEffort, ProferPermissionMode } from "./agent";
import type { AgentRuntime } from "./agent-provider";

/** 预设实体作用域；builtin-meta 由 Profer 维护且只读。 */
export type AgentPresetScope = "builtin-meta" | "user-global" | "workspace";

/** 跨工作区持久化的唯一预设引用。 */
export interface PresetReference {
  presetId: string;
  presetScope: AgentPresetScope;
  /** workspace 作用域必须提供；全局作用域不得依赖工作区 slug 解析。 */
  workspaceSlug?: string;
  /** 可选的解析/审计版本。 */
  presetVersion?: string;
}

export type PresetErrorCode =
  | "PRESET_READ_ONLY"
  | "PRESET_SCOPE_MISMATCH"
  | "PRESET_WORKSPACE_REQUIRED"
  | "PRESET_NOT_FOUND"
  | "PRESET_UNKNOWN_REFERENCE"
  | "PRESET_DELETE_BLOCKED"
  | "PRESET_WRITE_FAILED"
  | "PRESET_INVALID_BASE"
  | "PRESET_CONCURRENT_UPDATE";

export type AgentPresetMigrationStatus = 'builtin-corrupt' | 'invalid-base';

export interface AgentPresetMigrationDiagnostic {
  presetId?: string;
  status: string;
  reason: string;
}

export interface PresetWorkspaceReference {
  workspaceSlug: string;
  workspaceName: string;
  status: "active" | "inactive" | "unknown";
  reason: "workspace-default" | "session" | "automation" | "other";
  objectIds: string[];
  objectCount: number;
  alternativePresetReferences?: PresetReference[];
  actions: Array<"rebind" | "disable" | "inspect">;
}

export interface PresetReferenceReport {
  preset: PresetReference;
  blockers: PresetWorkspaceReference[];
  /** 当前全局预设实际生效的工作区；即使没有默认/会话/自动任务引用也必须返回。 */
  workspaceScopes: Array<{ workspaceSlug: string; workspaceName: string }>;
  totalCount: number;
  canDelete: boolean;
}

/** 在一个工作区内改绑全部持久引用并解除全局预设作用域的结果。 */
export interface PresetScopeRebindResult {
  workspaceSlug: string;
  source: PresetReference;
  replacement?: PresetReference;
  reboundDefaults: number;
  reboundSessions: number;
  reboundAutomations: number;
  scopeDisabled: true;
}

/** Manager/API 返回的结构化预设错误。 */
export class AgentPresetError extends Error {
  readonly code: PresetErrorCode;
  readonly details?: unknown;

  constructor(code: PresetErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AgentPresetError";
    this.code = code;
    this.details = details;
  }
}

/** 可被 suppressPromptSections 隐藏的内置提示词段 key。 */
export const AGENT_PRESET_SUPPRESS_KEYS = [
  "subagents",
  "memory",
  "task-graph",
  "automation",
] as const;
export type AgentPresetSuppressKey =
  (typeof AGENT_PRESET_SUPPRESS_KEYS)[number];

export type AgentPresetCapabilityRisk = 'read' | 'write' | 'external' | 'destructive';

/** 单个产品工具的可发现性和风险元数据。名称使用 Claude/Pi 共用的逻辑短名。 */
export interface AgentPresetCapabilityTool {
  name: string;
  label: string;
  hint: string;
  risk: AgentPresetCapabilityRisk;
  runtimes: readonly AgentRuntime[];
}

export interface AgentPresetCapabilityGroup<Id extends string = string> {
  id: Id;
  label: string;
  hint: string;
  /** 该组的完整工具元数据；toolNames 由此派生，禁止另行维护。 */
  tools: readonly AgentPresetCapabilityTool[];
  /** 兼容已有调用方的工具短名索引。 */
  toolNames: readonly string[];
  /** 组禁用时需要自动隐藏的内置提示词段。 */
  suppressPromptSection?: AgentPresetSuppressKey;
}

const ALL_AGENT_RUNTIMES: readonly AgentRuntime[] = ['claude', 'pi'];

function capabilityTool(
  name: string,
  label: string,
  hint: string,
  risk: AgentPresetCapabilityRisk = 'read',
  runtimes: readonly AgentRuntime[] = ALL_AGENT_RUNTIMES,
): AgentPresetCapabilityTool {
  return { name, label, hint, risk, runtimes };
}

function capabilityGroup<const Id extends string>(input: {
  id: Id;
  label: string;
  hint: string;
  tools: readonly AgentPresetCapabilityTool[];
  suppressPromptSection?: AgentPresetSuppressKey;
}): AgentPresetCapabilityGroup<Id> {
  return {
    ...input,
    toolNames: input.tools.map((tool) => tool.name),
  };
}

/**
 * 统一能力注册表：工具级元数据只维护在 shared，业务实现仍留在各自 Runtime 模块。
 * UI、schema、Claude/Pi 注入和单工具裁剪都从这里派生，避免多份清单漂移。
 */
export const AGENT_PRESET_CAPABILITY_GROUPS = [
  capabilityGroup({
    id: 'task-graph', label: '任务图', hint: '子任务图工具', suppressPromptSection: 'task-graph',
    tools: [
      capabilityTool('proma_task_create', '创建任务', '创建结构化任务图节点', 'write'),
      capabilityTool('proma_task_update', '更新任务', '更新任务状态或依赖', 'write'),
    ],
  }),
  capabilityGroup({
    id: 'memory', label: '长期记忆', hint: 'Auto Memory 与 memory-archive', suppressPromptSection: 'memory',
    tools: [
      capabilityTool('search_memory', '搜索个人记忆', '检索工作区长期记忆索引'),
      capabilityTool('list_team_memories', '列出团队记忆', '列出当前团队共享记忆'),
      capabilityTool('read_team_memory', '读取团队记忆', '读取一条团队共享记忆'),
      capabilityTool('search_team_memories', '搜索团队记忆', '检索团队共享记忆'),
      capabilityTool('create_team_memory', '创建团队记忆', '写入一条团队共享记忆', 'write'),
      capabilityTool('update_team_memory', '更新团队记忆', '修改一条团队共享记忆', 'write'),
    ],
  }),
  capabilityGroup({
    id: 'collaboration', label: '协作子 Agent', hint: '委派与协作工具（等价禁止委派）', suppressPromptSection: 'subagents',
    tools: [
      capabilityTool('list_available_agent_models', '列出协作模型', '查看当前可用协作模型'),
      capabilityTool('delegate_agent', '委派子 Agent', '创建一个协作子 Agent', 'write'),
      capabilityTool('delegate_agents', '批量委派子 Agent', '批量创建协作子 Agent', 'write'),
      capabilityTool('wait_for_delegations', '等待协作结果', '等待一个或多个子 Agent 完成', 'write'),
      capabilityTool('list_delegations', '列出协作会话', '查看当前协作子 Agent'),
      capabilityTool('get_delegation_results', '读取协作结果', '读取已完成协作结果'),
      capabilityTool('stop_delegation', '停止协作会话', '停止一个协作子 Agent', 'destructive'),
      capabilityTool('stop_delegations', '批量停止协作会话', '停止多个协作子 Agent', 'destructive'),
      capabilityTool('answer_delegation_question', '回答协作问题', '代答子 Agent 的阻塞问题', 'write'),
      capabilityTool('continue_delegation', '继续协作会话', '向已结束子 Agent 追加指令', 'write'),
    ],
  }),
  capabilityGroup({
    id: 'automation', label: '自动化与规划', hint: '定时任务、规划 Todo 与本地日程工具', suppressPromptSection: 'automation',
    tools: [
      capabilityTool('list_automations', '列出定时任务', '查看启用或暂停的定时任务'),
      capabilityTool('get_automation', '读取定时任务', '读取任务详情与运行历史'),
      capabilityTool('create_automation', '创建定时任务', '创建持久化无人值守任务', 'external'),
      capabilityTool('update_automation', '修改定时任务', '修改任务提示词或调度', 'external'),
      capabilityTool('delete_automation', '删除定时任务', '删除持久化定时任务', 'destructive'),
      capabilityTool('run_automation_now', '立即运行定时任务', '立即触发一次定时任务', 'external'),
      capabilityTool('list_todos', '列出待办', '查看规划中心待办'),
      capabilityTool('get_todo', '读取待办', '读取待办最新记录'),
      capabilityTool('create_todo', '创建待办', '在规划中心创建待办', 'write'),
      capabilityTool('update_todo', '更新待办', '更新规划中心待办', 'write'),
      capabilityTool('list_calendar_events', '列出日程', '查看本地规划中心日程'),
      capabilityTool('get_calendar_event', '读取日程', '读取日程最新记录'),
      capabilityTool('create_calendar_event', '创建日程', '在规划中心创建本地日程', 'write'),
      capabilityTool('update_calendar_event', '更新日程', '更新本地规划中心日程', 'write'),
      capabilityTool('delete_calendar_event', '删除日程', '删除本地规划中心日程', 'destructive'),
    ],
  }),
  capabilityGroup({
    id: 'browser', label: '受管浏览器', hint: '网页访问、交互与标签页工具',
    tools: [
      capabilityTool('BrowserObserve', '观察页面', '读取当前页面结构'),
      capabilityTool('BrowserNavigate', '打开网页', '导航到公网或本地开发网页', 'external'),
      capabilityTool('BrowserGoBack', '后退', '返回当前页面的上一条导航记录', 'external'),
      capabilityTool('BrowserGoForward', '前进', '前进到当前页面的下一条导航记录', 'external'),
      capabilityTool('BrowserReload', '刷新页面', '重新加载当前页面', 'external'),
      capabilityTool('BrowserScroll', '滚动页面', '滚动当前网页或指定容器', 'external'),
      capabilityTool('BrowserExtract', '提取页面内容', '结构化读取页面文本、链接或表格'),
      capabilityTool('BrowserWaitFor', '等待页面', '等待页面条件出现', 'external'),
      capabilityTool('BrowserClick', '点击页面', '点击页面控件', 'external'),
      capabilityTool('BrowserFill', '填写页面', '填写输入框或编辑器', 'external'),
      capabilityTool('BrowserDomAction', '操作页面元素', '通过固定选择器操作页面', 'external'),
      capabilityTool('BrowserExecuteJavaScript', '执行页面脚本', '在当前页面执行用户目标所需脚本', 'external'),
      capabilityTool('BrowserPress', '发送按键', '向当前页面发送按键', 'external'),
      capabilityTool('BrowserScreenshot', '截取页面', '截取当前浏览器页面', 'external'),
      capabilityTool('BrowserPreviewOpen', '预览本地网页', '打开授权目录中的 HTML 预览', 'read'),
      capabilityTool('BrowserListTabs', '列出标签页', '查看当前浏览器标签页'),
      capabilityTool('BrowserNewTab', '新建标签页', '新建浏览器标签页', 'external'),
      capabilityTool('BrowserSelectTab', '切换标签页', '切换当前工作标签页', 'external'),
      capabilityTool('BrowserCloseTab', '关闭标签页', '关闭浏览器标签页', 'destructive'),
    ],
  }),
  capabilityGroup({
    id: 'clipboard', label: '系统剪贴板', hint: '读取和写入系统剪贴板文本',
    tools: [
      capabilityTool('clipboard_read_text', '读取剪贴板', '读取系统剪贴板文本'),
      capabilityTool('clipboard_write_text', '写入剪贴板', '写入系统剪贴板文本', 'write'),
    ],
  }),
  capabilityGroup({
    id: 'preview', label: '文件预览', hint: '通用文件预览与 PPTX 正式预览检查',
    tools: [
      capabilityTool('inspect_preview', '检查文件预览', '读取授权文件的内容或视觉预览'),
      capabilityTool('open_file_preview', '打开正式预览', '在用户可见 viewer 中打开文件', 'external'),
      capabilityTool('inspect_file_preview', '检查页级预览', '读取用户可见 viewer 的页级结果'),
      capabilityTool('present_visualization', '会话内可视化', '保存并在会话内呈现交互式可视结果', 'write'),
      capabilityTool('inspect_visualization', '读取可视化', '读取当前会话的可视化修订与对象'),
    ],
  }),
  capabilityGroup({
    id: 'image', label: '图片', hint: '图片生成、编辑与本地图片输出',
    tools: [
      capabilityTool('generate_image', '生成图片', '生成或编辑图片', 'external'),
      capabilityTool('send_local_image', '输出本地图片', '把授权目录中的图片发送到当前回复', 'external'),
      capabilityTool('create_skin', '创建 Profer 皮肤', '创建并安装用户皮肤包', 'write'),
    ],
  }),
  capabilityGroup({
    id: 'web', label: '网页搜索', hint: 'WebSearch 与 WebFetch',
    tools: [
      capabilityTool('WebSearch', '搜索网页', '搜索当前网页信息', 'external'),
      capabilityTool('WebFetch', '读取网页', '抓取公开网页内容', 'external'),
    ],
  }),
  capabilityGroup({
    id: 'ppt-materials', label: 'PPT 交付', hint: '视觉计划与交付审计',
    tools: [
      capabilityTool('plan_ppt_visuals', '规划 PPT 视觉', '为 PPT 生成视觉规划', 'write'),
      capabilityTool('audit_ppt_delivery', '审计 PPT 交付', '检查 PPT 交付结果'),
    ],
  }),
] as const satisfies readonly AgentPresetCapabilityGroup[];

export type AgentPresetToolGroup =
  (typeof AGENT_PRESET_CAPABILITY_GROUPS)[number]["id"];

/** 能力组 ID 序列由注册表派生，供 zod schema 等需要 tuple 的调用方使用。 */
export const AGENT_PRESET_TOOL_GROUPS = AGENT_PRESET_CAPABILITY_GROUPS.map(
  (group) => group.id,
) as [AgentPresetToolGroup, ...AgentPresetToolGroup[]];

/** 兼容已有按组索引的调用方；内容由统一注册表派生。 */
export const AGENT_PRESET_GROUP_TOOL_NAMES = Object.fromEntries(
  AGENT_PRESET_CAPABILITY_GROUPS.map((group) => [group.id, group.toolNames]),
) as unknown as Record<AgentPresetToolGroup, readonly string[]>;

/** 全部可裁剪单工具短名（disabledTools 校验用） */
export const AGENT_PRESET_TOOL_NAMES: readonly string[] =
  AGENT_PRESET_CAPABILITY_GROUPS.flatMap((group) => [...group.toolNames]);

/** 从统一 registry 查询单个逻辑工具的元数据。 */
export function getAgentPresetCapabilityTool(
  toolName: string,
): AgentPresetCapabilityTool | undefined {
  const shortName = toolName.split('__').at(-1) ?? toolName;
  for (const group of AGENT_PRESET_CAPABILITY_GROUPS) {
    const tool = group.tools.find((candidate) => candidate.name === shortName);
    if (tool) return tool;
  }
  return undefined;
}

/** 返回某个 runtime 实际声明支持的工具元数据；调用方仍需执行会话级门禁。 */
export function getAgentPresetCapabilityTools(
  runtime?: AgentRuntime,
): readonly AgentPresetCapabilityTool[] {
  const tools = AGENT_PRESET_CAPABILITY_GROUPS.flatMap((group) => [...group.tools]);
  return runtime === undefined
    ? tools
    : tools.filter((tool) => tool.runtimes.includes(runtime));
}

/** 按 disabledTools 短名过滤工具定义（Claude/Pi 注册点共用）。 */
export function filterDisabledTools<T extends { name: string }>(
  tools: T[],
  disabledTools: readonly string[] | undefined,
): T[] {
  if (!disabledTools?.length) return tools;
  const disabled = new Set(disabledTools);
  return tools.filter(
    (tool) => !disabled.has(tool.name.split("__").at(-1) ?? tool.name),
  );
}

/** 统一判断能力组是否被预设硬禁用。 */
export function isAgentPresetToolGroupDisabled(
  disabledToolGroups: readonly string[] | undefined,
  group: AgentPresetToolGroup,
): boolean {
  return disabledToolGroups?.includes(group) === true;
}

/** 工具组禁用 → 提示词段隐藏 key 的自动映射（三层一致）。 */
const capabilitySuppressMap: Partial<
  Record<AgentPresetToolGroup, AgentPresetSuppressKey>
> = {};
for (const group of AGENT_PRESET_CAPABILITY_GROUPS) {
  if ("suppressPromptSection" in group) {
    capabilitySuppressMap[group.id] = group.suppressPromptSection;
  }
}
export const AGENT_PRESET_TOOL_GROUP_SUPPRESS_MAP = capabilitySuppressMap;

/** Agent 预设 */
export interface AgentPreset {
  /** 唯一标识：内置使用 'standard' | 'code' | 'minimal'，自定义使用 UUID */
  id: string;
  /** 作用域；旧配置读取时由 Manager 补齐为 workspace。 */
  scope?: AgentPresetScope;
  /** 实体版本；内置版本随 Profer 发布更新。 */
  version?: string;
  /** workspace 预设所属工作区。 */
  workspaceSlug?: string;
  /** 从全局/其他预设复制而来的来源审计信息。 */
  sourcePresetId?: string;
  sourcePresetScope?: AgentPresetScope;
  sourceVersion?: string;
  copiedAt?: number;
  /** 预设名称 */
  name: string;
  /** 一句话描述（UI 展示） */
  description: string;
  /** 是否为内置预设（不可编辑/删除） */
  isBuiltin: boolean;
  /** 工作区页面使用：该预设当前是否在目标工作区生效。 */
  enabledInWorkspace?: boolean;
  /** 追加到标准系统提示词之后的预设专属提示词段 */
  promptSections?: string[];
  /** [方案 1] 隐藏与预设矛盾的内置提示词段落 key（见 AGENT_PRESET_SUPPRESS_KEYS）：'subagents' | 'memory' | 'task-graph' | 'automation'；用于极简类预设消除矛盾指令 */
  suppressPromptSections?: AgentPresetSuppressKey[];
  /** [方案 3] 禁用的产品内置工具组（注入时直接不注册）：task-graph / memory / collaboration / automation；与 suppressPromptSections 配合使提示词与工具一致 */
  disabledToolGroups?: AgentPresetToolGroup[];
  /** [B2-3] 禁用的单个产品内置工具（短名，见 AGENT_PRESET_GROUP_TOOL_NAMES）；与 disabledToolGroups 叠加生效，组已禁用时无需重复列 */
  disabledTools?: string[];
  /** 覆盖全局设置的推理档位；undefined 表示跟随全局设置 */
  effort?: AgentEffort;
  /** 覆盖会话默认权限模式；undefined 表示跟随全局/会话默认 */
  permissionMode?: ProferPermissionMode;
  /** [Phase 1] 限定启用的 Skill slugs；undefined=不裁剪（全量注入），[]=0 个 skill（全部隐藏），非空=白名单 */
  skillSlugs?: string[];
  /** [Phase 1] 限定启用的 MCP 服务器名；undefined=不裁剪，[]=不加载任何用户 MCP，非空=白名单（产品内置 MCP 不受影响） */
  mcpServerNames?: string[];
  /** [Phase 1 扩展位] 是否允许委派子 Agent；undefined 表示跟随默认策略 */
  allowSubagents?: boolean;
  /**
   * [Phase B] 派生基座（仅限内置预设 ID：standard / code / minimal）。
   * 设置后本预设只存储与基座的差异，读取时按 resolveAgentPresetMerge 合并；
   * 内置预设升级会自动传导到派生预设，无需手动同步。
   */
  basePresetId?: string;
  /** 稳定的跨作用域基座引用；basePresetId 仅保留旧版内置基座兼容。 */
  basePresetReference?: PresetReference;
  /** 旧配置迁移诊断；invalid-base 预设不可在 runtime 中解析。 */
  migrationStatus?: AgentPresetMigrationStatus;
  migrationReason?: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/** 预设配置（存储在每个工作区的 agent-presets.json：~/.profer/agent-workspaces/{slug}/agent-presets.json） */
export interface AgentPresetConfig {
  /** 该作用域的用户自定义预设 */
  presets: AgentPreset[];
  /** 兼容旧版本的默认预设 ID；新代码优先使用 reference。 */
  defaultPresetId: string;
  /** workspace 默认预设的显式引用。 */
  defaultPresetReference?: PresetReference;
  /** 用户明确取消默认预设；缺失时按旧版本兼容规则使用 standard。 */
  defaultPresetExplicitlyCleared?: boolean;
  /** 当前工作区显式解除生效的用户全局预设 ID。 */
  disabledGlobalPresetIds?: string[];
  /** 当前工作区显式关闭的工作区预设 ID。 */
  disabledWorkspacePresetIds?: string[];
  /** 工作区旧预设迁移的持久诊断，供后续人工修复与审计。 */
  migrationDiagnostics?: AgentPresetMigrationDiagnostic[];
}

/** 全局用户预设配置文件。 */
export interface GlobalAgentPresetConfig {
  version: 1;
  presets: AgentPreset[];
  /** 用户全局预设的工作区生效范围；未列出的预设不自动投影到工作区。 */
  workspaceScopes?: Record<string, string[]>;
}

/** 其他工作区的预设分组（导入用，对齐 OtherWorkspaceSkillsGroup） */
export interface OtherWorkspacePresetsGroup {
  workspaceName: string;
  workspaceSlug: string;
  presets: AgentPreset[];
}

// ===== 内置预设 =====

/** 内置预设 ID 常量 */
export const BUILTIN_PRESET_STANDARD = "standard";
export const BUILTIN_PRESET_CODE = "code";
export const BUILTIN_PRESET_MINIMAL = "minimal";

/** 代码预设提示词段 */
const CODE_PROMPT_SECTIONS: string[] = [
  `## 代码任务模式

当前会话使用「代码」预设。执行代码相关任务时：

- 修改前先读取相关实现、现有约定和必要的工作树状态，做最小改动；保留与当前任务无关的既有未提交修改
- 先明确 Renderer/UI、Electron main/preload/IPC、共享类型、运行时与测试的责任边界；跨边界修改必须检查调用方和契约
- 修改后按改动层级执行相称验证（单测 / typecheck / build / 最小运行流程），如实区分实际验证范围，绝不虚构"已验证通过"
- 优先沿用仓库既有模式与工具，不引入新依赖；复杂任务先拆清边界和依赖，避免把无关重构混入当前改动
- 完成前自检：错误处理、边界情况、类型安全、对既有行为的回归影响；无法完成的验证必须说明原因和风险
- 自动化、受管浏览器、剪贴板与 PPT 交付等非研发产品能力已关闭；网页搜索/抓取与本地图片呈现保留给研发检索和交付，AI 生图仍关闭
- 详细的编码审查与安全规范由 code-honor 等 Skill 提供，本预设只定义严格工程任务的稳定工作姿态`
];

/** 极简预设提示词段 */
const MINIMAL_PROMPT_SECTIONS: string[] = [
  `## 极简模式

当前会话使用「极简」预设：全部产品能力组已为本会话关闭，只保留基础文件、命令与必要交互工具，追求本地任务的低干扰快速完成：

- 直接完成用户请求，不做冗长的过程汇报
- 记忆只在用户明确要求，或确认具有长期复用价值时写入；文件仍按用户任务需要正常创建或修改，并遵守权限与验证规则
- 用最短的可验证路径给出结果`,
];

/** 内置预设表 */
export const BUILTIN_AGENT_PRESETS: AgentPreset[] = [
  {
    id: BUILTIN_PRESET_STANDARD,
    name: "标准",
    description:
      "默认工作模式：保留当前运行时可用的完整能力，适合复杂研发、调研、文档和跨模块任务",
    isBuiltin: true,
    scope: "builtin-meta",
    version: "1.1.0",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PRESET_CODE,
    name: "代码",
    description: "严格研发模式：保留工程协作、文件预览、网页检索与图片呈现，关闭自动化等非研发能力",
    isBuiltin: true,
    scope: "builtin-meta",
    version: "1.4.0",
    effort: "high",
    promptSections: CODE_PROMPT_SECTIONS,
    disabledToolGroups: ["automation", "browser", "clipboard", "ppt-materials"],
    // create_skin 虽属 image 能力组，但是独立工具：代码预设已在提示词里声明“AI 生图仍关闭”，
    // 若只禁 generate_image，create_skin 及其 SOP 会残留在代码会话，还会引导模型去调用被禁的生图工具。
    disabledTools: ["generate_image", "create_skin"],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: BUILTIN_PRESET_MINIMAL,
    name: "极简",
    description:
      "本地快速完成模式：关闭全部产品能力组，只保留基础文件、命令与必要交互工具",
    isBuiltin: true,
    scope: "builtin-meta",
    version: "1.2.0",
    promptSections: MINIMAL_PROMPT_SECTIONS,
    suppressPromptSections: ["subagents", "memory", "task-graph", "automation"],
    disabledToolGroups: [...AGENT_PRESET_TOOL_GROUPS],
    createdAt: 0,
    updatedAt: 0,
  },
];

/** 默认预设 ID */
export const DEFAULT_PRESET_ID = BUILTIN_PRESET_STANDARD;

/**
 * 预设 ID 规范化：未知/缺失一律回退 standard（历史会话兼容）。
 *
 * @deprecated 只认内置 ID，自定义预设会被误回退 standard。主进程请用
 * agent-preset-manager 的 resolvePresetId / normalizeSessionPresetId（内置 → 自定义 → standard）。
 */
export function normalizePresetId(presetId: string | undefined): string {
  if (!presetId) return DEFAULT_PRESET_ID;
  return BUILTIN_AGENT_PRESETS.some((p) => p.id === presetId)
    ? presetId
    : DEFAULT_PRESET_ID;
}

/** 创建预设输入 */
export interface AgentPresetCreateInput {
  name: string;
  description: string;
  promptSections?: string[];
  /** 隐藏与预设矛盾的内置提示词段落 key（'subagents' | 'memory' | 'task-graph' | 'automation'） */
  suppressPromptSections?: AgentPresetSuppressKey[];
  /** 禁用的产品内置工具组（task-graph / memory / collaboration / automation） */
  disabledToolGroups?: AgentPresetToolGroup[];
  /** 禁用的单个产品内置工具（短名，见 AGENT_PRESET_GROUP_TOOL_NAMES） */
  disabledTools?: string[];
  effort?: AgentEffort;
  permissionMode?: ProferPermissionMode;
  skillSlugs?: string[];
  mcpServerNames?: string[];
  allowSubagents?: boolean;
  /** 派生基座（仅限内置预设 ID）；省略=独立预设 */
  basePresetId?: string;
}

/**
 * 更新预设输入（全部可选；内置预设不可更新）。
 *
 * 语义：字段省略 = 不修改；字段传 null = 清除（回退为跟随默认/不裁剪）；传值 = 设置。
 * basePresetId 传 null = 脱离基座（把当前生效配置冻结为独立预设，不再跟随内置升级）。
 */
export interface AgentPresetUpdateInput {
  name?: string;
  description?: string;
  promptSections?: string[] | null;
  suppressPromptSections?: AgentPresetSuppressKey[] | null;
  disabledToolGroups?: AgentPresetToolGroup[] | null;
  disabledTools?: string[] | null;
  effort?: AgentEffort | null;
  permissionMode?: ProferPermissionMode | null;
  skillSlugs?: string[] | null;
  mcpServerNames?: string[] | null;
  allowSubagents?: boolean | null;
  basePresetId?: string | null;
  /** 工作区列表中用于显示/筛选的本地开关，不参与预设内容解析。 */
  enabledInWorkspace?: boolean;
}

// ===== 预设导出 / 导入（跨机器分享文件） =====

/**
 * 预设导出文件条目：只携带能力字段，不携带 id/时间戳等本地元数据。
 * 内置预设导出后按普通条目导入（导入侧统一生成新 UUID，转为自定义预设）。
 */
export interface AgentPresetExportEntry {
  name: string;
  description: string;
  promptSections?: string[];
  suppressPromptSections?: AgentPresetSuppressKey[];
  disabledToolGroups?: AgentPresetToolGroup[];
  disabledTools?: string[];
  effort?: AgentEffort;
  permissionMode?: ProferPermissionMode;
  skillSlugs?: string[];
  mcpServerNames?: string[];
  allowSubagents?: boolean;
  /** 派生基座（内置预设 ID，跨机器通用）；导入侧校验必须为内置 ID */
  basePresetId?: string;
}

/** 预设导出文件信封（JSON，供跨机器分享；格式不合规时导入整体拒绝） */
export interface AgentPresetExportFile {
  format: "profer-agent-presets";
  version: 1;
  /** ISO 时间戳（仅展示用） */
  exportedAt: string;
  presets: AgentPresetExportEntry[];
}

/** 导入结果：imported 为新建成功的预设；renamed 为因重名自动追加后缀的条目 */
export interface AgentPresetImportResult {
  imported: AgentPreset[];
  /** 导入时因与工作区已有预设重名而自动追加「（导入）」后缀的条目名 */
  renamedNames: string[];
}

/** 从预设提取可导出条目（内置与自定义通用，剥离本地元数据） */
export function toAgentPresetExportEntry(
  preset: AgentPreset,
): AgentPresetExportEntry {
  return {
    name: preset.name,
    description: preset.description,
    ...(preset.promptSections?.length && {
      promptSections: preset.promptSections,
    }),
    ...(preset.suppressPromptSections?.length && {
      suppressPromptSections: preset.suppressPromptSections,
    }),
    ...(preset.disabledToolGroups?.length && {
      disabledToolGroups: preset.disabledToolGroups,
    }),
    ...(preset.disabledTools?.length && {
      disabledTools: preset.disabledTools,
    }),
    ...(preset.effort && { effort: preset.effort }),
    ...(preset.permissionMode && { permissionMode: preset.permissionMode }),
    ...(preset.skillSlugs !== undefined && { skillSlugs: preset.skillSlugs }),
    // undefined=不裁剪，[]=禁用全部用户 MCP，导出时必须保留该能力边界。
    ...(preset.mcpServerNames !== undefined && {
      mcpServerNames: preset.mcpServerNames,
    }),
    ...(preset.allowSubagents !== undefined && {
      allowSubagents: preset.allowSubagents,
    }),
    ...(preset.basePresetId !== undefined && {
      basePresetId: preset.basePresetId,
    }),
  };
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
export function mergeAgentPreset(
  base: AgentPreset,
  child: AgentPreset,
): AgentPreset {
  const promptSections = [
    ...(base.promptSections ?? []),
    ...(child.promptSections ?? []),
  ];
  const suppressPromptSections = [
    ...new Set([
      ...(base.suppressPromptSections ?? []),
      ...(child.suppressPromptSections ?? []),
    ]),
  ];
  const disabledToolGroups = [
    ...new Set([
      ...(base.disabledToolGroups ?? []),
      ...(child.disabledToolGroups ?? []),
    ]),
  ];
  const disabledTools = [
    ...new Set([...(base.disabledTools ?? []), ...(child.disabledTools ?? [])]),
  ];
  return {
    ...child,
    ...(promptSections.length > 0 && { promptSections }),
    ...(suppressPromptSections.length > 0 && { suppressPromptSections }),
    ...(disabledToolGroups.length > 0 && { disabledToolGroups }),
    ...(disabledTools.length > 0 && { disabledTools }),
    effort: child.effort ?? base.effort,
    permissionMode: child.permissionMode ?? base.permissionMode,
    skillSlugs:
      child.skillSlugs !== undefined ? child.skillSlugs : base.skillSlugs,
    mcpServerNames:
      child.mcpServerNames !== undefined
        ? child.mcpServerNames
        : base.mcpServerNames,
    allowSubagents:
      child.allowSubagents !== undefined
        ? child.allowSubagents
        : base.allowSubagents,
  };
}

/** Agent 预设 IPC 通道常量 */
export const AGENT_PRESET_IPC_CHANNELS = {
  /** 获取全部可用预设（内置 + 全局 + 当前工作区） */
  LIST_PRESETS: "agent:list-presets",
  /** 查询某个全局预设的工作区有效引用。 */
  GET_REFERENCE_REPORT: "agent:get-preset-reference-report",
  /** 删除全局用户预设（Manager 会再次执行引用检查）。 */
  DELETE_GLOBAL_PRESET: "agent:delete-global-preset",
  /** 将全局预设冻结复制到当前工作区。 */
  COPY_TO_WORKSPACE: "agent:copy-preset-to-workspace",
  LIST_GLOBAL_PRESETS: "agent:list-global-presets",
  CREATE_GLOBAL_PRESET: "agent:create-global-preset",
  PROMOTE_WORKSPACE_PRESET_TO_GLOBAL:
    "agent:promote-workspace-preset-to-global",
  UPDATE_GLOBAL_PRESET: "agent:update-global-preset",
  SET_DEFAULT_REFERENCE: "agent:set-default-preset-reference",
  ENABLE_GLOBAL_IN_WORKSPACE: "agent:enable-global-preset-in-workspace",
  DISABLE_GLOBAL_IN_WORKSPACE: "agent:disable-global-preset-in-workspace",
  /** 主进程补偿事务：改绑该工作区全部引用后解除全局预设作用域。 */
  REBIND_AND_DISABLE_GLOBAL_SCOPE:
    "agent:rebind-and-disable-global-preset-scope",
  SET_WORKSPACE_ENABLED: "agent:set-workspace-preset-enabled",
  REBIND_SESSION_REFERENCE: "agent:rebind-session-preset-reference",
  REBIND_AUTOMATION_REFERENCE: "agent:rebind-automation-preset-reference",
  /** 获取默认预设 ID */
  GET_DEFAULT_PRESET: "agent:get-default-preset",
  /** 更新会话绑定的预设 */
  UPDATE_SESSION_PRESET: "agent:update-session-preset",
  /** 设置默认预设（新建会话使用） */
  SET_DEFAULT_PRESET: "agent:set-default-preset",
  /** 新建自定义预设 */
  CREATE_PRESET: "agent:create-preset",
  /** 复制预设（内置或自定义）为新的自定义预设 */
  COPY_PRESET: "agent:copy-preset",
  /** 更新自定义预设 */
  UPDATE_PRESET: "agent:update-preset",
  /** 删除自定义预设 */
  DELETE_PRESET: "agent:delete-preset",
  /** 获取其他工作区的预设列表（按工作区分组，导入用） */
  GET_OTHER_WORKSPACE_PRESETS: "agent:get-other-workspace-presets",
  /** 从其他工作区导入预设到当前工作区 */
  IMPORT_PRESET_FROM_WORKSPACE: "agent:import-preset-from-workspace",
  /** 导出预设为 JSON 文件（主进程弹出保存对话框并写盘；返回 null 表示用户取消） */
  EXPORT_PRESETS: "agent:export-presets",
  /** 从 JSON 文件导入预设（主进程弹出打开对话框并解析；返回 null 表示用户取消） */
  IMPORT_PRESETS: "agent:import-presets",
} as const;
