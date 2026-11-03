/**
 * createProferSkillsOverride 语义测试
 *
 * 覆盖 skillSlugs 三种语义（三层一致的关键一环）：
 * - undefined = 不裁剪（全量注入）
 * - [] = 明确 0 个 skill（全部隐藏）
 * - 非空 = 白名单（只留列出的）
 * 同时验证：不在工作区 skill 根目录内的 skill 一律过滤（路径守卫不变）。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { createProferSkillsOverride, preparePromptWithProferSkills } from './pi-agent-adapter'

let skillsRoot: string
let realSkillsRoot: string
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
  mkdirSync(join(skillsRoot, 'profer-coach'), { recursive: true })
  realSkillsRoot = mkdtempSync(join(tmpdir(), 'profer-real-skill-loader-'))
  for (const slug of ['same-a', 'same-b', 'ambiguous', 'ambiguous-copy']) {
    mkdirSync(join(realSkillsRoot, slug), { recursive: true })
  }
  writeFileSync(join(realSkillsRoot, 'same-a', 'SKILL.md'), '---\nname: shared\ndescription: same a\n---\nA')
  writeFileSync(join(realSkillsRoot, 'same-b', 'SKILL.md'), '---\nname: shared\ndescription: same b\n---\nB')
  writeFileSync(join(realSkillsRoot, 'ambiguous', 'SKILL.md'), '---\nname: alias\ndescription: ambiguous\n---\nA')
  writeFileSync(join(realSkillsRoot, 'ambiguous-copy', 'SKILL.md'), '---\nname: alias\ndescription: ambiguous copy\n---\nB')
  alpha = makeSkill('alpha', skillsRoot)
  beta = makeSkill('beta', skillsRoot)
  outside = { ...makeSkill('outside', join(tmpdir(), 'profer-skill-outside-root')), name: 'alpha' }
})

afterAll(() => {
  rmSync(skillsRoot, { recursive: true, force: true })
  rmSync(realSkillsRoot, { recursive: true, force: true })
})

describe('createProferSkillsOverride skillSlugs 语义', () => {
  test('skillSlugs=undefined 时不裁剪（全量注入）', () => {
    const override = createProferSkillsOverride([skillsRoot], undefined)
    const result = override(makeBase([alpha, beta]))
    expect(result.skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta'])
  })

  test('skillSlugs=[] 时 0 个 skill（全部隐藏）', () => {
    const override = createProferSkillsOverride([skillsRoot], [])
    const result = override(makeBase([alpha, beta]))
    expect(result.skills).toEqual([])
  })

  test('skillSlugs 非空时只保留白名单内的 skill', () => {
    const override = createProferSkillsOverride([skillsRoot], ['alpha'])
    const result = override(makeBase([alpha, beta]))
    expect(result.skills.map((s) => s.name)).toEqual(['alpha'])
  })

  test('根目录之外的 skill 即使白名单命中也被路径守卫过滤', () => {
    const override = createProferSkillsOverride([skillsRoot], ['alpha'])
    const result = override(makeBase([alpha, outside]))
    expect(result.skills.map((s) => s.name)).toEqual(['alpha'])
  })

  test('synthetic fixture 的 name 不能扩宽规范目录白名单', () => {
    const namedAlpha = { ...beta, name: 'alpha' }
    expect(createProferSkillsOverride([skillsRoot], ['alpha'])(makeBase([namedAlpha])).skills).toEqual([])
  })
})

async function makeLoader(slugs?: string[], sdkLoadsRoot = true) {
  const { DefaultResourceLoader, SettingsManager, loadSkillsFromDir } = await import('@earendil-works/pi-coding-agent')
  return new DefaultResourceLoader({
    cwd: realSkillsRoot,
    agentDir: join(realSkillsRoot, '.agent'),
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true, appendSystemPrompt: [],
    additionalSkillPaths: sdkLoadsRoot
      ? ['same-a', 'same-b', 'ambiguous', 'ambiguous-copy'].map((slug) => join(realSkillsRoot, slug))
      : [],
    skillsOverride: createProferSkillsOverride([realSkillsRoot], slugs, loadSkillsFromDir),
  })
}

describe('真实 DefaultResourceLoader Skill 门禁', () => {
  test('SDK 基线按 name 吞掉后加载目录，受管 override 恢复仅允许项', async () => {
    const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent')
    const raw = new DefaultResourceLoader({
      cwd: realSkillsRoot, agentDir: join(realSkillsRoot, '.agent'),
      settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
      noContextFiles: true, noThemes: true, noPromptTemplates: true, appendSystemPrompt: [],
      additionalSkillPaths: ['same-a', 'same-b'].map((slug) => join(realSkillsRoot, slug)),
    })
    await raw.reload()
    expect(raw.getSkills().skills.map((skill) => skill.name)).toEqual(['shared'])
    expect(raw.getSkills().skills[0]?.filePath).toBe(join(realSkillsRoot, 'same-a', 'SKILL.md'))
    expect(raw.getSkills().diagnostics.some((item) => item.type === 'collision')).toBe(true)
    const filtered = await makeLoader(['same-b'])
    await filtered.reload()
    expect(filtered.getSkills().skills.map((skill) => skill.name)).toEqual(['same-b'])
  })

  test('同 name 的允许目录从 SDK 去重结果恢复', async () => {
    const loader = await makeLoader(['same-b'])
    await loader.reload()
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(['same-b'])
    expect(loader.getSkills().skills[0]?.filePath).toBe(join(realpathSync(realSkillsRoot), 'same-b', 'SKILL.md'))
    expect(JSON.stringify(loader.getSkills())).not.toContain('same a')
    expect(JSON.stringify(loader.getSkills().diagnostics)).not.toContain('same-a')
  })

  test('全量加载时目录 slug 唯一，同 name 的两个目录都保留', async () => {
    const loader = await makeLoader()
    await loader.reload()
    expect(loader.getSkills().skills.map((skill) => skill.name).sort())
      .toEqual(['ambiguous', 'ambiguous-copy', 'same-a', 'same-b'])
  })

  test('受管 adapter 仅 override 加载根目录，也保留真实 SDK loader 行为', async () => {
    const loader = await makeLoader(['same-b'], false)
    await loader.reload()
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(['same-b'])
  })

  test('SDK name alias 歧义时关闭，并输出无路径诊断', async () => {
    const loader = await makeLoader(['alias'])
    await loader.reload()
    expect(loader.getSkills().skills).toEqual([])
    expect(loader.getSkills().diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(loader.getSkills().diagnostics)).not.toContain(realSkillsRoot)
  })

  test('显式空引用不从 enriched prompt 扫描，undefined 保持旧扫描', async () => {
    const loader = await makeLoader(['same-b'])
    const prompt = '历史模板里有 /skill:same-b，当前用户只说你好'
    expect(await preparePromptWithProferSkills(loader, prompt, [])).toBe(prompt)
    expect(await preparePromptWithProferSkills(loader, prompt)).toContain('<skill name="same-b"')
  })

  test('同 label 显式展开两个 canonical slug，不按 name 吞掉其一', async () => {
    const loader = await makeLoader(['same-a', 'same-b'])
    const prompt = await preparePromptWithProferSkills(loader, '你好', ['same-a', 'same-b'])
    expect(prompt).toContain('<skill name="same-a"')
    expect(prompt).toContain('<skill name="same-b"')
  })

  test('歧义与不存在引用返回安全诊断，普通任务仍保留', async () => {
    const loader = await makeLoader()
    const prompt = await preparePromptWithProferSkills(loader, '继续任务', ['alias', 'missing'])
    expect(prompt).toContain('Skill 引用')
    expect(prompt).toContain('继续任务')
    expect(prompt).not.toContain(realSkillsRoot)
    expect(prompt).not.toContain('<skill name=')
  })
})
