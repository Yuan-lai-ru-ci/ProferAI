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
  const root = mkdtempSync(join(tmpdir(), 'profer-coach-slug-migration-'))
  roots.push(root)
  return root
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function writeBundledCoach(root: string, slug: string, version: string, body: string): string {
  const bundledDir = join(root, `bundled-${slug}-${version}`)
  writeFile(join(bundledDir, slug, 'SKILL.md'), `---\nname: ${slug}\nversion: ${version}\n---\n\n${body}\n`)
  return bundledDir
}

function seedState(): { skills: Record<string, { owner: string; bundledVersion?: string }> } {
  return JSON.parse(readFileSync(join(getDefaultSkillsDir(), '.seed-state.json'), 'utf-8'))
}

afterEach(() => {
  __setBundledSkillsDirForTest(undefined)
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('default Skill slug migration', () => {
  test('migrates proma-coach master Skill, history, and managed seed state to profer-coach', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    __setBundledSkillsDirForTest(writeBundledCoach(root, 'proma-coach', '1.0.1', '旧正文'))
    seedDefaultSkills()
    writeFile(join(root, 'config', 'default-skills-history', 'proma-coach', 'v1', 'SKILL.md'), '旧快照')
    __setBundledSkillsDirForTest(writeBundledCoach(root, 'profer-coach', '1.0.2', '新版正文'))

    seedDefaultSkills()

    const masterDir = getDefaultSkillsDir()
    expect(existsSync(join(masterDir, 'proma-coach'))).toBe(false)
    expect(readFileSync(join(masterDir, 'profer-coach', 'SKILL.md'), 'utf-8')).toContain('新版正文')
    expect(existsSync(join(root, 'config', 'default-skills-history', 'profer-coach', 'v1', 'SKILL.md'))).toBe(true)
    expect(seedState().skills['proma-coach']).toBeUndefined()
    expect(seedState().skills['profer-coach']).toMatchObject({ owner: 'managed', bundledVersion: '1.0.2' })
  })

  test('preserves both master Skills when the renamed target already exists', () => {
    const root = makeRoot()
    process.env.PROFER_CONFIG_DIR = join(root, 'config')
    const masterDir = getDefaultSkillsDir()
    writeFile(join(masterDir, 'proma-coach', 'SKILL.md'), '旧用户副本')
    writeFile(join(masterDir, 'profer-coach', 'SKILL.md'), '新用户副本')
    __setBundledSkillsDirForTest(writeBundledCoach(root, 'profer-coach', '1.0.2', '新版正文'))

    seedDefaultSkills()

    expect(readFileSync(join(masterDir, 'proma-coach', 'SKILL.md'), 'utf-8')).toBe('旧用户副本')
    expect(readFileSync(join(masterDir, 'profer-coach', 'SKILL.md'), 'utf-8')).toBe('新用户副本')
  })
})
