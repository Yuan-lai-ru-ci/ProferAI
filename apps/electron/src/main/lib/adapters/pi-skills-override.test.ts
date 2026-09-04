/**
 * createPromaSkillsOverride 语义测试
 *
 * 覆盖 skillSlugs 三种语义（三层一致的关键一环）：
 * - undefined = 不裁剪（全量注入）
 * - [] = 明确 0 个 skill（全部隐藏）
 * - 非空 = 白名单（只留列出的）
 * 同时验证：不在工作区 skill 根目录内的 skill 一律过滤（路径守卫不变）。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { createPromaSkillsOverride } from './pi-agent-adapter'

let skillsRoot: string
let alpha: Skill
let beta: Skill
let outside: Skill

function makeSkill(slug: string, root: string): Skill {
  const baseDir = join(root, slug)
  return {
    name: slug,
    description: `skill ${slug}`,
    filePath: join(baseDir, 'SKILL.md'),
    baseDir,
    sourceInfo: {
      path: baseDir,
      source: 'test',
      scope: 'temporary',
      origin: 'top-level',
    },
    disableModelInvocation: false,
  }
}

function makeBase(skills: Skill[]) {
  return { skills, diagnostics: [] }
}

beforeAll(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), 'profer-skill-override-'))
  // 真实创建目录，确保 buildAllowedSkillRoots 的 realpath 能解析
  mkdirSync(join(skillsRoot, 'alpha'), { recursive: true })
  mkdirSync(join(skillsRoot, 'beta'), { recursive: true })
  mkdirSync(join(skillsRoot, 'proma-coach'), { recursive: true })
  mkdirSync(join(skillsRoot, 'profer-coach'), { recursive: true })
  alpha = makeSkill('alpha', skillsRoot)
  beta = makeSkill('beta', skillsRoot)
  // 根目录之外的 skill：即使白名单命中也被路径守卫过滤
  outside = { ...makeSkill('outside', join(tmpdir(), 'profer-skill-outside-root')), name: 'alpha' }
})

afterAll(() => {
  rmSync(skillsRoot, { recursive: true, force: true })
})

describe('createPromaSkillsOverride skillSlugs 语义', () => {
  test('skillSlugs=undefined 时不裁剪（全量注入）', () => {
    const override = createPromaSkillsOverride([skillsRoot], undefined)
    const result = override(makeBase([alpha, beta]))
    expect(result.skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
  })

  test('skillSlugs=[] 时 0 个 skill（全部隐藏）', () => {
    const override = createPromaSkillsOverride([skillsRoot], [])
    const result = override(makeBase([alpha, beta]))
    expect(result.skills).toEqual([])
  })

  test('skillSlugs 非空时只保留白名单内的 skill', () => {
    const override = createPromaSkillsOverride([skillsRoot], ['alpha'])
    const result = override(makeBase([alpha, beta]))
    expect(result.skills.map((s) => s.name)).toEqual(['alpha'])
  })

  test('根目录之外的 skill 即使白名单命中也被路径守卫过滤', () => {
    const override = createPromaSkillsOverride([skillsRoot], ['alpha'])
    const result = override(makeBase([alpha, outside]))
    expect(result.skills.map((s) => s.name)).toEqual(['alpha'])
  })

  test('历史 Coach 白名单解析为新 slug，且新旧目录并存时只注入新副本', () => {
    const legacyCoach = makeSkill('proma-coach', skillsRoot)
    const currentCoach = makeSkill('profer-coach', skillsRoot)
    const override = createPromaSkillsOverride([skillsRoot], ['proma-coach'])
    const result = override(makeBase([legacyCoach, currentCoach]))
    expect(result.skills.map((s) => s.name)).toEqual(['profer-coach'])
  })
})
