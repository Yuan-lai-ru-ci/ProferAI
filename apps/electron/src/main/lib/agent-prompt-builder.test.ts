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
})
