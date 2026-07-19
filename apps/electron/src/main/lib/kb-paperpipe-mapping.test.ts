import { describe, expect, test } from 'bun:test'
import type { PaperMeta } from '@profer/shared'
import { findPaperMatch, mergePaperMeta, remotePaperToMeta, selectRemoteMarkdown } from './kb-paperpipe-mapping'

const localPaper: PaperMeta = {
  id: '11111111-1111-4111-8111-111111111111', title: '本地论文', authors: [], abstract: '',
  source: 'local', pageCount: 2, importedAt: 1, tags: [], chunkCount: 0, syncState: 'pending',
}

describe('Paperpipe 数据映射', () => {
  test('Given 同时有 summary 和 markdown When 选择正文 Then 完整 markdown 优先', () => {
    expect(selectRemoteMarkdown({ summary: '短摘要', markdown: '# 完整正文', equations: 'x=y' })).toBe('# 完整正文')
    expect(selectRemoteMarkdown({ summary: '短摘要' })).toBe('# Summary\n\n短摘要')
    expect(selectRemoteMarkdown({})).toBe('')
  })

  test('Given 远端 local 来源 When 映射 Then 保留 local 而非强制 arxiv', () => {
    expect(remotePaperToMeta({ id: 'remote-1', source: 'local' }).source).toBe('local')
  })

  test('Given 本地论文合并远端投影 When 映射 Then 保留本地 UUID 和来源', () => {
    const merged = mergePaperMeta(localPaper, remotePaperToMeta({ id: 'remote-1', source: 'arxiv', title: '远端标题' }))
    expect(merged.id).toBe(localPaper.id)
    expect(merged.source).toBe('local')
    expect(merged.remoteId).toBe('remote-1')
    expect(merged.syncState).toBe('synced')
  })

  test('Given 两篇无 arXiv ID 论文 When 查找匹配 Then 不会互相合并', () => {
    const second = { ...localPaper, id: '22222222-2222-4222-8222-222222222222' }
    expect(findPaperMatch([localPaper], second)).toBe(-1)
  })

  test('Given local 论文远端正文回退 When 合并 Then identity 不被远端 ID 替换', () => {
    const merged = mergePaperMeta(localPaper, remotePaperToMeta({ id: 'remote-2', source: 'local' }))
    expect(merged.id).toBe(localPaper.id)
    expect(merged.remoteId).toBe('remote-2')
  })
})
