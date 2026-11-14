import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock } from '@profer/shared'
import { buildProcessGroupToolBadges } from './ProcessBlockGroup'
import { extractSkillNameFromRead } from './tool-utils'
import { getToolPhrase } from './tool-phrase'

const tool = (
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): SDKContentBlock => ({ type: 'tool_use', id, name, input })

describe('Pi Runtime 的 Skill 识别', () => {
  test('Given 读取 workspace 下的 SKILL.md When 识别 Then 取出 Skill 目录名', () => {
    const path = '/Users/mac/.profer/agent-workspaces/profer/skills/profer-coach/SKILL.md'
    expect(extractSkillNameFromRead('Read', { file_path: path })).toBe('profer-coach')
  })

  test('Given Pi 小写工具名 When 识别 Then 与 PascalCase 等价', () => {
    const input = { path: '/w/skills/ui-ux-design-system/SKILL.md' }
    expect(extractSkillNameFromRead('read', input)).toBe('ui-ux-design-system')
  })

  test('Given Windows 反斜杠路径 When 识别 Then 仍能取出目录名', () => {
    const input = { filePath: 'C:\\ws\\skills\\code-honor\\SKILL.md' }
    expect(extractSkillNameFromRead('Read', input)).toBe('code-honor')
  })

  test('Given 读取普通文件 When 识别 Then 不产生 Skill', () => {
    expect(extractSkillNameFromRead('Read', { file_path: '/repo/src/index.ts' })).toBeNull()
    expect(extractSkillNameFromRead('Read', { file_path: '/repo/notes/SKILL.md' })).toBeNull()
    expect(extractSkillNameFromRead('Read', {})).toBeNull()
  })

  test('Given 非读取类工具 When 识别 Then 不产生 Skill', () => {
    const input = { file_path: '/w/skills/profer-coach/SKILL.md' }
    expect(extractSkillNameFromRead('Write', input)).toBeNull()
    expect(extractSkillNameFromRead('Bash', input)).toBeNull()
  })

  test('Given 读取 Skill 正文 When 生成短语 Then 说明是哪个 Skill', () => {
    const phrase = getToolPhrase('Read', {
      file_path: '/w/skills/present-visualization/SKILL.md',
    })
    expect(phrase.label).toBe('加载 Skill「present-visualization」')
    expect(phrase.loadingLabel).toBe('正在加载 Skill「present-visualization」...')
  })

  test('Given 普通文件读取 When 生成短语 Then 维持原有行为', () => {
    expect(getToolPhrase('Read', { file_path: '/src/a.ts' }).label).toBe('读取 a.ts')
  })
})

describe('折叠摘要行的工具徽标', () => {
  test('Given 读取两个不同 Skill When 构建徽标 Then 每个 Skill 各占一个闪电徽标', () => {
    const badges = buildProcessGroupToolBadges([
      tool('t1', 'read', { path: '/w/skills/profer-coach/SKILL.md' }),
      tool('t2', 'read', { path: '/w/skills/profer-coach/SKILL.md' }),
      tool('t3', 'read', { path: '/w/skills/present-visualization/SKILL.md' }),
      tool('t4', 'bash', { command: 'ls' }),
    ])

    expect(badges.map((badge) => badge.key)).toEqual([
      'Skill:profer-coach',
      'Skill:present-visualization',
      'bash',
    ])
    expect(badges[0]?.label).toBe('使用技能：profer-coach')
  })

  test('Given 同一工具重复出现 When 构建徽标 Then 仅保留一个', () => {
    const badges = buildProcessGroupToolBadges([
      tool('t1', 'Grep'),
      tool('t2', 'Grep'),
      tool('t3', 'Read', { file_path: '/src/a.ts' }),
    ])

    expect(badges.map((badge) => badge.key)).toEqual(['Grep', 'Read'])
  })

  test('Given Goal 工具 When 构建徽标 Then 按既有约定忽略', () => {
    const badges = buildProcessGroupToolBadges([
      tool('t1', 'update_goal'),
      tool('t2', 'propose_goal'),
      tool('t3', 'Grep'),
    ])

    expect(badges.map((badge) => badge.key)).toEqual(['Grep'])
  })
})
