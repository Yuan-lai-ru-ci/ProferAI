/**
 * 「关闭 Skill 后仍在配置页可见」的回归契约。
 *
 * 症状：用户关闭一个工作区 Skill 后，它被移到 skills-inactive/，重新扫描时
 * actualSource 从 'workspace' 变成 'none'。若分区按实际加载层过滤，该条目会同时被
 * 工作区 / 全局 / 内置三个分区排除，而列表总数仍 > 0，于是它从配置页彻底消失，
 * 用户再也无法打开或重新启用。
 *
 * 契约：分区只看身份（workspaceSkillId），actualSource 只影响「实际加载」等展示文案。
 */
import { describe, expect, test } from 'bun:test'
import type { SkillMeta } from '@profer/shared'
import {
  isBuiltinReferenceSkill,
  isGlobalReferenceSkill,
  isWorkspaceLocalSkill,
  partitionSkills,
  skillDirectoryPath,
  skillListKey,
  skillLocationLabel,
  skillToggleSourceId,
} from './skillListSections'

const enabledLocal: SkillMeta = {
  slug: 'local-demo',
  name: '本地演示',
  version: '1.0.0',
  enabled: true,
  actualSource: 'workspace',
  workspaceSkillId: 'ws-local-demo',
}

/** 同一个本地 Skill 被关闭后的扫描结果：搬到 skills-inactive/，actualSource 变 none。 */
const closedLocal: SkillMeta = {
  ...enabledLocal,
  enabled: false,
  actualSource: 'none',
}

/** 已关闭的「全局来源副本」：身份仍是 workspaceSkillId，不能被当成全局定义。 */
const closedGlobalCopy: SkillMeta = {
  slug: 'demo',
  name: '演示副本',
  version: '1.0.0',
  enabled: false,
  actualSource: 'none',
  workspaceSkillId: 'ws-copy-demo',
  sourceSkillId: 'builtin-demo',
  sourceSkillType: 'builtin-meta',
}

const globalDefinition: SkillMeta = {
  slug: 'release-check',
  name: '发布检查',
  version: '1.0.0',
  enabled: true,
  actualSource: 'global',
  sourceSkillId: 'user-global-release-check',
  sourceSkillType: 'user-global',
}

/** 已在该工作区关闭的全局定义：无 workspaceSkillId，属全局分区。 */
const disabledGlobalDefinition: SkillMeta = {
  ...globalDefinition,
  enabled: false,
  actualSource: 'none',
}

const builtinDefinition: SkillMeta = {
  slug: 'automation',
  name: '自动化',
  version: '1.0.0',
  enabled: true,
  actualSource: 'global',
  sourceSkillId: 'builtin-automation',
  sourceSkillType: 'builtin-meta',
}

describe('Skill 分区：已关闭的工作区副本不得消失', () => {
  test('Core 明确标记无稳定 ID 的历史本地 Skill，仍可进入详情', () => {
    const legacy: SkillMeta = { slug: 'old', name: '旧 Skill', enabled: false, actualSource: 'none', scope: 'workspace' }
    expect(partitionSkills([legacy]).workspaceSkills).toEqual([legacy])
    expect(skillListKey(legacy)).toBe('workspace:old')
  })

  test('关闭后仍归入「工作区 Skills」，只是 enabled 变 false', () => {
    const open = partitionSkills([enabledLocal])
    const closed = partitionSkills([closedLocal])

    expect(open.workspaceSkills.map((s) => s.slug)).toEqual(['local-demo'])
    expect(closed.workspaceSkills.map((s) => s.slug)).toEqual(['local-demo'])
    expect(closed.workspaceSkills[0]?.enabled).toBe(false)
  })

  test('已关闭的全局来源副本按身份留在工作区分区，不混进全局/内置分区', () => {
    const sections = partitionSkills([closedGlobalCopy])

    expect(sections.workspaceSkills.map((s) => s.slug)).toEqual(['demo'])
    expect(sections.globalSkills).toHaveLength(0)
    expect(sections.builtinSkills).toHaveLength(0)
  })

  test('没有任何条目会同时落进两个分区，也不会三者皆空而总数非零', () => {
    const skills = [
      enabledLocal,
      closedLocal,
      closedGlobalCopy,
      globalDefinition,
      disabledGlobalDefinition,
      builtinDefinition,
    ]
    const sections = partitionSkills(skills)
    const total =
      sections.workspaceSkills.length +
      sections.globalSkills.length +
      sections.builtinSkills.length

    expect(total).toBe(skills.length)
    expect(sections.workspaceSkills.map((s) => s.slug)).toEqual([
      'local-demo',
      'local-demo',
      'demo',
    ])
    expect(sections.globalSkills.map((s) => s.slug)).toEqual([
      'release-check',
      'release-check',
    ])
    expect(sections.builtinSkills.map((s) => s.slug)).toEqual(['automation'])
  })

  test('关闭的全局定义仍留在全局分区（由实际加载层决定 enabled 文案，不决定归属）', () => {
    expect(isGlobalReferenceSkill(disabledGlobalDefinition)).toBe(true)
    expect(isWorkspaceLocalSkill(disabledGlobalDefinition)).toBe(false)
  })

  test('内置判定只认来源类型，不把工作区副本当内置', () => {
    expect(isBuiltinReferenceSkill(builtinDefinition)).toBe(true)
    expect(isBuiltinReferenceSkill(closedGlobalCopy)).toBe(false)
  })
})

describe('Skill 身份与操作参数', () => {
  test('列表 key 按身份稳定：关闭后 key 不变，详情抽屉不会掉选择', () => {
    expect(skillListKey(enabledLocal)).toBe(skillListKey(closedLocal))
    expect(skillListKey(enabledLocal)).toBe('workspace:ws-local-demo')
    expect(skillListKey(closedGlobalCopy)).toBe('workspace:ws-copy-demo')
    expect(skillListKey(globalDefinition)).toBe('global:user-global-release-check')
  })

  test('关闭的副本重新启用必须走本地分支（空字符串），否则会误改同名全局定义', () => {
    expect(skillToggleSourceId(closedLocal)).toBe('')
    expect(skillToggleSourceId(closedGlobalCopy)).toBe('')
    expect(skillToggleSourceId(globalDefinition)).toBe(
      'user-global-release-check',
    )
  })

  test('打开目录指向真实位置：关闭的副本在 skills-inactive/', () => {
    expect(skillDirectoryPath(enabledLocal, '/ws/skills')).toBe(
      '/ws/skills/local-demo',
    )
    expect(skillDirectoryPath(closedLocal, '/ws/skills')).toBe(
      '/ws/skills/../skills-inactive/local-demo',
    )
    expect(skillDirectoryPath(closedLocal, '')).toBe('')
  })

  test('详情页位置行与实际落盘一致；全局引用不在本地目录，不假装是 filesystem 路径', () => {
    expect(skillLocationLabel(enabledLocal)).toBe('skills/local-demo')
    expect(skillLocationLabel(closedLocal)).toBe('skills-inactive/local-demo')
    expect(skillLocationLabel(globalDefinition)).toBe('—')
    expect(skillLocationLabel(builtinDefinition)).toBe('—')
  })
})
