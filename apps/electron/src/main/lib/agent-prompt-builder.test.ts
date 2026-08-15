import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from './agent-prompt-builder'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getConfigDirName } from './config-paths'

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
    expect(piPrompt).toContain('不要等待 SDK 自动落盘')
    expect(piPrompt).toContain('可以读取和写入')
    expect(piPrompt).toContain('`.claude/memory/MEMORY.md`')
    expect(piPrompt).toContain('收尾回写')
    expect(piPrompt).toContain('单次弱信号、临时过程和未经验证的推断不要写入')
    expect(piPrompt).not.toContain('不要写入长期记忆文件')
    expect(claudePrompt).not.toContain('### Pi Runtime 自主执行准则')
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
})
