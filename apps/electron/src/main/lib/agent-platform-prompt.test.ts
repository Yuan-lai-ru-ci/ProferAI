import { describe, expect, test } from 'bun:test'
import { buildAgentPlatformPrompt } from './agent-platform-prompt'

describe('agent platform prompt overlay', () => {
  const candidates = [{
    rootPath: '/Users/mac/profer/profer-main',
    name: 'proma',
    type: 'git-repository',
    packageName: 'proma',
    gitRemote: 'https://github.com/Yuan-lai-ru-ci/ProferAI.git',
  }]

  test('macOS overlay describes the real POSIX shell and rejects Windows-only commands', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      shellPath: '/bin/zsh',
      agentCwd: '/Users/mac/.profer/agent-workspaces/profer/session-1',
      projectCandidates: candidates,
      isPiRuntime: true,
    })

    expect(prompt).toContain('当前平台：macOS（darwin）')
    expect(prompt).toContain('当前 Agent shell：/bin/zsh')
    expect(prompt).toContain('当前执行环境是 POSIX shell')
    expect(prompt).toContain('不要把其他操作系统的命令')
    expect(prompt).toContain('/Users/mac/profer/profer-main')
    expect(prompt).toContain('不要默认仓库根目录存在 `src`')
    expect(prompt).toContain('path + edits[].oldText/newText')
    expect(prompt).toContain('不要把多个检查拼成含 `;` 的复合命令')
    expect(prompt).not.toContain('当前平台：Windows')
  })

  test('Windows overlay describes detected shell choices and rejects macOS assumptions', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'win32',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      agentCwd: 'C:\\Users\\alice\\session-1',
      projectCandidates: [{ rootPath: 'D:\\repo', name: 'repo', type: 'git-repository' }],
      isPiRuntime: false,
    })

    expect(prompt).toContain('当前平台：Windows（win32）')
    expect(prompt).toContain('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(prompt).toContain('只使用运行时实际提供的 Windows shell 和路径格式')
    expect(prompt).toContain('严格遵循其返回值')
    expect(prompt).toContain('file_path + old_string/new_string')
    expect(prompt).not.toContain('当前平台：macOS')
  })
})
