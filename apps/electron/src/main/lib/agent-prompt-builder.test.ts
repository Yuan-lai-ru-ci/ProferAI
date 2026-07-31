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
    expect(piPrompt).toContain('宁缺毋滥')
    expect(piPrompt).not.toContain('不要写入长期记忆文件')
    expect(claudePrompt).not.toContain('### Pi Runtime 自主执行准则')
  })
})
