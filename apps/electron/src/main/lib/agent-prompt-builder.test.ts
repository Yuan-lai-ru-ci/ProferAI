import { describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// prompt builder 经 config-paths 间接导入 Electron；Bun 单测需提供最小主进程 mock。
mock.module('./workspace-mcp-config', () => ({
  getWorkspaceMcpConfig: () => ({
    servers: {
      allowed: { type: 'http', enabled: true, url: 'https://allowed.example.test/mcp' },
      denied: { type: 'stdio', enabled: true, command: '/private/denied-mcp', args: ['--secret'] },
      disabled: { type: 'http', enabled: false, url: 'https://disabled.example.test/mcp' },
    },
  }),
}))

mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const { buildSystemPrompt, buildDynamicContext } = await import('./agent-prompt-builder')
const { buildPiTaskPrompt } = await import('./pi-task-prompt')
const { assembleAgentSystemPrompt, appendAgentTaskPrompt } = await import('./agent-prompt-assembly')
const { getConfigDirName } = await import('./config-paths')

describe('模块化提示词装配', () => {
  test('Pi 任务指导只描述实际注册的派工入口', () => {
    const input = {
      mode: 'standard' as const, runtime: 'pi' as const, policy: { useClaudeCodePreset: true },
      context: { workspaceName: 'Demo', workspaceSlug: 'demo', sessionId: 'source', permissionMode: 'auto' as const, isPiRuntime: true },
      userMessage: '委派一个当前会话任务',
    }
    const absent = assembleAgentSystemPrompt({ ...input, toolNames: ['mcp__collaboration__list_delegations'] })
    expect(absent.taskPrompt).not.toContain('placement=current')
    expect(absent.taskPrompt).not.toContain('mcp__collaboration__delegate_agent')
    const partial = assembleAgentSystemPrompt({ ...input, toolNames: ['mcp__collaboration__delegate_agents'] })
    expect(partial.taskPrompt).toContain('placement=current')
    expect(partial.taskPrompt).toContain('`mcp__collaboration__delegate_agents`')
    expect(partial.taskPrompt).not.toContain('`mcp__collaboration__delegate_agent`')
  })
  test('Claude/Pi 按实际工具解释位置与关系，禁用后不泄露派工指引', () => {
    for (const isPiRuntime of [false, true]) {
      const base = { workspaceName: 'Demo', workspaceSlug: 'demo', sessionId: 'source', permissionMode: 'auto' as const, isPiRuntime }
      const prompt = buildSystemPrompt(base)
      expect(prompt).toContain('placement=current')
      expect(prompt).toContain('relation=independent')
      expect(prompt).toContain('用户指定承接位置时优先遵从')
      expect(prompt).toContain('已有明确执行依据时直接推进')
      expect(buildSystemPrompt({ ...base, disabledToolGroups: ['collaboration'] })).not.toContain('placement=current')
      expect(buildSystemPrompt({ ...base, disabledTools: ['delegate_agent', 'delegate_agents'] })).not.toContain('placement=current')
    }
  })

  const context = {
    workspaceName: 'Demo', workspaceSlug: 'demo', sessionId: 'hello',
    permissionMode: 'auto' as const, isPiRuntime: true, presetName: '标准',
    platform: 'darwin' as const, shellPath: '/bin/bash', agentCwd: '/demo/session',
  }
  const input = {
    runtime: 'pi' as const, policy: { useClaudeCodePreset: true },
    context, userMessage: '你好', toolNames: [],
    skillCatalog: '<skill_catalog>CATALOG</skill_catalog>',
    attachedDirectories: '<attached_directories>DIRECTORIES</attached_directories>',
  }
  test('Pi 代码→网页→代码保持 system 相同，任务 SOP 只随本轮用户指导变化', () => {
    const turns = ['检查 TypeScript 类型错误。', '打开 https://example.com 网页。', '继续检查 TypeScript 类型错误。']
      .map((userMessage) => assembleAgentSystemPrompt({
        ...input, mode: 'standard', userMessage, toolNames: ['BrowserObserve'],
      }))
    expect(turns[1]!.systemPrompt).toEqual(turns[0]!.systemPrompt)
    expect(turns[2]!.systemPrompt).toEqual(turns[0]!.systemPrompt)
    expect(turns[0]!.taskPrompt).toBe('')
    expect(turns[1]!.taskPrompt).toContain('## Profer 受管浏览器')
    expect(turns[2]!.taskPrompt).toBe('')
    expect(turns[0]!.text).toContain('## Profer 知识维护架构')
    expect(turns[0]!.text).not.toContain('## Profer 受管浏览器')
    expect(turns[0]!.text).toContain('修改后必须闭环')
  })

  test('Pi 工具门禁关闭时没有任务 SOP；轻量与 Claude 不拆分原系统规则', () => {
    const task = { ...input, userMessage: '打开网页并每天自动检查、用子 Agent 并行研究。' }
    const gated = assembleAgentSystemPrompt({ ...task, mode: 'standard', toolNames: [] })
    expect(gated.taskPrompt).toBe('')
    const light = assembleAgentSystemPrompt({ ...task, mode: 'light', toolNames: ['BrowserObserve'] })
    expect(light.taskPrompt).toBe('')
    const claude = assembleAgentSystemPrompt({ ...task, mode: 'standard', runtime: 'claude', context: { ...context, isPiRuntime: false } })
    expect(claude.taskPrompt).toBe('')
    expect(claude.text).toContain('## Profer 受管浏览器')
  })

  test('任务指导只追加到新用户消息，常规与 recovery 同源且 /compact 保持原指令', () => {
    const previousUserMessage = '检查代码。'
    const guidance = '## Profer 受管浏览器\n仅在本轮使用浏览器工具。'
    const currentUserMessage = '打开网页。'
    const contextualMessage = appendAgentTaskPrompt(currentUserMessage, guidance, false)
    const finalPrompt = appendAgentTaskPrompt('恢复上下文\n\n打开网页。', guidance, false)
    const history = [previousUserMessage, contextualMessage]
    expect(history[0]).toBe(previousUserMessage)
    expect(history[1]).toStartWith(currentUserMessage)
    expect(history[1]).toContain(guidance)
    expect(finalPrompt).toEndWith(contextualMessage.slice(currentUserMessage.length))
    expect(appendAgentTaskPrompt('/compact', guidance, true)).toBe('/compact')
    expect(appendAgentTaskPrompt(currentUserMessage, guidance, true)).toBe(currentUserMessage)
    expect(appendAgentTaskPrompt(currentUserMessage, '', false)).toBe(currentUserMessage)
  })

  test('轻量装配不会重新加回目录和工作区模块；标准模式仍完整', () => {
    const light = assembleAgentSystemPrompt({ ...input, mode: 'light' })
    const standard = assembleAgentSystemPrompt({ ...input, mode: 'standard' })
    expect(light.text).not.toContain('CATALOG')
    expect(light.text).not.toContain('DIRECTORIES')
    expect(light.text).not.toContain('workspace-profile.md')
    expect(light.systemPrompt).toBe(light.text)
    expect(standard.text).toContain('CATALOG')
    expect(standard.text).toContain('DIRECTORIES')
    expect(standard.text).toContain('workspace-profile.md')
    expect(light.chars).toBe(light.text.length)
    expect(light.chars).toBeLessThan(standard.chars / 5)
    expect(standard.chars).toBeLessThan(6500)
    console.log(`[Prompt 字符对照] standard=${standard.chars}, light=${light.chars}`)
  })
  test('自定义预设段不被轻量化吞掉，Claude 轻量不追加 claude_code', () => {
    const light = assembleAgentSystemPrompt({ ...input, runtime: 'claude', mode: 'light',
      policy: { useClaudeCodePreset: true }, customSections: ['CUSTOM_PRESET'],
    })
    expect(light.text).toContain('CUSTOM_PRESET')
    expect(light.systemPrompt).toBe(light.text)
    const standard = assembleAgentSystemPrompt({ ...input, runtime: 'claude', mode: 'standard',
      policy: { useClaudeCodePreset: true },
    })
    expect(standard.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' })
  })
})

describe('buildSystemPrompt', () => {
  test('默认使用求实姿态并保留不可变执行底线', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
    })

    expect(prompt).not.toContain('## 认识论姿态')
    expect(prompt).toContain('收敛到清晰的推荐结论')
    expect(prompt).toContain('## 不可变执行底线')
    expect(prompt).toContain('不伪造工具调用')
    expect(prompt).not.toContain('## 认识论姿态：开放')
    // 反和稀泥契约常驻，且不再保留「不假装存在唯一答案」这类回避表态许可
    expect(prompt).toContain('## 表达与判断')
    expect(prompt).toContain('先给判断')
    expect(prompt).toContain('不做套路式对冲')
    expect(prompt).toContain('发散也要表态')
    expect(prompt).not.toContain('不假装存在唯一答案')
  })

  test('标准提示词包含公式输出契约，避免价格与 shell 变量被误解析', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-math',
      permissionMode: 'auto',
    })

    expect(prompt).toContain('## Markdown 与公式')
    expect(prompt).toContain('行内公式用 `$...$`')
    expect(prompt).toContain('块级公式用 `$$...$$` 并独占行')
    expect(prompt).toContain('字面美元符号前加反斜杠转义')
  })

  test('已删除的认识论设置和姿态段不再进入提示词，真实性约束仍保留', () => {
    for (const isPiRuntime of [true, false]) {
      const prompt = buildSystemPrompt({
        workspaceName: 'Demo', workspaceSlug: 'demo-workspace', sessionId: 'session-123', permissionMode: 'auto', isPiRuntime,
      })
      expect(prompt).not.toContain('开放认识论')
      expect(prompt).not.toContain('## 认识论姿态')
      expect(prompt).not.toContain('设置 → 开发者')
      expect(prompt).toContain('## 不可变执行底线')
      expect(prompt).toContain('没有执行测试不能说测试通过')
      expect(prompt).toContain('## 表达与判断')
    }
  })

  test('Pi 按需裁剪后仍保留表达规则与不可变底线', () => {
    const basePrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
    })
    const prompt = buildPiTaskPrompt({
      basePrompt,
      userMessage: '写三个不同风格的产品概念。',
      toolNames: [],
    })

    expect(prompt).not.toContain('## 认识论姿态')
    expect(prompt).toContain('## 不可变执行底线')
    expect(prompt).toContain('不伪造工具调用')
    // Pi 按需裁剪不得丢掉反和稀泥契约（用户实测跑的就是 Pi）
    expect(prompt).toContain('## 表达与判断')
    expect(prompt).toContain('先给判断')
  })

  test('普通会话默认不注入 PPT 专用长门禁', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      pptCapabilityActive: false,
    })
    expect(prompt).not.toContain('PPT 视觉交付门禁')
    expect(prompt).not.toContain('inspect_deck_sources')
    expect(prompt).not.toContain('PptxScrollViewer')
    expect(prompt).toContain('open_file_preview')
    expect(prompt).toContain('inspect_file_preview')
    expect(prompt).toContain('不得为 PPTX 创建 `Preview.html`')
  })

  test('PPT 能力激活后不注入已移除的快速生成通道或治理工作流', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo', workspaceSlug: 'demo-workspace', sessionId: 'session-123', permissionMode: 'auto', pptCapabilityActive: true,
    })
    for (const forbidden of ['generate_pptx_fast', '快速 PPTX 生成', 'Deck Spec', 'Deck Project', 'Deck Brief', 'inspect_deck_sources', 'create_deck_project', 'compile_deck_project', '确认 Deck Brief', 'assetRefs']) {
      expect(prompt).not.toContain(forbidden)
    }
  })

  test('工作区会话恢复指向 Profer workspace profile，而非用户项目指令文件', () => {
    const slug = 'demo-workspace'
    const sessionId = 'session-123'
    const configDirName = getConfigDirName()
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: slug,
      sessionId,
      permissionMode: 'bypassPermissions',
    })

    const workspaceRoot = join(homedir(), configDirName, 'agent-workspaces', slug)
    const workspaceProfile = join(workspaceRoot, 'workspace-profile.md')
    expect(prompt).toContain(`**Profer 工作区资料**: ${workspaceProfile}`)
    expect(prompt).toContain('再读工作区资料（缺失才读旧版）、Memory 索引和相关 Skill')
    // 绝对路径只在工作区段声明，恢复指引引用该段，不再每处重复长路径。
    expect(prompt.split(workspaceProfile)).toHaveLength(2)
    expect(prompt).toContain('旧版 Profer 工作区资料（仅兼容读取）')
    expect(prompt).toContain('项目中的 `AGENTS.md` / `CLAUDE.md` 属于用户资产')
    expect(prompt).toContain('不要读取当前 cwd 下不存在的相对路径 `CLAUDE.md`')
    expect(prompt).not.toContain('维护工作区根目录下的 CLAUDE.md')
    expect(prompt).toContain(join(workspaceRoot, 'workspace-files', '.context'))
    expect(prompt).toContain(join(workspaceRoot, '.profer', 'memory', 'MEMORY.md'))
    expect(prompt).not.toContain('Profer 脱胎于开源项目')
  })

  test('Context 恢复先发现目录内容，不默认读取或创建 note.md', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'bypassPermissions',
      isPiRuntime: true,
    })

    expect(prompt).toContain('先列出两个目录；只读取**实际存在且与当前任务相关**的文件')
    expect(prompt).toContain('不得默认创建或读取 `note.md`、`todo.md`')
    expect(prompt).toContain('Profer Memory')
    expect(prompt).not.toContain('按主题命名的 Markdown — 研究与分析输出')
    expect(prompt).toContain('按需检索和读取，不默认创建或读取通用 `note.md`')
    expect(prompt).not.toContain('会话级 `.context/`（note.md、todo.md）')
  })

  test('Pi 包含专属执行说明，Claude 不获得 Pi 专属段落', () => {
    const piPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'bypassPermissions',
      isPiRuntime: true,
    })
    const claudePrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'bypassPermissions',
      isPiRuntime: false,
    })

    expect(piPrompt).toContain('最小相关验证')
    // 验证闭环责任由 Agent 自身承担，系统不再自动追加续轮
    expect(piPrompt).toContain('系统不会自动追加验证轮次')
    expect(piPrompt).not.toContain('自动追加一次只做最小验证的续轮')
    // 工具名按 runtime 适配：Pi 带 mcp__ 前缀，Claude 用 in-process MCP 裸名
    expect(piPrompt).toContain('mcp__task-graph__profer_task_create')
    expect(piPrompt).toContain('mcp__agent-presets__preset_list')
    expect(piPrompt).not.toContain('mcp__agent-presets__preset_create')
    expect(piPrompt).not.toContain('用 `profer_task_create` 创建节点')
    expect(claudePrompt).toContain('用 `profer_task_create` 创建节点')
    expect(claudePrompt).toContain('写入口只在当前用户消息明确要求对应操作时按轮注册')
    expect(claudePrompt).toContain('更新和设为默认先返回影响摘要，只有用户下一条消息明确确认后才提交')
    expect(claudePrompt).not.toContain('mcp__agent-presets__preset_create')
    expect(piPrompt).toContain('不要等待 SDK 自动落盘')
    expect(piPrompt).toContain('可以读取和写入')
    expect(piPrompt).toContain('`.profer/memory/MEMORY.md`')
    expect(piPrompt).not.toContain('访问工作区根目录的 `CLAUDE.md`')
    expect(piPrompt).toContain('workspace-profile.md')
    expect(piPrompt).toContain('收尾回写')
    expect(piPrompt).toContain('单次弱信号、临时过程和未经验证的推断不要写入')
    expect(piPrompt).not.toContain('不要写入长期记忆文件')
    expect(claudePrompt).not.toContain('### Pi Runtime 自主执行准则')
    // Claude runtime 也有专属段落，且明确要求 Agent 自行完成验证闭环
    expect(claudePrompt).toContain('## Claude Agent Runtime')
    expect(claudePrompt).toContain('系统不会自动追加验证轮次')
    expect(claudePrompt).not.toContain('自动追加一次只做验证的续轮')
    expect(piPrompt).not.toContain('## Claude Agent Runtime')
  })

  test('规划 Todo 指引按 runtime 使用正确工具名并要求并发保护', () => {
    const piPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
    })
    const claudePrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: false,
    })

    expect(piPrompt).toContain('`mcp__planning__create_todo`')
    expect(piPrompt).toContain('`mcp__planning__update_todo`')
    expect(piPrompt).toContain('`mcp__planning__create_calendar_event`')
    expect(piPrompt).toContain('不要主动询问 Google Calendar、Outlook')
    expect(claudePrompt).toContain('`create_todo`')
    expect(claudePrompt).toContain('`update_todo`')
    expect(claudePrompt).toContain('`create_calendar_event`')
    expect(claudePrompt).not.toContain('`mcp__planning__create_todo`')
    expect(piPrompt).toContain('`expectedUpdatedAt`')
    expect(piPrompt).toContain('Todo 删除仍由用户在规划中心操作')
  })

  test('预设创建/复制提示词只描述主进程意图 gate 实际开放的入口', () => {
    const createPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-create',
      permissionMode: 'auto',
      isPiRuntime: true,
      allowedPresetOperations: ['create'],
    })
    expect(createPrompt).toContain('`mcp__agent-presets__preset_create` 创建工作区预设')
    expect(createPrompt).not.toContain('`mcp__agent-presets__preset_copy` 复制为工作区预设')
    expect(createPrompt).toContain('创建或复制不改变当前会话或默认预设')

    const copyPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-copy',
      permissionMode: 'auto',
      isPiRuntime: false,
      allowedPresetOperations: ['copy'],
    })
    expect(copyPrompt).toContain('`preset_copy` 复制为工作区预设')
    expect(copyPrompt).not.toContain('`preset_create` 创建工作区预设')
    expect(copyPrompt).not.toContain('mcp__agent-presets__preset_copy')

    const switchPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-switch',
      permissionMode: 'auto',
      isPiRuntime: true,
      allowedPresetOperations: ['switch'],
    })
    expect(switchPrompt).toContain('`mcp__agent-presets__preset_switch_session` 切换当前会话预设')
    expect(switchPrompt).toContain('当前轮能力快照保持不变、下一轮才生效')
    expect(switchPrompt).not.toContain('`mcp__agent-presets__preset_create` 创建工作区预设')
  })

  test('预设 Level 2 变更先提案后确认，确认轮只提交冻结提案', () => {
    const updatePrompt = buildSystemPrompt({
      workspaceName: 'Demo', workspaceSlug: 'demo-workspace', sessionId: 'session-update', permissionMode: 'auto',
      isPiRuntime: false, allowedPresetOperations: ['propose_update'],
    })
    expect(updatePrompt).toContain('`preset_propose_update` 提议更新工作区预设')
    expect(updatePrompt).not.toContain('`preset_commit_change` 提交已确认的预设变更')

    const commitPrompt = buildSystemPrompt({
      workspaceName: 'Demo', workspaceSlug: 'demo-workspace', sessionId: 'session-commit', permissionMode: 'auto',
      isPiRuntime: true, allowedPresetOperations: ['commit_change'],
    })
    expect(commitPrompt).toContain('`mcp__agent-presets__preset_commit_change` 提交已确认的预设变更')
    expect(commitPrompt).not.toContain('`mcp__agent-presets__preset_propose_update` 提议更新工作区预设')
  })

  test('极简预设关闭全部产品能力时，Prompt 只保留基础工具规则与预设切换出口', () => {
    const disabledToolGroups = ['task-graph', 'memory', 'collaboration', 'automation', 'browser', 'clipboard', 'preview', 'image', 'web', 'ppt-materials'] as const
    const minimalPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      presetName: '极简',
      suppressSections: ['subagents', 'memory', 'task-graph', 'automation'],
      disabledToolGroups,
      isPiRuntime: true,
    })
    // 隐藏：任务图、委派、记忆、规划及所有增强型产品能力说明。
    expect(minimalPrompt).not.toContain('profer_task_create')
    expect(minimalPrompt).not.toContain('## SubAgent 委派策略')
    expect(minimalPrompt).not.toContain('## Profer 知识维护架构')
    expect(minimalPrompt).not.toContain('### Pi Runtime 与文件记忆')
    expect(minimalPrompt).not.toContain('create_todo')
    expect(minimalPrompt).not.toContain('## Profer 受管浏览器')
    expect(minimalPrompt).not.toContain('`inspect_preview`')
    expect(minimalPrompt).not.toContain('`generate_image`')
    expect(minimalPrompt).not.toContain('`WebSearch`')
    // 保留：基础工具规则、预设岗位段落与切回其它预设的唯一出口。
    expect(minimalPrompt).toContain('回复中的代码块必须标语言')
    expect(minimalPrompt).toContain('## Agent 预设（岗位）体系')
    expect(minimalPrompt).toContain('当前会话预设：**极简**')
    expect(minimalPrompt).toContain('preset_list')

    const standardPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
    })
    // 标准预设无 suppress：全部段落在场
    expect(standardPrompt).toContain('profer_task_create')
    expect(standardPrompt).toContain('## SubAgent 委派策略')
    expect(standardPrompt).toContain('presetReference')
    expect(standardPrompt).toContain('不传时子 Agent 继承当前父会话的稳定预设引用')
    expect(standardPrompt).toContain('## Profer 知识维护架构')
    expect(standardPrompt).toContain('### Pi Runtime 与文件记忆')
  })

  test('automation suppress 隐藏交互规范定时任务条目（三层一致）', () => {
    const withAutomation = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
    })
    expect(withAutomation).toContain('7. **定时任务**')
    expect(withAutomation).toContain('Bash cron')

    const withoutAutomation = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      suppressSections: ['automation'],
      isPiRuntime: true,
    })
    expect(withoutAutomation).not.toContain('7. **定时任务**')
    expect(withoutAutomation).not.toContain('Bash cron')
    expect(withoutAutomation).not.toContain('create_todo')
    expect(withoutAutomation).not.toContain('create_calendar_event')
    // 其余交互规范条目不受影响
    expect(withoutAutomation).toContain('8. **发送既有本地图片**')
    expect(withoutAutomation).toContain('9. **AI 生图**')
    expect(withoutAutomation).toContain('`generate_image`')
    expect(withoutAutomation).toContain('不要尝试用代码、ASCII art 等伪造图片')
    expect(withoutAutomation).toContain('文件相对当前会话 cwd 的路径')
    expect(withoutAutomation).toContain('profer-theme-authoring')
    expect(withoutAutomation).not.toContain('10. **PPT 视觉交付门禁**')
    expect(withoutAutomation).toContain('send_local_image')
    expect(withoutAutomation).toContain('Profer 会自动展示图片')
    expect(withoutAutomation).not.toContain('PROFER_IMAGE_ATTACHMENT')
    expect(withoutAutomation).toContain('6. **自检习惯**')
  })

  test('Pi composer 将低频 SOP 留给任务命中时注入，核心执行规则始终保留', () => {
    const basePrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
      pptCapabilityActive: true,
    })
    const toolNames = [
      'BrowserObserve',
      'plan_ppt_visuals',
      'audit_ppt_delivery',
      'mcp__automation__create_automation',
      'mcp__collaboration__delegate_agent',
      'mcp__memory-archive__search_memory',
    ]

    const ordinary = buildPiTaskPrompt({
      basePrompt,
      userMessage: '检查这个 TypeScript 项目的类型错误。',
      toolNames,
    })
    expect(ordinary).toContain('## 做事方式')
    expect(ordinary).toContain('修改后必须闭环')
    expect(ordinary).toContain('计划模式文件路径')
    expect(ordinary).not.toContain('## Profer 受管浏览器')
    expect(ordinary).not.toContain('PPT 视觉交付门禁')
    expect(ordinary).not.toContain('7. **定时任务**')
    expect(ordinary).not.toContain('## SubAgent 委派策略')
    // Pi 专属文件记忆细节只在记忆任务按需恢复；常驻的知识维护架构仍负责收尾候选检查。
    expect(ordinary).not.toContain('### Pi Runtime 与文件记忆')
    // 普通本地任务应显著减去低频 SOP，而不是只做无意义的段落重排。
    // 08-26 起收尾知识治理架构为常驻约束；其余低频 SOP 仍需裁掉，控制在基础 prompt 的 75% 内。
    expect(ordinary.length).toBeLessThan(basePrompt.length * 0.75)

    const webAndPpt = buildPiTaskPrompt({
      basePrompt,
      userMessage: '访问 https://example.com 并做成 pptx 幻灯片。',
      toolNames,
      pptCapabilityActive: true,
    })
    expect(webAndPpt).toContain('## Profer 受管浏览器')
    // PPT 任务走 PptxGenJS Skill；已移除 generate_pptx_fast 的专属提示词。
    expect(webAndPpt).not.toContain('快速 PPTX 生成')
    expect(webAndPpt).not.toContain('generate_pptx_fast')
    expect(webAndPpt).not.toContain('7. **定时任务**')
  })

  test('禁用 memory 时不注入已删除的团队记忆提示词', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-ws',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
    })
    expect(prompt).not.toContain('团队共享知识记忆')
  })

  test('单工具裁剪时 Prompt 不描述已关闭的具体入口，但保留同组可用能力', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['generate_image', 'send_local_image', 'BrowserPreviewOpen', 'WebSearch', 'WebFetch'],
    })
    expect(prompt).not.toContain('`generate_image`')
    expect(prompt).not.toContain('`send_local_image`')
    expect(prompt).not.toContain('`BrowserPreviewOpen`')
    expect(prompt).not.toContain('`WebSearch`')
    expect(prompt).not.toContain('`WebFetch`')
    expect(prompt).toContain('## Profer 受管浏览器')
    expect(prompt).toContain('BrowserObserve')
    expect(prompt).toContain('BrowserScreenshot')
  })

  test('Browser/Preview SOP 按实际可用工具精确拼装', () => {
    const browserScreenshotDisabled = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['BrowserScreenshot'],
    })
    expect(browserScreenshotDisabled).toContain('## Profer 受管浏览器')
    expect(browserScreenshotDisabled).toContain('BrowserObserve')
    expect(browserScreenshotDisabled).toContain('BrowserPreviewOpen')
    expect(browserScreenshotDisabled).not.toContain('BrowserScreenshot')
    expect(browserScreenshotDisabled).not.toContain('用浏览器截图检查视觉结果')

    const browserObserveDisabled = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['BrowserObserve'],
    })
    expect(browserObserveDisabled).toContain('## Profer 受管浏览器')
    expect(browserObserveDisabled).toContain('BrowserScreenshot')
    expect(browserObserveDisabled).not.toContain('BrowserObserve')
    expect(browserObserveDisabled).not.toContain('先调用 `BrowserObserve`')

    const inspectPreviewDisabled = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['inspect_preview'],
    })
    expect(inspectPreviewDisabled).toContain('open_file_preview')
    expect(inspectPreviewDisabled).toContain('inspect_file_preview')
    expect(inspectPreviewDisabled).not.toContain('通用文件可按需使用 `inspect_preview`')

    const openPreviewDisabled = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['open_file_preview'],
    })
    expect(openPreviewDisabled).toContain('inspect_preview')
    expect(openPreviewDisabled).toContain('inspect_file_preview')
    expect(openPreviewDisabled).not.toContain('必须先用 `open_file_preview`')
    expect(openPreviewDisabled).toContain('使用 `inspect_file_preview` 检查当前用户可见的 Profer PPTX 正式预览')

    const inspectFilePreviewDisabled = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['inspect_file_preview'],
    })
    expect(inspectFilePreviewDisabled).toContain('inspect_preview')
    expect(inspectFilePreviewDisabled).toContain('open_file_preview')
    expect(inspectFilePreviewDisabled).not.toContain('inspect_file_preview')
    expect(inspectFilePreviewDisabled).toContain('PPTX 必须先用 `open_file_preview` 打开 Profer 正式文件预览')

    const allPreviewDisabled = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledTools: ['inspect_preview', 'open_file_preview', 'inspect_file_preview'],
    })
    expect(allPreviewDisabled).not.toContain('文件内容与视觉预览')
  })

  test('代码预设关闭非研发能力，但保留任务图、记忆、预览、网页检索与图片呈现', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-code',
      permissionMode: 'auto',
      presetName: '代码',
      disabledToolGroups: ['automation', 'browser', 'clipboard', 'ppt-materials'],
      disabledTools: ['generate_image', 'create_skin'],
      isPiRuntime: true,
    })
    expect(prompt).toContain('profer_task_create')
    expect(prompt).toContain('## SubAgent 委派策略')
    expect(prompt).toContain('## Profer 知识维护架构')
    expect(prompt).toContain('`inspect_preview`')
    expect(prompt).toContain('`WebSearch`')
    expect(prompt).toContain('`send_local_image`')
    expect(prompt).not.toContain('create_todo')
    expect(prompt).not.toContain('## Profer 受管浏览器')
    expect(prompt).not.toContain('`generate_image`')
    // create_skin 归属 image 组：代码预设声明生图关闭时，皮肤创建工具及其 SOP 也必须一并消失
    expect(prompt).not.toContain('10. **创建 Profer 皮肤**')
  })

  test('六类能力硬禁用时 Prompt 与动态浏览器上下文不暴露对应入口', () => {
    const disabled = ['browser', 'clipboard', 'preview', 'image', 'web', 'ppt-materials'] as const
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      disabledToolGroups: disabled,
    })
    expect(prompt).not.toContain('## Profer 受管浏览器')
    expect(prompt).not.toContain('`inspect_preview`')
    expect(prompt).not.toContain('`generate_image`')
    expect(prompt).not.toContain('`WebSearch`')
    expect(prompt).toContain('当前预设已关闭的能力')
    expect(prompt).toContain('受管浏览器（browser）')
    expect(prompt).toContain('PPT 交付（ppt-materials）')

    const dynamic = buildDynamicContext({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      userBrowserContext: { activeTabId: 'tab-1', title: 'Private', url: 'https://private.example.test', openedAt: Date.now() },
      disabledToolGroups: ['browser'],
    })
    expect(dynamic).not.toContain('<user_browser_context>')
  })

  test('平台 overlay 同时注入给 Claude/Pi，但不复制两套完整核心提示词', () => {
    const macPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      platform: 'darwin',
      shellPath: '/bin/zsh',
      agentCwd: '/Users/alice/.profer/agent-workspaces/profer/session-123',
      projectCandidates: [{ rootPath: '/Users/alice/project', name: 'profer', type: 'git-repository' }],
      isPiRuntime: true,
      disabledToolGroups: ['clipboard'],
    })
    const winPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      platform: 'win32',
      shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      agentCwd: 'C:\\Users\\alice\\session-123',
      projectCandidates: [{ rootPath: 'D:\\repo', name: 'repo', type: 'git-repository' }],
      isPiRuntime: false,
    })

    expect(macPrompt).toContain('## 当前平台与项目路径（macOS）')
    expect(macPrompt).toContain('当前执行环境是 POSIX shell')
    expect(macPrompt).toContain('不要把其他操作系统的命令')
    expect(macPrompt).toContain('/Users/alice/project')
    expect(macPrompt).toContain('path + edits[].oldText/newText')
    expect(winPrompt).toContain('## 当前平台与项目路径（Windows）')
    expect(winPrompt).toContain('只使用运行时实际提供的 Windows shell 和路径格式')
    expect(winPrompt).toContain('file_path + old_string/new_string')
    expect(winPrompt).not.toContain('## 当前平台与项目路径（macOS）')

    // 实际拼装后的普通 Pi 任务也必须保留平台事实与禁用边界，不能随低频 SOP 裁掉。
    const taskPrompt = buildPiTaskPrompt({
      basePrompt: macPrompt,
      userMessage: '检查类型错误。',
      toolNames: ['BrowserObserve', 'mcp__memory-archive__search_memory'],
    })
    expect(taskPrompt).toContain('## 当前平台与项目路径（macOS）')
    expect(taskPrompt).toContain('/bin/zsh')
    expect(taskPrompt).toContain('/Users/alice/project')
    expect(taskPrompt).toContain('## 当前预设已关闭的能力')
    expect(taskPrompt).toContain('clipboard')
    expect(taskPrompt).not.toContain('### Pi Runtime 与文件记忆')
    expect(taskPrompt).not.toContain('## Profer 受管浏览器')
  })

  test('动态上下文只展示当前预设实际允许的 MCP，且不泄露命令和 URL', () => {
    const restricted = buildDynamicContext({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      mcpServerNames: ['allowed'],
    })
    expect(restricted).toContain('- allowed (http, 已启用)')
    expect(restricted).not.toContain('denied')
    expect(restricted).not.toContain('disabled')
    expect(restricted).not.toContain('https://allowed.example.test/mcp')
    expect(restricted).not.toContain('/private/denied-mcp')

    const none = buildDynamicContext({ workspaceSlug: 'demo-workspace', mcpServerNames: [] })
    expect(none).not.toContain('MCP 服务器:')
  })

  test('已删除的团队记忆工具名不再注入 Prompt', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-ws',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
    })
    expect(prompt).not.toContain('团队共享知识记忆')
    expect(prompt).not.toContain('`list_team_memories`')
  })
})

