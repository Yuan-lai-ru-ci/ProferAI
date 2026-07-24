import { describe, expect, test } from 'bun:test'
import { buildPiAdditionalDirectoriesPrompt } from './pi-additional-directories-prompt'

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

  test('空目录不增加 Pi 提示词', () => {
    expect(buildPiAdditionalDirectoriesPrompt([])).toBe('')
  })

  test('对 XML 特殊字符进行转义', () => {
    expect(buildPiAdditionalDirectoriesPrompt(['C:\\a&b<test>'])).toContain('C:\\a&amp;b&lt;test&gt;')
  })
})
