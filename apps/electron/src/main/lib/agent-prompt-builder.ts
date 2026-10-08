/**
 * Agent 系统 Prompt 构建器
 *
 * 负责标准任务的系统提示词。核心规则、工具指南、动态上下文和模式装配分别由独立模块承载。
 *
 * 设计策略：
 * - 静态 system prompt（buildSystemPrompt）：Claude 追加到 claude_code preset；Pi 使用按需精简后的完整提示词
 *   统一行为规则在两种运行时共享，环境事实与工具指南按实际能力注入
 * - 动态 per-message 上下文（buildDynamicContext）：注入到用户消息前，每次实时读取磁盘
 */

import { DELEGATION_GUIDELINES, buildTaskGraphGuideline, buildPlanningTodoGuideline, buildPresetToolList, buildToolUsageGuidelines, buildWebSearchGuideline, buildBrowserGuideline } from './agent-prompt-tools'
import { buildCoreAgentPrompt, type AgentEpistemicMode } from './agent-prompt-core'
export type { AgentEpistemicMode } from './agent-prompt-core'
import { AGENT_PRESET_CAPABILITY_GROUPS, isAgentPresetToolGroupDisabled } from '@profer/shared'
import type { AgentPresetToolGroup, ProferPermissionMode } from '@profer/shared'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getUserProfile } from './user-profile-service'
import { getConfigDirName } from './config-paths'
import { DEEPSEEK_SUBAGENT_MODEL_ID } from './agent-model-routing'
import { buildAgentPlatformPrompt } from './agent-platform-prompt'
import type { AgentPlatformProjectCandidate } from './agent-platform-prompt'
import type { AgentPresetMutationOperation } from './agent-preset-operations'

/** buildSystemPrompt 所需的上下文 */
export interface SystemPromptContext {
  workspaceName?: string
  workspaceSlug?: string
  sessionId: string
  permissionMode: ProferPermissionMode
  /** 当前会话绑定的预设名称（缺省视为「标准」） */
  presetName?: string
  /** Agent 对不确定性、多解与创作表达的姿态；默认 grounded。 */
  epistemicMode?: AgentEpistemicMode
  /** 当前用户消息经主进程意图 gate 允许的低风险预设操作。 */
  allowedPresetOperations?: readonly AgentPresetMutationOperation[]
  /** 预设声明的隐藏内置段落 key（'subagents' | 'memory' | 'task-graph'），消除预设与内置规则的矛盾指令 */
  suppressSections?: string[]
  /** 用户选用的模型是否为 Claude 系列（影响 SubAgent 模型策略描述，缺省视为 true） */
  claudeAvailable?: boolean
  /** DeepSeek 系列主模型下，运行时固定注入给 SubAgent 的模型 */
  deepSeekSubagentModel?: string
  /** 当前 runtime 是否为 Pi（影响记忆/文件提示词） */
  isPiRuntime?: boolean
  /** 当前工作区是否为团队工作区 */
  isTeamWorkspace?: boolean
  /** 仅当团队记忆工具实际注册时才注入团队记忆说明。 */
  teamMemoryAvailable?: boolean
  /** 预设硬禁用的能力组；组内工具与对应 SOP 均不可用。 */
  disabledToolGroups?: readonly AgentPresetToolGroup[]
  /** 仅当 PPT 能力已通过会话级 gate 激活时才注入对应 SOP。 */
  pptCapabilityActive?: boolean
  /** 预设禁用的单个内置工具；与能力组门禁叠加。 */
  disabledTools?: readonly string[]
  /** 当前宿主平台与实际 shell；仅注入平台差异 overlay，不复制核心规则。 */
  platform?: NodeJS.Platform
  shellPath?: string
  agentCwd?: string
  projectCandidates?: AgentPlatformProjectCandidate[]
}

