import { describe, expect, test } from 'bun:test'
import { buildPiAdditionalDirectoriesPrompt } from './pi-additional-directories-prompt'
import type { AttachedDirectoryProjectCandidate } from './attached-directory-project-detector'

describe('buildPiAdditionalDirectoriesPrompt', () => {
  test('为 Pi 注入用户授权的绝对目录', () => {
    const prompt = buildPiAdditionalDirectoriesPrompt([
      'C:\\Users\\alice\\.profer\\agent-workspaces\\profer',
      'C:\\Users\\alice\\.profer\\agent-workspaces\\profer\\workspace-files',
    ])

    expect(prompt).toContain('<attached_directories>')
    expect(prompt).toContain('请直接使用绝对路径')
    expect(prompt).toContain('<directory index="1">C:\\Users\\alice\\.profer\\agent-workspaces\\profer</directory>')
    expect(prompt).toContain('<directory index="2">C:\\Users\\alice\\.profer\\agent-workspaces\\profer\\workspace-files</directory>')
  })

  test('检测到项目时注入候选与任务路由规则', () => {
    const candidates: AttachedDirectoryProjectCandidate[] = [{
      rootPath: 'D:\\REPO\\AAAI学习大师',
      type: 'obsidian-vault',
      evidence: ['.obsidian/'],
      sourceDirectory: 'D:\\REPO',
      name: 'AAAI学习大师',
      relativePath: 'AAAI学习大师',
      packageName: 'aaai',
      repositoryRoot: 'D:\\REPO',
    }]

    const prompt = buildPiAdditionalDirectoriesPrompt(['D:\\REPO'], candidates)
    expect(prompt).toContain('<detected_project_candidates>')
    expect(prompt).toContain('- AAAI学习大师（obsidian-vault）：D:\\REPO\\AAAI学习大师，package=aaai，repo=D:\\REPO')
    expect(prompt).toContain('唯一语义匹配候选')
  })

  test('project 工作区：项目根是唯一权威，不再注入反推候选', () => {
    const candidates: AttachedDirectoryProjectCandidate[] = [{
      rootPath: 'D:\\REPO\\AAAI学习大师',
      type: 'obsidian-vault',
      evidence: ['.obsidian/'],
      sourceDirectory: 'D:\\REPO',
      name: 'AAAI学习大师',
      relativePath: 'AAAI学习大师',
    }]

    // project 下 cwd 就是项目根：附加目录只是授权范围，不得反推第二个“项目”引模型跑偏
    const prompt = buildPiAdditionalDirectoriesPrompt(['D:\\REPO'], candidates, { projectRoot: 'D:\\REPO\\REPO-A' })
    expect(prompt).not.toContain('<detected_project_candidates>')
    expect(prompt).toContain('<workspace_project_root>D:\\REPO\\REPO-A</workspace_project_root>')
    expect(prompt).toContain('当前 cwd 就是本项目根')
    expect(prompt).toContain('<attached_directories>')
  })

  test('空目录不增加 Pi 提示词', () => {
    expect(buildPiAdditionalDirectoriesPrompt([])).toBe('')
  })

  test('对 XML 特殊字符进行转义', () => {
    expect(buildPiAdditionalDirectoriesPrompt(['C:\\a&b<test>'])).toContain('C:\\a&amp;b&lt;test&gt;')
  })
})