describe('buildSystemPrompt 皮肤创建指引', () => {
  const base = {
    workspaceName: 'Demo',
    workspaceSlug: 'demo-workspace',
    sessionId: 'session-123',
    permissionMode: 'auto' as const,
    agentCwd: '/tmp/profer-cwd',
  }

  test('create_skin 可用时路由到 profer-theme-authoring skill，并要求不要全盘扫描', () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).toContain('10. **创建 Profer 皮肤**')
    expect(prompt).toContain('`profer-theme-authoring` skill')
    expect(prompt).toContain('installedPath')
    // 措辞必须涵盖 Windows 侧的递归搜索命令，而不只是 macOS/Linux 的 find/ls
    expect(prompt).toContain('不要用 find')
    expect(prompt).toContain('Get-ChildItem -Recurse')
    // create_skin 已内置安装校验，不应再要求模型手工做文件系统二次校验
    expect(prompt).not.toContain('并执行一次皮肤导入/刷新或等价静态校验')
  })

  test('create_skin 被禁用时不再注入皮肤创建 SOP', () => {
    const prompt = buildSystemPrompt({ ...base, disabledTools: ['create_skin'] })
    expect(prompt).not.toContain('10. **创建 Profer 皮肤**')
  })
})

/**
 * 提示词里的工作区路径现在由 workspace-locator 解析（读索引 + 尊重 PROFER_CONFIG_DIR）。
 * 这里用隔离配置根，避免污染真实 ~/.profer*。
 */
