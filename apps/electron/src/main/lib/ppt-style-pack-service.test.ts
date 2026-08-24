import { describe, expect, mock, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: { isPackaged: false },
  net: {},
}))

const { getPptStylePack, listPptStylePacks } = await import('./ppt-style-pack-service')
const resourceRoot = join(import.meta.dir, '../../../resources/ppt-style-packs')

describe('ppt style pack service', () => {
  test('只列出两个首发 Style Pack，并返回不含本地路径的 opaque 预览', () => {
    const registeredPaths: string[] = []
    const packs = listPptStylePacks({
      resourceRoot,
      registerPreviewPath: (path) => {
        registeredPaths.push(path)
        return `profer-file://preview-${registeredPaths.length}`
      },
    })

    expect(packs.map((pack) => pack.id)).toEqual(['academic-editorial', 'profer-cloud-dancer'])
    expect(registeredPaths).toHaveLength(2)
    for (const pack of packs) {
      expect(pack.preview).toMatch(/^!\[[^\]]+\]\(profer-file:\/\/preview-\d+\)$/)
      expect(pack.preview).not.toContain(resourceRoot)
      expect(pack.definition).toHaveProperty('tokens')
      expect(pack.definition).toHaveProperty('layoutGrammar')
      expect(pack.definition).toHaveProperty('motifs')
      expect(pack.definition).toHaveProperty('chartLanguage')
      expect(pack.definition).toHaveProperty('imageDirection')
      expect(pack.definition).toHaveProperty('narrativeRhythm')
      expect(pack.definition).toHaveProperty('qaProfile')
      expect(pack.definition).toHaveProperty('editorialPolicy')
    }
  })

  test('Academic Editorial 使用纸白/墨黑/单强调色和非对称证据网格', () => {
    const pack = getPptStylePack('academic-editorial', {
      resourceRoot,
      registerPreviewPath: () => 'profer-file://academic-preview',
    })

    expect(pack.definition.tokens.colors).toMatchObject({
      canvas: '#F7F5F0',
      ink: '#17191C',
      accent: '#A20D18',
    })
    expect(pack.definition.tokens.grid.columns).toBe(12)
    expect(pack.definition.layoutGrammar.assertion_evidence.medium).toContain('editorial-split')
    expect(pack.definition.motifs.some((motif) => motif.id === 'evidence-marker')).toBe(true)
    expect(pack.definition.editorialPolicy).toMatchObject({
      mode: 'scientific-editorial',
      headlineStyle: 'evidence-statement',
      requireMetricDefinition: true,
      requireNativeQuantitativeVisual: true,
      requireConclusionBoundary: true,
    })
    expect(pack.definition.qaProfile.forbidden).toEqual(expect.arrayContaining(['rhetorical-headline', 'presentational-slogan']))
  })

  test('Cloud Dancer 使用指定色板、云朵/拱形/月牙，并限制内容页母题频率', () => {
    const pack = getPptStylePack('profer-cloud-dancer', {
      resourceRoot,
      registerPreviewPath: () => 'profer-file://cloud-preview',
    })

    expect(Object.values(pack.definition.tokens.colors)).toEqual(expect.arrayContaining([
      '#F0EFEC', '#E3E1DC', '#312F2A', '#846557', '#F6F5F2',
    ]))
    expect(pack.definition.motifs.map((motif) => motif.id)).toEqual(expect.arrayContaining([
      'cloud-cluster', 'arch', 'crescent', 'dancer-motion',
    ]))
    expect(pack.definition.qaProfile.maxContentMotifs).toBeLessThanOrEqual(4)
    expect(pack.definition.qaProfile.forbidden).toContain('full-slide-dancer-on-content')
  })

  test('未知 Style Pack id 被拒绝', () => {
    expect(() => getPptStylePack('user-local-pack', {
      resourceRoot,
      registerPreviewPath: () => 'profer-file://unused',
    })).toThrow('未知 Style Pack')
  })

  test('preview 不能越界引用任意本地文件', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'profer-ppt-style-pack-'))
    try {
      cpSync(resourceRoot, fixtureRoot, { recursive: true })
      const packPath = join(fixtureRoot, 'academic-editorial', 'pack.json')
      const pack = JSON.parse(readFileSync(packPath, 'utf8'))
      pack.preview.asset = '../../private.png'
      writeFileSync(packPath, JSON.stringify(pack), 'utf8')

      expect(() => listPptStylePacks({
        resourceRoot: fixtureRoot,
        registerPreviewPath: () => 'profer-file://must-not-register',
      })).toThrow('preview.asset')
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
