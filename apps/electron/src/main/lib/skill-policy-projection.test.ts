import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import { preparePolicyRuntimeSkills } from './global-skill-manager'
const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
test('策略投影先裁剪再提供 Claude/Pi，空集合不回退，源目录不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-policy-projection-'))
  roots.push(root)
  const sourcePath = join(root, 'source')
  const skills = ['alpha', 'beta'].map(slug => {
    const path = join(sourcePath, 'skills', slug)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), `---\nname: shared-name\ndescription: test\n---\nBODY_${slug}`)
    writeFileSync(join(path, 'resource.txt'), slug)
    return { slug, name: 'shared-name', version: '1', path, scope: 'workspace' as const, actualSource: 'workspace' as const }
  })
  const source = { path: sourcePath, skills, diagnostics: [] }
  const one = await preparePolicyRuntimeSkills(source, ['beta'])
  const none = await preparePolicyRuntimeSkills(source, [])
  expect(existsSync(join(one.path, 'skills', 'alpha'))).toBe(false)
  expect(parseFrontmatter<{ name: string }>(readFileSync(join(one.path, 'skills', 'beta', 'SKILL.md'), 'utf8')).frontmatter.name).toBe('beta')
  expect(readFileSync(join(one.path, 'skills', 'beta', 'resource.txt'), 'utf8')).toBe('beta')
  expect(one.skills.map(s => s.slug)).toEqual(['beta'])
  expect(none.skills).toEqual([])
  expect(existsSync(join(none.path, 'skills'))).toBe(true)
  expect(readFileSync(join(sourcePath, 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('name: shared-name')
  expect((await preparePolicyRuntimeSkills(source, ['beta'])).path).toBe(one.path)
})

test('引号 YAML key、block scalar 与 metadata 重写后仍可由 SDK 解析', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-policy-yaml-'))
  roots.push(root)
  const dir = join(root, 'skills', 'alpha')
  mkdirSync(dir, { recursive: true })
  const content = '---\n"name": old-name\ndescription: >\n  Multi line\n  description\nmetadata:\n  team: reports\ndisable-model-invocation: true\n---\nBODY_alpha\n'
  writeFileSync(join(dir, 'SKILL.md'), content)
  const result = await preparePolicyRuntimeSkills({ path: root, skills: [{ slug: 'alpha', name: 'old-name', path: dir, version: '1', scope: 'workspace', actualSource: 'workspace' }], diagnostics: [] }, ['alpha'])
  const parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(join(result.path, 'skills', 'alpha', 'SKILL.md'), 'utf8'))
  expect(parsed.frontmatter).toMatchObject({ name: 'alpha', metadata: { team: 'reports' }, 'disable-model-invocation': true })
  expect(parsed.frontmatter.description).toContain('Multi line')
  expect(parsed.body).toContain('BODY_alpha')
  expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(content)
})

test('投影把清单解析出的描述写回 frontmatter：模型看到的描述与路由用的是同一份', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-policy-description-'))
  roots.push(root)
  const dir = join(root, 'skills', 'alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: 正文里的旧描述\n---\nBODY_alpha\n')
  writeFileSync(join(dir, 'SKILL.json'), JSON.stringify({ schemaVersion: 1, interface: { shortDescription: '清单短描述' } }))
  const result = await preparePolicyRuntimeSkills({ path: root, skills: [{ slug: 'alpha', name: 'alpha', path: dir, version: '1', scope: 'workspace', actualSource: 'workspace' }], diagnostics: [] }, ['alpha'])
  const projected = parseFrontmatter<{ description: string }>(readFileSync(join(result.path, 'skills', 'alpha', 'SKILL.md'), 'utf8'))
  expect(projected.frontmatter.description).toBe('清单短描述')
  expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('正文里的旧描述')
})