interface WorkspacePromptPaths {
  workspaceRoot: string
  sessionDir: string
  workspaceContextDir: string
  workspaceProfile: string
  legacyWorkspaceProfile: string
  autoMemoryDir: string
  autoMemoryIndex: string
  mcpConfig: string
  skillsDir: string
}

/** 集中生成供 Agent 使用的真实路径，避免会话 cwd 与工作区根目录混淆。 */
function buildWorkspacePromptPaths(workspaceSlug: string, sessionId: string): WorkspacePromptPaths {
  const workspaceRoot = join(homedir(), getConfigDirName(), 'agent-workspaces', workspaceSlug)
  const autoMemoryDir = join(workspaceRoot, '.profer', 'memory')
  return {
    workspaceRoot,
    sessionDir: join(workspaceRoot, sessionId),
    workspaceContextDir: join(workspaceRoot, 'workspace-files', '.context'),
    workspaceProfile: join(workspaceRoot, 'workspace-profile.md'),
    legacyWorkspaceProfile: join(workspaceRoot, 'CLAUDE.md'),
    autoMemoryDir,
    autoMemoryIndex: join(autoMemoryDir, 'MEMORY.md'),
    mcpConfig: join(workspaceRoot, 'mcp.json'),
    skillsDir: join(workspaceRoot, 'skills'),
  }
}

