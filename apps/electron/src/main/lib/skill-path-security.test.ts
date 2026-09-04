import { describe, expect, test } from 'bun:test'
import { assertSafeSkillSegment, canonicalSkillSegmentKey } from './skill-path-security'

describe('skill-path-security BDD', () => {
  test.each([
    'CON',
    'nul.md',
    'Com1',
    'COM¹.log',
    'LPT9.backup',
    'CONOUT$',
    'foo:bar',
    'foo<bar',
    'foo>bar',
    'foo"bar',
    'foo|bar',
    'foo?bar',
    'foo*bar',
    'foo.',
    'foo ',
  ])('Given Windows 不可移植名称 %s When 校验路径片段 Then 后端拒绝', (slug) => {
    expect(() => assertSafeSkillSegment(slug, 'Skill slug')).toThrow()
  })

  test('Given 大小写及 Unicode 组合形式不同的 slug When 生成唯一键 Then 视为同一 Skill', () => {
    expect(canonicalSkillSegmentKey('CAFÉ')).toBe(canonicalSkillSegmentKey('cafe\u0301'))
  })

  test.each(['release-check', 'Release.Check', '技能-审查', ' leading-space'])('Given 现有合法 slug %s When 校验 Then 保留原值', (slug) => {
    expect(assertSafeSkillSegment(slug, 'Skill slug')).toBe(slug)
  })
})
