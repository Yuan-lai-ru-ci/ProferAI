/**
 * 模块清单读取与元数据优先级的契约。
 *
 * 钉死两件事：① 目录名才是 slug 权威，清单不能把 Skill 指向别的位置；② 清单坏了不阻断加载，
 * frontmatter 继续生效，问题以诊断形式返回（Skill 不能被清单问题挡在门外）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillVersion } from './config-paths'
import {
  clearSkillManifest,
  MAX_SKILL_MANIFEST_BYTES,
  readSkillDescriptor,
  readSkillFrontmatterFields,
  readSkillManifest,
  readSkillVersion,
  resolveSkillDescriptor,
  writeSkillManifest,
} from './skill-manifest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function skillDir(name: string, files: { skillMd?: string; manifest?: unknown | string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-skill-manifest-'))
  roots.push(root)
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), files.skillMd ?? '---\nname: demo\ndescription: 用于演示\nversion: "1.0.0"\n---\n正文\n')
  if (files.manifest !== undefined) {
    writeFileSync(join(dir, 'SKILL.json'), typeof files.manifest === 'string' ? files.manifest : JSON.stringify(files.manifest))
  }
  return dir
}

describe('Skill 清单：读取', () => {
  test('合法清单被读取；不存在时 present=false 且不产诊断', () => {
    const withManifest = readSkillManifest(skillDir('demo', { manifest: { schemaVersion: 1, version: '2.0.0' } }))
    expect(withManifest.present).toBe(true)
    expect(withManifest.manifest?.version).toBe('2.0.0')
    expect(withManifest.issues).toEqual([])

    const without = readSkillManifest(skillDir('demo'))
    expect(without.present).toBe(false)
    expect(without.manifest).toBeUndefined()
    expect(without.issues).toEqual([])
  })

  test('JSON 损坏、超预算、软链越界都只产诊断，frontmatter 仍可用', () => {
    const broken = readSkillManifest(skillDir('demo', { manifest: '{ not json' }))
    expect(broken.present).toBe(true)
    expect(broken.manifest).toBeUndefined()
    expect(broken.issues[0]?.code).toBe('invalid-field')

    const huge = readSkillManifest(skillDir('demo', { manifest: JSON.stringify({ schemaVersion: 1, padding: 'x'.repeat(MAX_SKILL_MANIFEST_BYTES) }) }))
    expect(huge.issues[0]?.message).toContain('超过')
    expect(huge.manifest).toBeUndefined()

    const skill = skillDir('demo')
    const outside = skillDir('outside', { manifest: { schemaVersion: 1, version: '9.9.9' } })
    symlinkSync(join(outside, 'SKILL.json'), join(skill, 'SKILL.json'))
    const escaped = readSkillManifest(skill)
    expect(escaped.issues[0]?.code).toBe('unsafe-path')
    expect(escaped.manifest).toBeUndefined()
  })
})

describe('Skill 清单：元数据优先级', () => {
  test('清单优先、frontmatter 回退，来源被标注', () => {
    const dir = skillDir('demo', {
      manifest: { schemaVersion: 1, name: 'manifest-name', version: '2.1.0', interface: { displayName: '展示名', shortDescription: '清单短描述' } },
    })
    const read = readSkillDescriptor(dir)
    expect(read.descriptor.name).toBe('manifest-name')
    expect(read.descriptor.displayName).toBe('展示名')
    expect(read.descriptor.description).toBe('清单短描述')
    expect(read.descriptor.version).toBe('2.1.0')
    expect(read.descriptor.sources).toEqual({ name: 'manifest', description: 'manifest', version: 'manifest' })

    const fallback = readSkillDescriptor(skillDir('demo'))
    expect(fallback.descriptor.name).toBe('demo')
    expect(fallback.descriptor.description).toBe('用于演示')
    expect(fallback.descriptor.version).toBe('1.0.0')
    expect(fallback.descriptor.sources).toEqual({ name: 'frontmatter', description: 'frontmatter', version: 'frontmatter' })
  })

  test('目录名是 slug 权威，清单只能声明（不一致由 doctor 报）', () => {
    const dir = skillDir('demo', { manifest: { schemaVersion: 1, slug: 'another' } })
    const { descriptor } = readSkillDescriptor(dir)
    expect(descriptor.slug).toBe('demo')
    expect(descriptor.declaredSlug).toBe('another')
  })

  test('纯函数优先级：无 frontmatter、无清单时落到目录名与 0.0.0', () => {
    const descriptor = resolveSkillDescriptor({ dirName: 'demo' })
    expect(descriptor.slug).toBe('demo')
    expect(descriptor.name).toBe('demo')
    expect(descriptor.description).toBe('')
    expect(descriptor.version).toBe('0.0.0')
    expect(descriptor.sources).toEqual({ name: 'directory', description: 'none', version: 'default' })
  })

  test('版本解析：清单 > frontmatter > 0.0.0，且与 config-paths 的 parseSkillVersion 一致', () => {
    const manifestOnly = skillDir('demo', { manifest: { schemaVersion: 1, version: '3.0.0' } })
    expect(readSkillVersion(manifestOnly)).toBe('3.0.0')
    expect(parseSkillVersion(manifestOnly)).toBe('3.0.0')

    const frontmatterOnly = skillDir('demo')
    expect(readSkillVersion(frontmatterOnly)).toBe('1.0.0')
    expect(parseSkillVersion(frontmatterOnly)).toBe('1.0.0')

    const none = skillDir('demo', { skillMd: '---\nname: demo\ndescription: 用于演示\n---\n正文\n' })
    expect(readSkillVersion(none)).toBe('0.0.0')
  })
})

describe('Skill 清单：frontmatter 最小读取', () => {
  test('BOM / CRLF 兼容，嵌套缩进行不误读为顶层字段', () => {
    const dir = skillDir('demo', {
      skillMd: '\uFEFF---\r\nname: demo\r\ndescription: 用于演示\r\nnested:\r\n  name: inner\r\n  version: "9.9.9"\r\n---\r\n正文\r\n',
    })
    expect(readSkillFrontmatterFields(dir)).toEqual({ name: 'demo', description: '用于演示' })
  })

  test('块标量 description（> / |）能完整读出，不再只读成一个字符', () => {
    const folded = skillDir('demo', { skillMd: '---\nname: demo\ndescription: >\n  第一行说明；\n  第二行说明。\nversion: "2.0.0"\n---\n正文\n' })
    expect(readSkillFrontmatterFields(folded)).toEqual({ name: 'demo', description: '第一行说明； 第二行说明。', version: '2.0.0' })
    expect(readSkillVersion(folded)).toBe('2.0.0')

    const literal = skillDir('demo', { skillMd: '---\nname: demo\ndescription: |-\n  第一行\n  第二行\n---\n正文\n' })
    expect(readSkillFrontmatterFields(literal).description).toBe('第一行\n第二行')
  })

  test('缺少 SKILL.md 或 frontmatter 时返回空对象', () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-skill-manifest-'))
    roots.push(root)
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(readSkillFrontmatterFields(empty)).toEqual({})
    writeFileSync(join(empty, 'SKILL.md'), '# 没有 frontmatter\n')
    expect(readSkillFrontmatterFields(empty)).toEqual({})
  })
})

describe('Skill 清单：写入器', () => {
  test('从无到有写入触发词与依赖；空字符串/空数组视为移除', () => {
    const dir = skillDir('demo')
    const result = writeSkillManifest(dir, { triggers: { keywords: ['柱状图', ' '] }, dependencies: { toolGroups: ['preview'] } })
    expect(result.removed).toBe(false)
    expect(result.issues).toEqual([])
    expect(result.manifest?.triggers?.keywords).toEqual(['柱状图'])

    // 清空 keywords 只删这个字段，同一组里的其他字段与磁盘上未知字段都要保留。
    writeSkillManifest(dir, { triggers: { excludeKeywords: ['不要图表'] } })
    writeSkillManifest(dir, { triggers: { keywords: [] } })
    const afterClear = readSkillManifest(dir).manifest
    expect(afterClear?.triggers).toEqual({ excludeKeywords: ['不要图表'] })
    expect(afterClear?.dependencies?.toolGroups).toEqual(['preview'])
  })

  test('合并保留磁盘上的未知字段与手写内容', () => {
    const dir = skillDir('demo', { manifest: { schemaVersion: 1, webhook: 'https://example.com', triggers: { keywords: ['旧词'], excludeKeywords: ['旧排除'] } } })
    writeSkillManifest(dir, { triggers: { keywords: ['新词'] } })
    const raw = JSON.parse(readFileSync(join(dir, 'SKILL.json'), 'utf8'))
    expect(raw.webhook).toBe('https://example.com')
    expect(raw.triggers).toEqual({ keywords: ['新词'], excludeKeywords: ['旧排除'] })
  })

  test('顶层标量支持 null / 空串删除，分组支持整组删除', () => {
    const dir = skillDir('demo')
    writeSkillManifest(dir, { name: '卡片名字', version: '2.0.0', policy: { implicit: false } })
    expect(readSkillDescriptor(dir).descriptor.name).toBe('卡片名字')
    expect(readSkillVersion(dir)).toBe('2.0.0')

    writeSkillManifest(dir, { name: '', policy: null })
    const raw = JSON.parse(readFileSync(join(dir, 'SKILL.json'), 'utf8'))
    expect(raw.name).toBeUndefined()
    expect(raw.policy).toBeUndefined()
    expect(raw.version).toBe('2.0.0')
  })

  test('校验不过就报错且不落盘；坏 JSON 拒绝覆盖', () => {
    const dir = skillDir('demo')
    expect(() => writeSkillManifest(dir, { dependencies: { toolGroups: ['不存在的组' as never] } })).toThrow(/校验未通过/)
    expect(existsSync(join(dir, 'SKILL.json'))).toBe(false)

    const broken = skillDir('demo', { manifest: '{ 坏卡片' })
    expect(() => writeSkillManifest(broken, { triggers: { keywords: ['词'] } })).toThrow(/不是合法 JSON/)
    expect(readFileSync(join(broken, 'SKILL.json'), 'utf8')).toBe('{ 坏卡片')
  })

  test('写成空卡片时删除文件，回到无卡片回退状态；clear 幂等', () => {
    const dir = skillDir('demo')
    writeSkillManifest(dir, { triggers: { keywords: ['词'] } })
    const emptied = writeSkillManifest(dir, { triggers: null })
    expect(emptied.removed).toBe(true)
    expect(existsSync(join(dir, 'SKILL.json'))).toBe(false)
    expect(readSkillManifest(dir).present).toBe(false)
    expect(readSkillDescriptor(dir).descriptor.sources.version).toBe('frontmatter')

    writeSkillManifest(dir, { policy: { implicit: false } })
    expect(clearSkillManifest(dir).removed).toBe(true)
    expect(clearSkillManifest(dir).removed).toBe(true)
    expect(existsSync(join(dir, 'SKILL.json'))).toBe(false)
  })
})
