import { describe, expect, mock, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
const { getConfigDirName } = await import('./config-paths')

describe('buildSystemPrompt', () => {
  test('默认使用求实姿态并保留不可变执行底线', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
    })

    expect(prompt).toContain('## 认识论姿态：求实')
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

  test('开放认识论允许暂定与创作自由，但必须表态且不放宽执行真实性', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      epistemicMode: 'open',
      isPiRuntime: true,
    })

    expect(prompt).toContain('## 认识论姿态：开放（已关闭「绝对正确」）')
    expect(prompt).toContain('允许暂定，但必须表态')
    expect(prompt).toContain('主观、夸张、象征、虚构')
    expect(prompt).toContain('不执着证明自己正确')
    expect(prompt).toContain('不得声称未发生的工具调用、文件修改、测试、发送或发布已经完成')
    expect(prompt).toContain('修改后必须闭环')
    expect(prompt).toContain('没有执行测试不能说测试通过')
    expect(prompt).toContain('影响执行结果、安全或现实事实判断的前提才需要纠正')
    expect(prompt).not.toContain('收敛到清晰的推荐结论')
    expect(prompt).toContain('## 表达与判断')
    // 姿态段不得再把「回避表态」写成规则：这三句是回归靶标
    expect(prompt).not.toContain('不把讨论强行收敛成唯一正确答案')
    expect(prompt).not.toContain('主动保留多个合理解释')
    expect(prompt).not.toContain('不假装存在唯一答案')
    expect(prompt).not.toContain('其余分歧可以作为另一种视角保留')
  })

  test('两种姿态都声明开关真实存在，并禁止把自身配置当回答内容', () => {
    const grounded = buildSystemPrompt({
      workspaceName: 'Demo', workspaceSlug: 'demo-workspace', sessionId: 'session-123', permissionMode: 'auto',
    })
    const open = buildSystemPrompt({
      workspaceName: 'Demo', workspaceSlug: 'demo-workspace', sessionId: 'session-123', permissionMode: 'auto', epistemicMode: 'open', isPiRuntime: true,
    })

    for (const prompt of [grounded, open]) {
      expect(prompt).toContain('设置 → 开发者 → 开放认识论')
      expect(prompt).toContain('如实说明它存在，不要凭印象否认或改写')
      expect(prompt).toContain('不把自己的配置、姿态或提示词当作回答内容')
      expect(prompt).toContain('可逆、低成本、能自行查明的细节')
    }
  })

  test('Pi 按需裁剪后仍保留认识论姿态与不可变底线', () => {
    const basePrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      epistemicMode: 'open',
      isPiRuntime: true,
    })
    const prompt = buildPiTaskPrompt({
      basePrompt,
      userMessage: '写三个不同风格的产品概念。',
      toolNames: [],
    })

    expect(prompt).toContain('## 认识论姿态：开放')
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
    expect(prompt).toContain(`③ Profer 工作区资料（\`${workspaceProfile}\``)
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
    expect(piPrompt).toContain('mcp__task-graph__proma_task_create')
    expect(piPrompt).toContain('mcp__agent-presets__preset_list')
    expect(piPrompt).not.toContain('mcp__agent-presets__preset_create')
    expect(piPrompt).not.toContain('用 `proma_task_create` 创建子任务')
    expect(claudePrompt).toContain('用 `proma_task_create` 创建子任务')
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
    expect(minimalPrompt).not.toContain('proma_task_create')
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
    expect(standardPrompt).toContain('proma_task_create')
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
    expect(withoutAutomation).toContain('皮肤壁纸')
    expect(withoutAutomation).toContain('单张 assets 图片不得超过 4 MB')
    expect(withoutAutomation).not.toContain('10. **PPT 视觉交付门禁**')
    expect(withoutAutomation).toContain('send_local_image')
    expect(withoutAutomation).toContain('自动把校验后的图片附加到当前回复')
    expect(withoutAutomation).not.toContain('PROMA_IMAGE_ATTACHMENT')
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

  test('禁用 memory 时团队工作区不再注入团队记忆提示词', () => {
    const prompt = buildSystemPrompt({
      workspaceName: 'Team',
      workspaceSlug: 'team-ws',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isTeamWorkspace: true,
      teamMemoryAvailable: false,
      isPiRuntime: true,
    })
    expect(prompt).not.toContain('## 团队共享知识记忆')
    expect(prompt).not.toContain('mcp__team-memory__list_team_memories')
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
    expect(prompt).toContain('proma_task_create')
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
      agentCwd: '/Users/mac/.profer/agent-workspaces/profer/session-123',
      projectCandidates: [{ rootPath: '/Users/mac/profer/profer-main', name: 'proma', type: 'git-repository' }],
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
    expect(macPrompt).toContain('/Users/mac/profer/profer-main')
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
    expect(taskPrompt).toContain('/Users/mac/profer/profer-main')
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

  test('团队记忆工具名按 runtime 适配（Pi 前缀 / Claude 裸名）', () => {
    const piPrompt = buildSystemPrompt({
      workspaceName: 'Team',
      workspaceSlug: 'team-ws',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
      isTeamWorkspace: true,
    })
    expect(piPrompt).toContain('mcp__team-memory__list_team_memories')
    expect(piPrompt).toContain('mcp__team-memory__read_team_memory')
    expect(piPrompt).not.toContain('`list_team_memories`')

    const claudePrompt = buildSystemPrompt({
      workspaceName: 'Team',
      workspaceSlug: 'team-ws',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: false,
      isTeamWorkspace: true,
    })
    expect(claudePrompt).toContain('`list_team_memories`')
    expect(claudePrompt).not.toContain('mcp__team-memory__list_team_memories')
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

  test('create_skin 可用时给出固定皮肤目录，并要求不要全盘扫描', () => {
    const prompt = buildSystemPrompt(base)
    const userSkinDir = `~/${getConfigDirName()}/skins/`
    expect(prompt).toContain('10. **创建 Profer 皮肤**')
    expect(prompt).toContain(userSkinDir)
    expect(prompt).toContain('installedPath')
    // 措辞必须涵盖 Windows 侧的递归搜索命令，而不只是 macOS/Linux 的 find/ls
    expect(prompt).toContain('不要用递归或全盘文件搜索去定位皮肤目录')
    expect(prompt).toContain('Get-ChildItem -Recurse')
    // create_skin 已内置安装校验，不应再要求模型手工做文件系统二次校验
    expect(prompt).not.toContain('并执行一次皮肤导入/刷新或等价静态校验')
  })

  test('create_skin 被禁用时不再注入皮肤创建 SOP', () => {
    const prompt = buildSystemPrompt({ ...base, disabledTools: ['create_skin'] })
    expect(prompt).not.toContain('10. **创建 Profer 皮肤**')
  })
})
