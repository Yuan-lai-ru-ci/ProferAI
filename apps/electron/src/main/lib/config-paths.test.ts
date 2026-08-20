import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setBundledSkillsDirForTest,
  getDefaultSkillsDir,
  seedDefaultSkills,
} from './config-paths'

const roots: string[] = []
const originalConfigDir = process.env.PROFER_CONFIG_DIR

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-default-skills-'))
  roots.push(root)
  return root
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function writeBundledSkill(root: string, version: string, body = '内置正文'): string {
  const bundledDir = join(root, 'bundled')
  writeFile(
    join(bundledDir, 'test-skill', 'SKILL.md'),
    `---\nname: 测试 Skill\ndescription: 内置描述\nversion: ${version}\n---\n\n# 测试\n\n${body}\n`,
  )
  return bundledDir
}

function skillPath(): string {
  return join(getDefaultSkillsDir(), 'test-skill', 'SKILL.md')
}

function seedState(): { version: number; skills: Record<string, { owner: string; bundledHash?: string; bundledVersion?: string }> } {
  return JSON.parse(readFileSync(join(getDefaultSkillsDir(), '.seed-state.json'), 'utf-8'))
}

afterEach(() => {
  __setBundledSkillsDirForTest(undefined)
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('seedDefaultSkills', () => {
  test('Given 新安装 When 种子同步 Then 写入受管元 Skill 与内置基线', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.0'))

    seedDefaultSkills()

    expect(readFileSync(skillPath(), 'utf-8')).toContain('内置正文')
    const state = seedState()
    expect(state.skills['test-skill']).toMatchObject({ owner: 'managed', bundledVersion: '1.0.0' })
    expect(state.skills['test-skill']?.bundledHash).toBeTruthy()
  })

  test('Given 未改动的受管元 Skill When 内置版本升级 Then 自动替换', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.0', '旧内置正文'))
    seedDefaultSkills()

    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.1', '新内置正文'))
    seedDefaultSkills()

    expect(readFileSync(skillPath(), 'utf-8')).toContain('新内置正文')
    expect(seedState().skills['test-skill']).toMatchObject({ owner: 'managed', bundledVersion: '1.0.1' })
  })

  test('Given 用户仅修改 frontmatter When 内置版本升级 Then 不覆盖元 Skill', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.0', '旧内置正文'))
    seedDefaultSkills()
    writeFile(skillPath(), readFileSync(skillPath(), 'utf-8').replace('description: 内置描述', 'description: 用户自定义描述'))

    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.1', '新内置正文'))
    seedDefaultSkills()

    const content = readFileSync(skillPath(), 'utf-8')
    expect(content).toContain('description: 用户自定义描述')
    expect(content).toContain('旧内置正文')
    expect(seedState().skills['test-skill']).toMatchObject({ owner: 'user-owned' })
  })

  test('Given 用户修改 Skill 正文 When 内置版本升级 Then 不覆盖元 Skill', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.0', '旧内置正文'))
    seedDefaultSkills()
    writeFile(skillPath(), readFileSync(skillPath(), 'utf-8').replace('旧内置正文', '用户自定义正文'))

    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.1', '新内置正文'))
    seedDefaultSkills()

    expect(readFileSync(skillPath(), 'utf-8')).toContain('用户自定义正文')
    expect(seedState().skills['test-skill']).toMatchObject({ owner: 'user-owned' })
  })

  test('Given 用户添加附属文件 When 内置版本升级 Then 不覆盖整个元 Skill 目录', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.0', '旧内置正文'))
    seedDefaultSkills()
    writeFile(join(getDefaultSkillsDir(), 'test-skill', '用户说明.md'), '用户附加文件')

    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.1', '新内置正文'))
    seedDefaultSkills()

    expect(readFileSync(skillPath(), 'utf-8')).toContain('旧内置正文')
    expect(readFileSync(join(getDefaultSkillsDir(), 'test-skill', '用户说明.md'), 'utf-8')).toBe('用户附加文件')
    expect(seedState().skills['test-skill']).toMatchObject({ owner: 'user-owned' })
  })

  test('Given 引入机制前已有元 Skill When 内置版本更高 Then 保留并标记为用户拥有', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    writeFile(skillPath(), '---\nname: 旧用户 Skill\nversion: 0.1.0\n---\n\n用户原有正文\n')
    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.0', '新内置正文'))

    seedDefaultSkills()

    expect(readFileSync(skillPath(), 'utf-8')).toContain('用户原有正文')
    expect(seedState().skills['test-skill']).toEqual({ owner: 'user-owned' })

    __setBundledSkillsDirForTest(writeBundledSkill(root, '1.0.1', '更新后的内置正文'))
    seedDefaultSkills()
    expect(readFileSync(skillPath(), 'utf-8')).toContain('用户原有正文')
    expect(existsSync(skillPath())).toBe(true)
  })
})
