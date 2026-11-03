import { describe, expect, test } from 'bun:test'
import { buildAgentPlatformPrompt } from './agent-platform-prompt'

describe('agent platform prompt overlay', () => {
  const candidates = [{
    rootPath: '/Users/alice/project',
    name: 'profer',
    type: 'git-repository',
    packageName: 'profer',
    gitRemote: 'https://github.com/Yuan-lai-ru-ci/ProferAI.git',
  }]

  test('macOS overlay describes the real POSIX shell and rejects Windows-only commands', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      shellPath: '/bin/zsh',
      agentCwd: '/Users/alice/.profer/agent-workspaces/profer/session-1',
      projectCandidates: candidates,
      isPiRuntime: true,
    })

    expect(prompt).toContain('当前平台：macOS（darwin）')
    expect(prompt).toContain('当前 Agent shell：/bin/zsh')
    expect(prompt).toContain('当前执行环境是 POSIX shell')
    expect(prompt).toContain('不要把其他操作系统的命令')
    expect(prompt).toContain('/Users/alice/project')
    expect(prompt).toContain('不要默认仓库根目录存在 `src`')
    expect(prompt).toContain('path + edits[].oldText/newText')
    expect(prompt).toContain('不要把多个检查拼成含 `;` 的复合命令')
    expect(prompt).not.toContain('当前平台：Windows')
  })

  test('Pi macOS overlay reports shell_not_found instead of claiming zsh when Bash is unavailable', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      agentCwd: '/Users/alice/session-1',
      isPiRuntime: true,
    })

    expect(prompt).toContain('当前 Agent shell：Bash 不可用（shell_not_found）')
    expect(prompt).toContain('不要改用 zsh/sh 猜测执行')
    expect(prompt).not.toContain('当前 Agent shell：/bin/zsh')
  })

  test('project 模式反转「cwd 不是项目 root」，并说明候选中的 cwd 就是本项目', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      shellPath: '/bin/zsh',
      agentCwd: '/Users/alice/profer',
      projectCandidates: candidates,
      isPiRuntime: true,
      workspaceMode: 'project',
    })

    expect(prompt).toContain('当前 Agent cwd：/Users/alice/profer；**这就是项目根**')
    expect(prompt).toContain('相对路径直接落在项目里')
    expect(prompt).not.toContain('cwd 不是项目 root')
    expect(prompt).toContain('与当前 cwd 相同的那条就是本项目，直接以 cwd 为 root，不要再切换')
    // 平台事实仍然保留
    expect(prompt).toContain('当前平台：macOS（darwin）')
    expect(prompt).toContain('path + edits[].oldText/newText')
  })

  test('project 模式没有候选时不再声称「当前没有项目候选」', () => {
    const prompt = buildAgentPlatformPrompt({
      platform: 'darwin',
      agentCwd: '/Users/alice/profer',
      projectCandidates: [],
      workspaceMode: 'project',
    })

    expect(prompt).toContain('当前 cwd 就是项目根，不需要再探测其他项目候选')
    expect(prompt).not.toContain('当前没有由 Profer 探测到的项目候选')
  })

  test('managed（默认）保持「cwd 不是项目 root」文案不变', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const prompt = buildAgentPlatformPrompt({ platform, agentCwd: '/Users/alice/session-1' })
      expect(prompt).not.toContain('这就是项目根')
    }
    const darwin = buildAgentPlatformPrompt({ platform: 'darwin', shellPath: '/bin/zsh', agentCwd: '/Users/alice/session-1' })
    expect(darwin).toContain('- 当前 Agent cwd：/Users/alice/session-1。cwd 不是项目 root；不要默认仓库根目录存在 `src`，先检查实际目录树。')
    expect(darwin).toContain('- 当前没有由 Profer 探测到的项目候选；先检查实际目录树，再决定要操作的 root。')
    const linux = buildAgentPlatformPrompt({ platform: 'linux', shellPath: '/bin/sh', agentCwd: '/home/alice/session-1' })
    expect(linux).toContain('- 当前 Agent cwd：/home/alice/session-1；先确认实际项目 root，不要默认存在根级 `src`。')
    const win = buildAgentPlatformPrompt({ platform: 'win32', agentCwd: 'C:\\Users\\alice\\session-1' })
    expect(win).toContain('。cwd 不是项目 root；不要因为 cwd 存在就猜测 `src` 或测试文件位置。')
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
