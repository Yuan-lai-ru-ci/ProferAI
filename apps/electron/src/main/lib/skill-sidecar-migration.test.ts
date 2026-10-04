/**
 * 旧路由侧车（profer-routing.json）迁入模块清单（SKILL.json）的契约。
 *
 * 迁移前后的生效规则必须完全一致：清单已声明的字段以清单为准，依赖取并集；
 * 侧车无效或清单损坏时原样保留，绝不丢配置。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateRoutingSidecar } from './skill-sidecar-migration'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function skillDir(files: { sidecar?: unknown; manifest?: unknown | string }): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'profer-sidecar-migration-')), 'demo')
  roots.push(join(dir, '..'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\nBODY\n')
  if (files.sidecar !== undefined) writeFileSync(join(dir, 'profer-routing.json'), JSON.stringify(files.sidecar))
  if (files.manifest !== undefined) writeFileSync(join(dir, 'SKILL.json'), typeof files.manifest === 'string' ? files.manifest : JSON.stringify(files.manifest))
  return dir
}

const card = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, 'SKILL.json'), 'utf8'))

describe('路由侧车迁入 SKILL.json', () => {
  test('只有侧车时整份搬进清单并删除侧车', () => {
    const dir = skillDir({ sidecar: { keywords: ['季度核算'], excludeKeywords: ['不要核算'], implicit: false, requiredTools: ['mcp__reports__fetch'], requiredMcpServers: ['reports'], requiredToolGroups: ['web'] } })
    expect(migrateRoutingSidecar(dir)).toBe('migrated')
    expect(existsSync(join(dir, 'profer-routing.json'))).toBe(false)
    expect(card(dir)).toMatchObject({
      schemaVersion: 1,
      triggers: { keywords: ['季度核算'], excludeKeywords: ['不要核算'] },
      policy: { implicit: false },
      dependencies: { tools: ['mcp__reports__fetch'], mcpServers: ['reports'], toolGroups: ['web'] },
    })
  })

  test('清单已声明的字段以清单为准，依赖取并集，保留清单原有内容', () => {
    const dir = skillDir({
      manifest: { schemaVersion: 1, version: '1.2.0', triggers: { keywords: ['清单词'] }, dependencies: { tools: ['a'] } },
      sidecar: { keywords: ['侧车词'], excludeKeywords: ['不要'], requiredTools: ['b'] },
    })
    expect(migrateRoutingSidecar(dir)).toBe('migrated')
    expect(card(dir)).toMatchObject({
      version: '1.2.0',
      triggers: { keywords: ['清单词'], excludeKeywords: ['不要'] },
      dependencies: { tools: ['a', 'b'] },
    })
  })

  test('侧车无效或清单损坏时原样保留，不写任何文件', () => {
    const badSidecar = skillDir({ sidecar: { requiredToolGroups: ['automaton'] } })
    expect(migrateRoutingSidecar(badSidecar)).toBe('kept')
    expect(existsSync(join(badSidecar, 'profer-routing.json'))).toBe(true)
    expect(existsSync(join(badSidecar, 'SKILL.json'))).toBe(false)

    const badCard = skillDir({ sidecar: { keywords: ['词'] }, manifest: '{ 坏清单' })
    expect(migrateRoutingSidecar(badCard)).toBe('kept')
    expect(existsSync(join(badCard, 'profer-routing.json'))).toBe(true)
    expect(readFileSync(join(badCard, 'SKILL.json'), 'utf8')).toBe('{ 坏清单')
  })

  test('没有侧车时什么都不做', () => {
    const dir = skillDir({})
    expect(migrateRoutingSidecar(dir)).toBe('none')
    expect(existsSync(join(dir, 'SKILL.json'))).toBe(false)
  })
})