function withIsolatedConfigRoot<T>(run: (configRoot: string) => T): T {
  const previous = process.env.PROFER_CONFIG_DIR
  const configRoot = mkdtempSync(join(tmpdir(), 'profer-prompt-workspace-'))
  process.env.PROFER_CONFIG_DIR = configRoot
  try {
    return run(configRoot)
  } finally {
    if (previous === undefined) delete process.env.PROFER_CONFIG_DIR
    else process.env.PROFER_CONFIG_DIR = previous
    rmSync(configRoot, { recursive: true, force: true })
  }
}

function writeProjectWorkspaceEntry(configRoot: string, slug: string, rootPath: string): void {
  writeFileSync(join(configRoot, 'agent-workspaces.json'), JSON.stringify({
    version: 4,
    workspaces: [{
      id: randomUUID(),
      name: slug,
      slug,
      createdAt: 0,
      updatedAt: 0,
      type: 'personal',
      storageMode: 'project',
      rootPath,
    }],
  }), 'utf-8')
}

describe('buildSystemPrompt 工作区路径（managed / project）', () => {
  test('managed 路径走 config-paths，尊重 PROFER_CONFIG_DIR（不再硬编码 homedir）', () => {
    const slug = `prompt-managed-${randomUUID()}`
    const sessionId = 'session-managed'

    withIsolatedConfigRoot((configRoot) => {
      const prompt = buildSystemPrompt({
        workspaceName: 'Demo',
        workspaceSlug: slug,
        sessionId,
        permissionMode: 'auto',
      })

      const workspaceRoot = join(configRoot, 'agent-workspaces', slug)
      // 硬编码预期：与改造前的 managed 布局逐项一致，只是根目录改为跟随配置根
      expect(prompt).toContain(`- 工作区根目录: ${workspaceRoot}`)
      expect(prompt).toContain(`- **Profer 工作区资料**: ${join(workspaceRoot, 'workspace-profile.md')}`)
      expect(prompt).toContain(`- **旧版 Profer 工作区资料（仅兼容读取）**: ${join(workspaceRoot, 'CLAUDE.md')}`)
      expect(prompt).toContain(`- 当前会话目录（cwd）: ${join(workspaceRoot, sessionId)}`)
      expect(prompt).toContain(`- Profer Memory 索引: ${join(workspaceRoot, '.profer', 'memory', 'MEMORY.md')}`)
      expect(prompt).toContain(`- MCP 配置: ${join(workspaceRoot, 'mcp.json')}`)
      expect(prompt).toContain(`- Skills 目录: ${join(workspaceRoot, 'skills')}/`)
      expect(prompt).toContain(`- 工作区级 \`${join(workspaceRoot, 'workspace-files', '.context')}\``)
      // 反证：旧的 homedir 硬编码不再出现
      const legacyHardcoded = join(homedir(), getConfigDirName(), 'agent-workspaces', slug)
      if (legacyHardcoded !== workspaceRoot) {
        expect(prompt).not.toContain(legacyHardcoded)
      }
      // 文案快照：managed 段逐字保持改造前的措辞
      expect(prompt).toContain('- 会话级 cwd/`.context/`：当前任务工作台（`todo.md`、`plan/`、主题文件）。')
      expect(prompt).toContain('- **工作区资料**：`workspace-profile.md` 记录已确认的工作区背景')
      expect(prompt).toContain('- **Profer Memory**：个人记忆位于 `.profer/memory/`，`MEMORY.md` 只做短索引')
      // managed 不应出现项目模式的声明
      expect(prompt).not.toContain('当前 cwd 就是项目根')

      const piPrompt = buildSystemPrompt({
        workspaceName: 'Demo',
        workspaceSlug: slug,
        sessionId,
        permissionMode: 'auto',
        isPiRuntime: true,
      })
      expect(piPrompt).toContain('访问 Profer 工作区资料 `workspace-profile.md`、`.profer/memory/MEMORY.md`，以及 `.profer/memory/` 下的主题文件')
      expect(piPrompt).toContain('可复用经验/偏好写 `.profer/memory/`')
      expect(piPrompt).toContain('- **会话级 Context 正常使用**：当前 cwd 下的 `.context/`')
    })
  })

  test('project 声明 cwd 即项目根与 <root>/.profer，且不出现 managed 路径', () => {
    const slug = `prompt-project-${randomUUID()}`
    const sessionId = 'session-project'

    withIsolatedConfigRoot((configRoot) => {
      const projectRoot = join(configRoot, 'demo-project')
      mkdirSync(projectRoot, { recursive: true })
      writeProjectWorkspaceEntry(configRoot, slug, projectRoot)

      const prompt = buildSystemPrompt({
        workspaceName: 'DemoProject',
        workspaceSlug: slug,
        sessionId,
        permissionMode: 'auto',
        isPiRuntime: true,
        platform: 'darwin',
        shellPath: '/bin/zsh',
        agentCwd: projectRoot,
      })

      const canonicalRoot = realpathSync(projectRoot)
      const configDir = join(canonicalRoot, '.profer')
      // 项目根与 .profer 下的三件套
      expect(prompt).toContain(canonicalRoot)
      expect(prompt).toContain(`- **Profer 项目配置目录**: ${configDir}`)
      expect(prompt).toContain(`- **Profer 项目资料**: ${join(configDir, 'profile.md')}`)
      expect(prompt).toContain(`- Profer Memory 索引: ${join(configDir, 'memory', 'MEMORY.md')}`)
      expect(prompt).toContain(`- MCP 配置: ${join(configDir, 'mcp.json')}`)
      expect(prompt).toContain(`- Skills 目录: ${join(configDir, 'skills')}/`)
      expect(prompt).toContain(`跨会话资料 \`${join(configDir, 'workspace-files', '.context')}\``)
      // 单一路径语义
      expect(prompt).toContain('**当前 cwd 就是项目根**')
      expect(prompt).not.toContain('工作区根目录')
      expect(prompt).not.toContain('当前会话目录（cwd）')
      // 平台 overlay 不再把模型引离项目根
      expect(prompt).toContain('**这就是项目根**')
      expect(prompt).not.toContain('cwd 不是项目 root')
      // Pi 记忆段按项目布局：记忆目录是 `<root>/.profer/memory`，不能少写 `.profer`
      expect(prompt).toContain('访问 Profer 工作区资料 `profile.md`、`.profer/memory/MEMORY.md`')
      expect(prompt).not.toContain('`memory/MEMORY.md`')
      expect(prompt).not.toContain('`memory/MEMORY.md`，以及')
      // 不出现 managed 形状的中央工作区路径
      expect(prompt).not.toContain(join(configRoot, 'agent-workspaces', slug))
      expect(prompt).not.toContain('~/.profer/agent-workspaces')
      expect(prompt).not.toContain('workspace-profile.md（新 Profile 不存在才按需读，不再写入）')
    })
  })

  test('project 与 managed 在同一 slug/session 下的工作区段明显不同', () => {
    const slug = `prompt-diff-${randomUUID()}`

    withIsolatedConfigRoot((configRoot) => {
      const managed = buildSystemPrompt({
        workspaceName: 'Demo', workspaceSlug: slug, sessionId: 's1', permissionMode: 'auto',
      })
      const projectRoot = join(configRoot, 'diff-project')
      mkdirSync(projectRoot, { recursive: true })
      writeProjectWorkspaceEntry(configRoot, slug, projectRoot)
      const project = buildSystemPrompt({
        workspaceName: 'Demo', workspaceSlug: slug, sessionId: 's1', permissionMode: 'auto',
      })

      expect(managed).not.toEqual(project)
      expect(managed).toContain(join(configRoot, 'agent-workspaces', slug))
      expect(project).not.toContain(join(configRoot, 'agent-workspaces', slug))
      expect(project).toContain(join(realpathSync(projectRoot), '.profer'))
    })
  })
})