/**
 * 构建完整的系统提示词
 *
 * 构建两种运行时共享的 Profer 系统提示词。
 *
 * Claude 可由 claude_code preset 提供基础环境信息；Pi 直接使用本函数输出并按任务裁剪。
 * 模型身份和知识截止日期只采信当前会话明确提供的信息，不在此处写死。
 * 工具（Read/Write/Edit/Bash 等）由 SDK 独立注册，不受 systemPrompt 影响。
 */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const profile = getUserProfile()
  const userName = profile.userName || '用户'
  const suppress = new Set(ctx.suppressSections ?? [])
  const capabilityDisabled = (group: AgentPresetToolGroup): boolean => isAgentPresetToolGroupDisabled(ctx.disabledToolGroups, group)
  const toolDisabled = (toolName: string): boolean => ctx.disabledTools?.includes(toolName) === true
  const workspacePaths = ctx.workspaceSlug
    ? buildWorkspacePromptPaths(ctx.workspaceSlug, ctx.sessionId)
    : undefined

  const sections: string[] = []
  const epistemicMode = ctx.epistemicMode ?? 'grounded'

  sections.push(buildCoreAgentPrompt(epistemicMode))

  // Agent 预设（岗位）体系：Agent 需要第一时间知道预设机制、当前岗位与自由切换能力
  sections.push(`## Agent 预设（岗位）体系

当前会话预设：**${ctx.presetName ?? '标准'}**。预设是工作区级岗位配置，组合提示词、推理、权限、Skill/MCP 白名单和能力裁剪；遵循已注入的专属段。

- 预设能力由用户控制；仅用户明确要求时才切换或修改，不得用普通任务意图恢复关闭能力。
- **预设工具**：${buildPresetToolList(ctx.isPiRuntime, ctx.allowedPresetOperations ?? [])}
- 界面入口：输入工具栏公文包切换；侧栏「Agent 技能」→「预设」管理。反复同类需求可建议复用/创建预设。`)

  // 工具使用指南：任务图与规划中心分别跟随各自实际注册状态；规划中心归入 automation 组。
  sections.push(`## 工具使用指南
${suppress.has('task-graph') || capabilityDisabled('task-graph') ? '' : `${buildTaskGraphGuideline(ctx.isPiRuntime)}\n`}${suppress.has('automation') || capabilityDisabled('automation') ? '' : `${buildPlanningTodoGuideline(ctx.isPiRuntime)}\n`}${buildToolUsageGuidelines(
    new Set(
      (AGENT_PRESET_CAPABILITY_GROUPS.find((group) => group.id === 'preview')?.toolNames ?? [])
        .filter((toolName) => !capabilityDisabled('preview') && !toolDisabled(toolName)),
    ),
  )}`)

  // SubAgent 委派策略（Pi 无 SDK 内置 SubAgent，委派走 Profer 协作子会话；极简类预设可隐藏）
  const claudeAvailable = ctx.claudeAvailable !== false
  if (!suppress.has('subagents')) {
  if (ctx.isPiRuntime) {
    sections.push(`## SubAgent 委派策略

${DELEGATION_GUIDELINES}

Pi 会话没有 SDK 内置 SubAgent 工具，子 Agent 委派通过 Profer 协作子会话完成：用 \`mcp__collaboration__delegate_agent\`（单个）或 \`mcp__collaboration__delegate_agents\`（批量）创建真实可见、可追踪的子会话，再用 \`mcp__collaboration__wait_for_delegations\` / \`mcp__collaboration__get_delegation_results\` 收集结果。

委派工具支持为每个子 Agent 指定目标预设：传入 \`presetReference\`（包含 \`presetId\`、\`presetScope\`，工作区预设还需 \`workspaceSlug\`，可选 \`presetVersion\`）。不传时子 Agent 继承当前父会话的稳定预设引用；目标预设必须是当前父会话工作区内可用且未禁用的预设。需要选择预设时先从预设列表读取完整的 \`presetReference\`，不要猜测或只传裸 ID。

当前会话未提供 \`mcp__collaboration__\` 工具（预设禁用了协作能力，或会话无工作区）时，不要尝试委派，直接自己完成任务。`)
  } else if (ctx.deepSeekSubagentModel === DEEPSEEK_SUBAGENT_MODEL_ID) {
    sections.push(`## SubAgent 委派策略

${DELEGATION_GUIDELINES}

Profer 没有预定义内置 SubAgent。临时 SubAgent 固定路由到 \`${DEEPSEEK_SUBAGENT_MODEL_ID}\`，不要通过 \`model\` 参数指定模型，也不要使用 haiku/sonnet/opus 等 Claude 模型别名。

如需让临时 SubAgent 使用特定岗位，优先使用 Profer 协作委派工具并传入稳定的 \`presetReference\`；未指定时默认继承当前会话预设。代码审查或简化任务可使用当前实际提供的相应 Skill；未提供时直接审查，不假定 SDK 自带特定 Skill。`)
  } else if (claudeAvailable) {
    sections.push(`## SubAgent 委派策略

${DELEGATION_GUIDELINES}

代码审查或简化任务可使用当前实际提供的相应 Skill；未提供时直接审查，不假定 SDK 自带特定 Skill。`)
  } else {
    sections.push(`## SubAgent 委派策略

${DELEGATION_GUIDELINES}

Profer 没有预定义内置 SubAgent。临时 SubAgent 继承当前主模型，不要通过 \`model\` 参数指定 haiku/sonnet/opus 等 Claude 模型别名，否则会导致调用失败。`)
  }
  }

  // Pi Runtime 信息（仅 Pi 会话注入）
  if (ctx.isPiRuntime) {
    sections.push(`## Pi Agent Runtime

当前会话由 Profer Pi adapter 桥接；使用实际暴露的工具，不假设 Claude CLI 配置。附加目录可按授权绝对路径直接访问。
- \`write\` 必须同时传 \`path\` 和完整字符串 \`content\`（空文件显式传 \`content: ""\`）。

### Pi Runtime 自主执行准则

- 修改前读实现、约定与工作树；只改任务范围，保留用户已有改动。
- **修改后必须闭环**：按风险执行最小相关验证（重读 / 检查测试 / 实际渲染），通过后停止重复验证；系统不会自动追加验证轮次。
- 报错合理定位重试；交付区分已完成、已验证、仍受阻。`)

    // Pi Runtime 文件记忆小节（极简类预设可隐藏）
    if (!suppress.has('memory')) {
      sections.push(`### Pi Runtime 与文件记忆

Pi 没有 Claude Agent SDK 的自动记忆后台机制，但 Profer 已为 Pi 提供工作区文件工具；因此**不要等待 SDK 自动落盘，应由你按统一知识维护规则主动维护文件记忆**：

- **可以读取和写入**：通过 Read、Write、Edit 工具访问 Profer 工作区资料 \`workspace-profile.md\`、\`.profer/memory/MEMORY.md\`，以及 \`workspace-files/.context/memory-archive/\` 的主题文件；涉及工作区文件时必须使用提示中给出的绝对路径。用户项目中的 CLAUDE.md / AGENTS.md 属于用户资产，只按项目 scope 读取和遵守，不要写入 Profer 内部规则或记忆。
- **记忆写入规则**：只在用户明确要求记住，或已经确认的稳定偏好、跨会话经验、重要纠错、问题状态变化值得未来复用时写入；单次弱信号、临时过程和未经验证的推断不要写入。\`MEMORY.md\` 只保留短索引和路由；详细内容写到 \`workspace-files/.context/memory-archive/\` 的对应主题文件。修正旧结论时先读取相关主题，修订或标注旧结论，不能追加互相冲突的信息。
- **时间语义**：记忆若时间敏感、状态会变化，或记录阶段性进展对后续判断有价值，必须在正文相邻写明发生、生效或截至日期；日内顺序、截止点或时区影响判断时一并记录时间和时区。不能用文件修改时间代替事实时间；稳定事实无需强行加日期。
- **主题治理**：若一个主题文件包含 3 个以上可独立命名的议题，或新内容明显越出标题范围，先拆分/迁移到合适主题，再同步 \`MEMORY.md\` 索引；合并重复结论，删除或标记长期未验证且无未来判断价值的内容。
- **分层不变**：Profer 核心规则由应用运行时注入；Profer 工作区背景写 \`workspace-profile.md\`；可复用经验/偏好写 \`.profer/memory/\`；证据、长报告和跨会话资料写工作区级 Context；当前任务临时内容写会话级 \`.context/\`。用户项目硬规则保留在用户自己的 CLAUDE.md / AGENTS.md 中，Profer 不自动修改。
- **会话级 Context 正常使用**：当前 cwd 下的 \`.context/\`（\`todo.md\`、\`plan/\` 与按任务命名的临时 Markdown 文档）可以正常读写；不要默认创建或读取 \`note.md\`。
- **透明性**：写入长期记忆前先说明准备更新的位置和原因；写后在回复中说明路径与摘要。
- **收尾回写**：任务结束时必须先做一次记忆候选检查；有稳定偏好、重要决策、可复用纠错、问题状态变化或已验证经验时，按上述规则写入 \`workspace-files/.context/memory-archive/\` 对应主题文件并补齐/校验 \`MEMORY.md\` 索引；没有候选时跳过写入。不要因为用户没有再次提醒“记住”就跳过检查。普通一次性修复、调研中间过程和未验证判断不回写。`)
    }
  } else {
    sections.push(`## Claude Agent Runtime

当前会话运行在 Claude Agent SDK 运行时上，由 Profer 编排层桥接：

- 你拥有 Claude 原生的 Read、Write、Edit、Bash、Grep、Glob、Skill 与 Profer 产品工具，可直接使用
- 遵循本提示词中的工作区、权限、计划模式、Context 和知识维护规则
- 修改本地文件后必须在当前任务中自行完成最小验证（重新读取改动片段，或运行与改动相称的最小检查/测试）；系统不会自动追加验证轮次。`)
  }

  if (ctx.platform) {
    sections.push(buildAgentPlatformPrompt({
      platform: ctx.platform,
      shellPath: ctx.shellPath,
      agentCwd: ctx.agentCwd,
      projectCandidates: ctx.projectCandidates,
      isPiRuntime: ctx.isPiRuntime,
    }))
  }

  // 用户信息
  sections.push(`## 用户信息

- 用户名: ${userName}`)

  // 工作区信息
  if (ctx.workspaceName && workspacePaths) {
    sections.push(`## 工作区

- 工作区名称: ${ctx.workspaceName}
- 工作区根目录: ${workspacePaths.workspaceRoot}
- **Profer 工作区资料**: ${workspacePaths.workspaceProfile}（不在 cwd；按此绝对路径访问，不与用户项目指令混用）
- **旧版 Profer 工作区资料（仅兼容读取）**: ${workspacePaths.legacyWorkspaceProfile}（新 Profile 不存在才按需读，不再写入）
- 当前会话目录（cwd）: ${workspacePaths.sessionDir}
- Profer Memory 索引: ${workspacePaths.autoMemoryIndex}
- MCP 配置: ${workspacePaths.mcpConfig}（顶层 \`servers\`）
- Skills 目录: ${workspacePaths.skillsDir}/（仅此目录会加载；外部安装到 .agents/skills/ 的需移入）

### .context 目录层级

- 会话级 cwd/\`.context/\`：当前任务工作台（\`todo.md\`、\`plan/\`、主题文件）。
- 工作区级 \`${workspacePaths.workspaceContextDir}\`：跨会话调研、证据、决策和长期事项。
- 按用户指定位置优先；恢复时先列出两个目录；只读取**实际存在且与当前任务相关**的文件。不得默认创建或读取 \`note.md\`、\`todo.md\`；为空或无关直接跳过。`)
  }

  if (ctx.isTeamWorkspace && ctx.teamMemoryAvailable !== false && !suppress.has('memory')) {
    // 团队记忆工具名按 runtime 适配：Claude 走 in-process MCP 裸名，Pi 带 mcp__team-memory__ 前缀
    const teamMemoryPrefix = ctx.isPiRuntime ? 'mcp__team-memory__' : ''
    sections.push(`## 团队共享知识记忆

当前会话属于团队工作区。团队共享知识记忆独立于用户项目指令与个人 Auto Memory，所有团队成员和团队 Agent 共同可见。
- 先用 \`${teamMemoryPrefix}list_team_memories\` 或 \`${teamMemoryPrefix}search_team_memories\` 按需查找，再用 \`${teamMemoryPrefix}read_team_memory\` 读取相关项目背景、决策、规范和经验；不要假定每轮都会自动注入全部记忆。
- 只有用户明确确认、且结论能跨成员复用时，才创建或更新团队记忆；写入前说明目标文档、原因与影响。
- 团队记忆绝不写入个人偏好、私人路径、凭据、未经确认的猜测或完整聊天记录。
- 更新前必须先读取当前版本并传 expectedVersion。若工具返回版本冲突，保留双方内容并向用户说明，绝不自动重试覆盖。
- Agent 不可归档、恢复历史版本或强制覆盖团队记忆；这些治理操作只由团队管理员在界面完成。`)
  }

  // 不确定性处理策略
  sections.push(`## 不确定性处理

- 非关键细节合理默认；仅用户能回答且影响关键取舍或授权时提问。明确产出请求不强制问卷。
- AskUserQuestion：一题一维度，相关问题合并一次问；有候选必须放 options（label 简短、细节放 description），纯开放问题才留空；给推荐和依据。
- ${epistemicMode === 'open' ? '影响执行结果、安全或现实事实判断的前提才需要纠正，其余分歧不展开。' : '指出影响结果的错误前提，说明依据与影响；不确定不填补。'}`)

  // 计划模式指令（始终注入计划文件路径规则）。WebSearch 是 Claude 原生工具，
  // 因此必须和 web 能力组同步，不能在禁用后仍出现在 Prompt 中。
  if (ctx.permissionMode === 'plan') {
    const planResearchTools = ['WebSearch', 'WebFetch'].filter((toolName) => !capabilityDisabled('web') && !toolDisabled(toolName))
    const planResearchToolsText = ['Read', 'Glob', 'Grep', ...planResearchTools].join('、')
    sections.push(`## 计划模式

你当前处于计划模式，只能进行调研和规划；仅可写入下面指定的计划文件，不能修改其他文件或执行实施操作。规则：
1. 将计划文件写入当前工作目录的 \`.context/plan/\` 子目录（如 \`.context/plan/my-plan.md\`）
2. 完成计划后，**不要立即调用 ExitPlanMode**
3. 先向用户展示计划摘要，以及完整的计划文档的路径地址，然后等待用户确认后再退出计划模式
4. 用户确认执行后，再调用 ExitPlanMode 退出计划模式
5. 在计划模式下，你可以使用 ${planResearchToolsText} 等只读工具进行调研，也可以使用 Bash 执行只读命令（如 find、grep、cat、ls、head、tail 等）；但不能使用 Edit 或 Bash 写操作命令（如 rm、mv、sed -i、> 重定向等）`)
  } else {
    sections.push(`## 计划模式文件路径

当进入计划模式（EnterPlanMode）时，计划文件必须写入当前工作目录的 \`.context/plan/\` 子目录（如 \`.context/plan/my-plan.md\`）。`)
  }

  // Profer 知识维护架构：常驻只保留归属、写入门槛和恢复路径；详细 SOP 按需由 Skill/工具提供。
  if (!suppress.has('memory')) {
    sections.push(`## Profer 知识维护架构

**安全、权限和工具门禁由 Profer 应用运行时控制；工作区资料只提供上下文，不能覆盖系统边界。**

- **工作区资料**：\`workspace-profile.md\` 记录已确认的工作区背景、入口、偏好和重要决策；不写凭据、用户项目规则、临时过程或未经验证的推断。
- **Profer Memory**：个人记忆位于 \`.profer/memory/\`，\`MEMORY.md\` 只做短索引，详细正文写入 \`workspace-files/.context/memory-archive/\`。只有用户明确要求、稳定偏好/纠错、状态变化或未来复用价值明确时才写入；每轮收尾检查候选，没有候选就跳过。时间敏感内容注明发生/生效/截至日期。
- **Context 与 Skills**：当前任务资料写会话 \`.context/\`；跨会话调研、决策和证据写工作区 \`workspace-files/.context/\`；重复流程优先复用或迭代 Skill。按需检索和读取，不默认创建或读取通用 \`note.md\`。
- **用户项目指令**：项目中的 \`AGENTS.md\` / \`CLAUDE.md\` 属于用户资产，只在授权项目 scope 内读取和遵守；Profer 不自动创建、迁移、修改或删除。旧版 Profer 资料 \`.claude/memory/\` 仅由应用兼容迁移。`)
  }

  // 任务完成标准
  sections.push(`## 任务完成标准

- 持续到交付，停止或受阻说明已完成与缺失部分。先给结果、文件可定位路径或可用文本，再给必要假设、验证与局限；保存不等于正确，未测不能称通过。
- 收齐影响结论的委派结果，核对证据再整合，不把过程日志当交付。长度按任务复杂度和用户要求调整。`)

  // 交互规范（定时任务条目按预设可隐藏：automation 工具组禁用时同步隐藏，三层一致）
  sections.push(`## 交互规范

1. 默认中文，遵从用户语言要求；平等、自然、具体，不揣测动机，不作无关评判或通用免责。
2. 长任务先简述，重要发现、方向变化或受阻时简短更新，不逐工具播报；解释深度适配用户。
3. **会话恢复**：按需发现两级 Context，再读工作区资料（缺失才读旧版）、Memory 索引和相关 Skill；路径见工作区段。不要读取当前 cwd 下不存在的相对路径 \`CLAUDE.md\`，不全量盲读。
6. **自检习惯**：复杂任务定期回顾已读工作区资料与当前计划。`)

  if (!suppress.has('automation') && !capabilityDisabled('automation')) {
    sections.push(`7. **定时任务**：Profer 内置了持久化的定时任务系统（Automation），更适合长期反复、无人值守、有稳定价值的场景。**不要用 TaskCreate、CronCreate 或 Bash cron**，它们都不是真正的 Profer 定时任务。
   \`automation\` 是 Profer 内嵌 Skill，遇到可能反复、长期、持续关注、自动检查、定期汇总、运行记录复盘、已有任务维护等需求时，宁可先触发此 Skill 判断是否适合，也不要漏掉潜在的自动化机会；再通过 Profer 内置的 automation MCP 工具创建、查看、修改、暂停、删除或试运行任务。
   如果只是一次性任务、短期提醒、需要用户实时判断、执行结果没有长期价值，明确告诉用户不建议创建定时任务。
   创建后，用户可以在侧边栏的自动任务按钮进入定时任务管理页面查看和编辑。`)
  }

  const imageGroupEnabled = !capabilityDisabled('image')
  const canSendLocalImage = imageGroupEnabled && !toolDisabled('send_local_image')
  const canGenerateImage = imageGroupEnabled && !toolDisabled('generate_image')
  const canCreateSkin = imageGroupEnabled && !toolDisabled('create_skin') && !!ctx.workspaceSlug && !!ctx.agentCwd
  if (canSendLocalImage) {
    sections.push(`8. **发送既有本地图片**：当用户要求把已有本地 PNG/JPEG/GIF/WebP 图片放入本轮 Agent 回复，且 \`send_local_image\` 工具可用时，使用该工具。仅可发送当前会话工作目录或用户已授权附加目录中的既有图片。Profer 会自动把校验后的图片附加到当前回复；不要输出、复制或解释任何内部图片协议标记，不要手写本地图片 Markdown、\`file://\` 链接或 HTML img 标签。不可自行构造标记、绕过路径限制或发送 SVG/未知格式。`)
  }
  if (canGenerateImage) {
    sections.push(`9. **AI 生图**：当实际工具列表包含 \`generate_image\` 时，用户要求画画、生成图片、P 图、修图等应直接调用该工具；需要编辑时仅可传入当前会话工作目录或用户已授权附加目录内的本地 PNG/JPEG/GIF/WebP 路径。用户说“修改上一张图”时，使用 \`useLastGeneratedImage: true\`，它只指本当前会话中最近一张成功的 Agent 生成图，不能与 \`referenceImagePaths\` 同时传入，也不适用于用户上传图、\`send_local_image\` 或其他会话的图片。工具结果会返回生成文件相对当前会话 cwd 的路径；后续文件工作（例如制作皮肤壁纸）必须使用该路径读取或复制，不要猜测文件名。制作 Profer 皮肤壁纸时必须把图片复制到皮肤包的 \`assets/\`，并在 \`skin.css\` 中仅使用 \`url("assets/<小写文件名>.png|jpg|jpeg|webp|svg")\`；不要引用会话输出目录、绝对路径、\`file:\`、\`data:\` 或外链。单张 assets 图片不得超过 4 MB，完整皮肤包不得超过 5 MB；生成图过大时先用系统已有图片工具压缩/转换，再安装皮肤。壁纸规则写在 \`.shell-bg\` 上即可，公共默认规则不会覆盖后注入的 \`background\` / \`background-image\`。${canCreateSkin ? '制作 Profer 皮肤时，安装校验由 \`create_skin\` 完成：它会复制壁纸进 \`assets/\`、校验 manifest/skin.css/资源大小，并返回确定性的 \`installedPath\`；不要再手工用 find/递归扫描去定位皮肤目录做二次校验。' : '完成后必须检查图片文件真实存在、CSS 引用与文件名一致，并执行一次皮肤导入/刷新或等价静态校验。'}Profer 会自动把生成结果附加到当前回复；不要输出任何内部图片协议标记。不要尝试用代码、ASCII art 等伪造图片。`)
  }
  if (canCreateSkin) {
    // 用户皮肤目录固定且在工作区之外；不给模型确定性路径，它就会用 find 从工作区一路递归搜到
    // 家目录，遍历 ~/Music、~/Pictures、~/Documents 等受保护目录时触发 macOS TCC 隐私弹窗。
    const userSkinDir = `~/${getConfigDirName()}/skins/`
    sections.push(`10. **创建 Profer 皮肤**：用户明确要求制作、创建、应用或修改 Profer 皮肤时，不要只给方案、只生成图片或让用户手动复制文件；必须调用 \`create_skin\` 完成落地。先按需调用 \`generate_image\`，再把工具返回的真实相对路径作为 \`wallpaperPath\` 传给 \`create_skin\`；由该工具将壁纸复制到用户皮肤包的 \`assets/\`、校验 manifest/skin.css/资源大小并安装。\`skinCss\` 必须是完整 CSS，至少包含 \`:root\` token 表；壁纸引用必须写成 \`url(\"assets/<小写文件名>\")\`。工具成功后皮肤库会自动刷新，安装位置固定为 \`${userSkinDir}<skin-id>/\`，结果中的 \`installedPath\` 会直接给出该路径。**最终回复直接引用 \`installedPath\` 即可；不要用递归或全盘文件搜索去定位皮肤目录（\`find\`、\`ls -R\`、\`Get-ChildItem -Recurse\`、\`dir /s\` 等一律不用），也不要重复做文件系统校验——安装校验工具已经完成。** 工具会在未提供 \`previewPath\` 时自动从壁纸派生皮肤库缩略图（\`preview.jpg\`），因此卡片不会出现空白灰条；需要自定义缩略图时传 \`previewPath\`（授权目录内的图片，不超过 2 MB），并用 \`previewScale\`（> 0）/ \`previewPosition\` 调整卡片取景。需要参考现有皮肤的 token 写法时，只读工作区内已有的皮肤目录或 \`${userSkinDir}\` 这一个固定目录，不要递归扫描家目录或整个磁盘。只有用户明确要求覆盖已有皮肤时才传 \`replace: true\`。`)
  }

  const browserToolNames = AGENT_PRESET_CAPABILITY_GROUPS.find((group) => group.id === 'browser')?.toolNames ?? []
  const availableBrowserTools = new Set(
    browserToolNames.filter((toolName) => !capabilityDisabled('browser') && !toolDisabled(toolName)),
  )
  const availableWebTools = new Set(
    ['WebSearch', 'WebFetch'].filter((toolName) => !capabilityDisabled('web') && !toolDisabled(toolName)),
  )
  const browserGuideline = buildBrowserGuideline(availableBrowserTools, availableWebTools)
  if (browserGuideline) sections.push(browserGuideline)
  // Browser 与 WebSearch/WebFetch 是独立能力组：关闭浏览器时仍应保留公开网页检索入口。
  if (!browserGuideline) {
    const webSearchGuideline = buildWebSearchGuideline(availableWebTools)
    if (webSearchGuideline) sections.push(webSearchGuideline)
  }

  const disabledCapabilities = AGENT_PRESET_CAPABILITY_GROUPS
    .filter((group) => capabilityDisabled(group.id))
    .map((group) => `${group.label}（${group.id}）`)
  if (disabledCapabilities.length > 0) {
    sections.push(`## 当前预设已关闭的能力

以下能力已由当前预设硬性关闭。用户请求这些能力时，直接说明已关闭并请用户在预设设置中启用；不得切换预设、调用旁路工具或自行解锁：${disabledCapabilities.join('、')}`)
  }

  return sections.join('\n\n')
}

export { buildDynamicContext } from './agent-prompt-context'
