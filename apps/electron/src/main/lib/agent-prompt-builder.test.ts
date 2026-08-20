import { describe, expect, mock, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

// prompt builder 经 config-paths 间接导入 Electron；Bun 单测需提供最小主进程 mock。
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

const { buildSystemPrompt } = await import('./agent-prompt-builder')
const { buildPiTaskPrompt } = await import('./pi-task-prompt')
const { getConfigDirName } = await import('./config-paths')

describe('buildSystemPrompt', () => {
  test('工作区会话恢复指向根目录 CLAUDE.md，而非会话 cwd', () => {
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
    const workspaceClaudeMd = join(workspaceRoot, 'CLAUDE.md')
    expect(prompt).toContain(`**工作区规则文件（CLAUDE.md）**: ${workspaceClaudeMd}`)
    expect(prompt).toContain(`③ 工作区根目录的 \`CLAUDE.md\`（\`${workspaceClaudeMd}\``)
    expect(prompt).toContain('不要读取当前 cwd 下不存在的相对路径 `CLAUDE.md`')
    expect(prompt).not.toContain('以及当前目录的 CLAUDE.md')
    expect(prompt).toContain(join(workspaceRoot, 'workspace-files', '.context'))
    expect(prompt).toContain(join(workspaceRoot, '.claude', 'memory', 'MEMORY.md'))
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
    expect(prompt).toContain('不默认读取或创建 `note.md`')
    expect(prompt).toContain('目录为空、目标文件不存在或资料无关时直接跳过')
    expect(prompt).toContain('按主题命名的 Markdown — 研究与分析输出')
    expect(prompt).toContain('不使用通用 `note.md`')
    expect(prompt).not.toContain('会话级 `.context/`（note.md、todo.md）')
  })

  test('Pi 获得结果导向但可控的行动阶梯，Claude 不获得 Pi 专属段落', () => {
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

    expect(piPrompt).toContain('低风险、可逆的本地操作')
    expect(piPrompt).toContain('高风险、不可逆或外部副作用')
    expect(piPrompt).toContain('最小相关验证')
    expect(piPrompt).toContain('两次独立证据')
    // 验证闭环责任由 Agent 自身承担，系统不再自动追加续轮
    expect(piPrompt).toContain('系统不会自动追加验证轮次')
    expect(piPrompt).not.toContain('自动追加一次只做最小验证的续轮')
    // 工具名按 runtime 适配：Pi 带 mcp__ 前缀，Claude 用 in-process MCP 裸名
    expect(piPrompt).toContain('mcp__task-graph__proma_task_create')
    expect(piPrompt).toContain('mcp__agent-presets__preset_create')
    expect(piPrompt).not.toContain('用 `proma_task_create` 创建子任务')
    expect(claudePrompt).toContain('用 `proma_task_create` 创建子任务')
    expect(claudePrompt).toContain('`preset_create` 新建')
    expect(claudePrompt).not.toContain('mcp__agent-presets__preset_create')
    expect(piPrompt).toContain('不要等待 SDK 自动落盘')
    expect(piPrompt).toContain('可以读取和写入')
    expect(piPrompt).toContain('`.claude/memory/MEMORY.md`')
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

  test('极简预设 suppressPromptSections 隐藏任务图指南、委派策略与记忆体系段落', () => {
    const minimalPrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      presetName: '极简',
      suppressSections: ['subagents', 'memory', 'task-graph'],
      isPiRuntime: true,
    })
    // 隐藏：任务图指南条目、委派策略、知识维护架构、Pi 文件记忆小节
    expect(minimalPrompt).not.toContain('proma_task_create')
    expect(minimalPrompt).not.toContain('## SubAgent 委派策略')
    expect(minimalPrompt).not.toContain('## Profer 知识维护架构')
    expect(minimalPrompt).not.toContain('### Pi Runtime 与文件记忆')
    // 保留：工具指南标题与其余条目、预设岗位段落、角色定义
    expect(minimalPrompt).toContain('## 工具使用指南')
    expect(minimalPrompt).toContain('回复中的代码块必须标语言')
    expect(minimalPrompt).toContain('## Agent 预设（岗位）体系')
    expect(minimalPrompt).toContain('当前会话预设：**极简**')

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
    // 其余交互规范条目不受影响
    expect(withoutAutomation).toContain('8. **发送既有本地图片**')
    expect(withoutAutomation).toContain('9. **AI 生图**')
    expect(withoutAutomation).toContain('10. **PPT 视觉交付门禁**')
    expect(withoutAutomation).toContain('send_local_image')
    expect(withoutAutomation).toContain('图片附件标记')
    expect(withoutAutomation).not.toContain('`PROMA_IMAGE_ATTACHMENT` 标记')
    expect(withoutAutomation).toContain('6. **自检习惯**')
  })

  test('Pi composer 将低频 SOP 留给任务命中时注入，核心安全规则始终保留', () => {
    const basePrompt = buildSystemPrompt({
      workspaceName: 'Demo',
      workspaceSlug: 'demo-workspace',
      sessionId: 'session-123',
      permissionMode: 'auto',
      isPiRuntime: true,
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
    expect(ordinary).toContain('低风险、可逆的本地操作')
    expect(ordinary).toContain('修改后必须闭环')
    expect(ordinary).toContain('计划模式文件路径')
    expect(ordinary).not.toContain('## Profer 受管浏览器')
    expect(ordinary).not.toContain('PPT 视觉交付门禁')
    expect(ordinary).not.toContain('7. **定时任务**')
    expect(ordinary).not.toContain('## SubAgent 委派策略')
    expect(ordinary).not.toContain('### Pi Runtime 与文件记忆')
    // 普通本地任务应显著减去低频 SOP，而不是只做无意义的段落重排。
    expect(ordinary.length).toBeLessThan(basePrompt.length * 0.65)

    const webAndPpt = buildPiTaskPrompt({
      basePrompt,
      userMessage: '访问 https://example.com 并做成 pptx 幻灯片。',
      toolNames,
    })
    expect(webAndPpt).toContain('## Profer 受管浏览器')
    expect(webAndPpt).toContain('PPT 视觉交付门禁')
    expect(webAndPpt).not.toContain('7. **定时任务**')
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
