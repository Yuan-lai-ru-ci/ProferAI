import { describe, expect, test } from 'bun:test'
import { buildPiAdditionalDirectoriesPrompt } from './pi-additional-directories-prompt'
import type { AttachedDirectoryProjectCandidate } from './attached-directory-project-detector'

describe('buildPiAdditionalDirectoriesPrompt', () => {
  test('为 Pi 注入用户授权的绝对目录', () => {
    const prompt = buildPiAdditionalDirectoriesPrompt([
      'C:\\Users\\yuan\\.profer\\agent-workspaces\\profer',
      'C:\\Users\\yuan\\.profer\\agent-workspaces\\profer\\workspace-files',
    ])

    expect(prompt).toContain('<attached_directories>')
    expect(prompt).toContain('请直接使用绝对路径')
    expect(prompt).toContain('<directory index="1">C:\\Users\\yuan\\.profer\\agent-workspaces\\profer</directory>')
    expect(prompt).toContain('<directory index="2">C:\\Users\\yuan\\.profer\\agent-workspaces\\profer\\workspace-files</directory>')
  })

  test('检测到项目时注入候选与任务路由规则', () => {
    const candidates: AttachedDirectoryProjectCandidate[] = [{
      rootPath: 'D:\\REPO\\AAAI学习大师',
      type: 'obsidian-vault',
      evidence: ['.obsidian/'],
      sourceDirectory: 'D:\\REPO',
      name: 'AAAI学习大师',
      relativePath: 'AAAI学习大师',
    }]

    const prompt = buildPiAdditionalDirectoriesPrompt(['D:\\REPO'], candidates)
    expect(prompt).toContain('<detected_project_candidates>')
    expect(prompt).toContain('<root>D:\\REPO\\AAAI学习大师</root>')
    expect(prompt).toContain('<type>obsidian-vault</type>')
    expect(prompt).toContain('<name>AAAI学习大师</name>')
    expect(prompt).toContain('<relative_to_attached_directory>AAAI学习大师</relative_to_attached_directory>')
    expect(prompt).toContain('repository_root')
    expect(prompt).toContain('唯一语义匹配候选')
  })

  test('空目录不增加 Pi 提示词', () => {
    expect(buildPiAdditionalDirectoriesPrompt([])).toBe('')
  })

  test('对 XML 特殊字符进行转义', () => {
    expect(buildPiAdditionalDirectoriesPrompt(['C:\\a&b<test>'])).toContain('C:\\a&amp;b&lt;test&gt;')
  })
})
