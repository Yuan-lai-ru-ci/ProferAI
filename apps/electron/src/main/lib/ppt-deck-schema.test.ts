import { describe, expect, test } from 'bun:test'
import { parseDeckBrief, parseDeckSpec, parseSourceLineage } from './ppt-deck-schema'

describe('ppt deck schema', () => {
  test('拒绝没有目标、受众或核心论点的 Brief', () => {
    expect(() => parseDeckBrief({ deckId: 'lab-meeting', audience: '同学' })).toThrow('goal')
  })

  test('拒绝没有 slideId、claim 或 evidenceRefs 的页面', () => {
    expect(() => parseDeckSpec({
      deckId: 'lab-meeting',
      title: '实验进展',
      styleId: 'academic-editorial',
      slides: [{ title: '结果' }],
      sourceHashes: {},
    })).toThrow('slideId')
  })

  test('拒绝来源 hash、状态或定位信息无效的谱系记录', () => {
    expect(() => parseSourceLineage({
      sources: [{
        id: 'src-1',
        absolutePath: 'C:/paper-final.pdf',
        relativePath: 'paper-final.pdf',
        kind: 'document',
        size: 12,
        mtimeMs: 100,
        contentHash: 'not-a-sha256',
        status: 'current',
      }],
    })).toThrow('contentHash')
  })

  test('接受带来源版本、定位符和 sha256 的谱系记录', () => {
    const result = parseSourceLineage({
      sources: [{
        id: 'src-1',
        absolutePath: 'C:/paper-final.pdf',
        relativePath: 'paper-final.pdf',
        kind: 'document',
        size: 12,
        mtimeMs: 100,
        contentHash: 'a'.repeat(64),
        status: 'current',
        locator: 'p.6.fig.2',
        versionSignals: ['filename:final', 'date:2026-08-23'],
      }],
    })
    expect(result.sources[0]?.status).toBe('current')
    expect(result.sources[0]?.locator).toBe('p.6.fig.2')
  })

  test('接受包含论点、来源引用和讲述备注的 Deck Spec', () => {
    const result = parseDeckSpec({
      schemaVersion: 1,
      deckId: 'lab-meeting',
      title: '实验进展',
      styleId: 'academic-editorial',
      slides: [{
        slideId: 'result-01',
        claim: '双阶段检索降低误差',
        evidenceRefs: ['src-1#p6.fig2'],
        visualRole: 'assertion_evidence',
        layoutIntent: 'editorial_split',
        densityBudget: 'medium',
        editableObjects: ['text', 'chart', 'citation'],
        content: { headline: '误差下降 37%' },
        speakerNotes: ['先解释实验设置', '再说明结果变化'],
        citations: ['论文最终版，第 6 页，图 2'],
      }],
      sourceHashes: { 'src-1': 'a'.repeat(64) },
    })
    expect(result.slides[0]?.slideId).toBe('result-01')
    expect(result.slides[0]?.evidenceRefs).toEqual(['src-1#p6.fig2'])
  })
})
