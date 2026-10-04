/**
 * Skill 模块清单（SKILL.json）纯校验的契约。
 *
 * 这里钉死三件事：① 清单永远不能成为加载门禁（坏清单只产诊断，不抛异常、不阻断）；
 * ② 未来版本不信任字段；③ 路由字段映射与依赖声明必须可被管理层直接消费。
 */
import { describe, expect, test } from 'bun:test'
import {
  parseSkillManifest,
  skillManifestDescription,
  skillManifestDisplayName,
  skillManifestToRoutingFields,
  SKILL_MANIFEST_SCHEMA_VERSION,
} from './skill-manifest'

const valid = {
  schemaVersion: 1,
  slug: 'demo-skill',
  version: '1.2.3',
  interface: { displayName: '演示技能', shortDescription: '用于演示清单解析', icon: 'assets/icon.png', brandColor: '#4f46e5' },
  policy: { implicit: false, surfaces: ['desktop'] },
  triggers: { keywords: ['演示', 'demo'], excludeKeywords: ['不要演示'] },
  dependencies: { toolGroups: ['memory'], tools: ['search_memory'], mcpServers: ['reports'], commands: ['lark'] },
  requires: { hostClasses: ['.table'] },
  provenance: { kind: 'bundled', id: 'builtin-demo-skill' },
} as const

function codes(value: unknown): string[] {
  return parseSkillManifest(value).issues.map(issue => issue.code)
}

describe('Skill 清单：解析与校验', () => {
  test('合法清单完整解析，且不产生任何诊断', () => {
    const { manifest, issues } = parseSkillManifest(valid)
    expect(issues).toEqual([])
    expect(manifest?.schemaVersion).toBe(SKILL_MANIFEST_SCHEMA_VERSION)
    expect(manifest?.slug).toBe('demo-skill')
    expect(manifest?.interface?.displayName).toBe('演示技能')
    expect(manifest?.policy?.implicit).toBe(false)
    expect(manifest?.triggers?.keywords).toEqual(['演示', 'demo'])
    expect(manifest?.dependencies?.toolGroups).toEqual(['memory'])
    expect(manifest?.requires?.hostClasses).toEqual(['.table'])
    expect(manifest?.provenance?.kind).toBe('bundled')
  })

  test('非对象只报错，不抛异常', () => {
    for (const value of [null, 42, 'x', ['a']]) {
      const result = parseSkillManifest(value)
      expect(result.manifest).toBeUndefined()
      expect(result.issues.map(issue => issue.code)).toEqual(['not-an-object'])
    }
  })

  test('缺 schemaVersion 按当前版本处理并提示；未来版本不信任字段', () => {
    const missing = parseSkillManifest({ version: '1.0.0' })
    expect(missing.manifest?.schemaVersion).toBe(SKILL_MANIFEST_SCHEMA_VERSION)
    expect(missing.issues.map(issue => issue.code)).toContain('missing-schema-version')

    const future = parseSkillManifest({ schemaVersion: SKILL_MANIFEST_SCHEMA_VERSION + 1, triggers: { keywords: ['x'] } })
    expect(future.manifest).toBeUndefined()
    expect(future.issues.map(issue => issue.code)).toEqual(['unsupported-schema-version'])
  })

  test('未知字段只提示不丢弃已知字段', () => {
    const { manifest, issues } = parseSkillManifest({ schemaVersion: 1, version: '1.0.0', webhook: 'https://example.com' })
    expect(manifest?.version).toBe('1.0.0')
    expect(issues.map(issue => issue.code)).toEqual(['unknown-field'])
    expect(issues[0]?.severity).toBe('warning')
  })

  test('非法 slug 会被拒绝且不写进清单（slug 会当目录段用）', () => {
    for (const slug of ['Demo Skill', '../escape', '-lead', 'ok_slug']) {
      const { manifest } = parseSkillManifest({ schemaVersion: 1, slug })
      expect(manifest?.slug).toBeUndefined()
      expect(codes({ schemaVersion: 1, slug })).toContain('invalid-field')
    }
  })

  test('版本、品牌色、越界图标路径都按硬错误处理', () => {
    expect(codes({ schemaVersion: 1, version: 'v1' })).toContain('invalid-field')
    expect(codes({ schemaVersion: 1, interface: { brandColor: 'red' } })).toContain('invalid-field')
    for (const icon of ['/etc/passwd', '../../secret.png', 'C:\\x.png']) {
      const { manifest } = parseSkillManifest({ schemaVersion: 1, interface: { icon } })
      expect(manifest?.interface?.icon).toBeUndefined()
      expect(codes({ schemaVersion: 1, interface: { icon } })).toContain('unsafe-path')
    }
  })

  test('未知能力组 / 未知表面 / 未知来源类型都拒绝写入', () => {
    const manifest = parseSkillManifest({ schemaVersion: 1, dependencies: { toolGroups: ['不存在的组'] }, policy: { surfaces: ['watch'] }, provenance: { kind: 'cdrom' } }).manifest
    expect(manifest?.dependencies?.toolGroups).toBeUndefined()
    expect(manifest?.policy?.surfaces).toBeUndefined()
    expect(manifest?.provenance?.kind).toBe('bundled')
  })

  test('描述与短描述不一致时提示第二份真相', () => {
    const both = parseSkillManifest({ schemaVersion: 1, description: '长描述', interface: { shortDescription: '短描述' } })
    expect(both.issues.map(issue => issue.code)).toContain('duplicate-description')
    const same = parseSkillManifest({ schemaVersion: 1, description: '同一段', interface: { shortDescription: '同一段' } })
    expect(same.issues).toEqual([])
  })
})

describe('Skill 清单：路由字段映射', () => {
  test('清单映射为路由字段，未声明字段不出现', () => {
    const fields = skillManifestToRoutingFields(parseSkillManifest(valid).manifest)
    expect(fields).toEqual({
      keywords: ['演示', 'demo'],
      excludeKeywords: ['不要演示'],
      implicit: false,
      requiredTools: ['search_memory'],
      requiredMcpServers: ['reports'],
      requiredToolGroups: ['memory'],
    })
  })

  test('无清单时映射为空对象，调用方回退侧车 / frontmatter', () => {
    expect(skillManifestToRoutingFields(undefined)).toEqual({})
    expect(skillManifestToRoutingFields(parseSkillManifest({ schemaVersion: 1 }).manifest)).toEqual({})
  })

  test('展示文本优先级：短描述 > 描述；展示名 > name', () => {
    const manifest = parseSkillManifest(valid).manifest
    expect(skillManifestDescription(manifest)).toBe('用于演示清单解析')
    expect(skillManifestDisplayName(manifest)).toBe('演示技能')
    expect(skillManifestDescription(parseSkillManifest({ schemaVersion: 1, description: '只有长描述' }).manifest)).toBe('只有长描述')
  })
})
