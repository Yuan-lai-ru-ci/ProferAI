import { describe, expect, test } from 'bun:test'
import { extractRemotePaperId, hasPdfMagicBytes, isSafePaperpipeId, normalizePaperpipeSearchInput, sanitizePaperFilename } from './paperpipe-helpers.js'

describe('Paperpipe 请求边界', () => {
  test('Given 路径穿越或分隔符 ID When 校验 Then 拒绝', () => {
    expect(isSafePaperpipeId('../outside')).toBe(false)
    expect(isSafePaperpipeId('a/b')).toBe(false)
    expect(isSafePaperpipeId('safe-remote-id')).toBe(true)
  })

  test('Given 上传文件名与内容 When 规范化 Then 防止 header 注入且要求 PDF magic bytes', () => {
    expect(sanitizePaperFilename('dir/evil\r\nheader.pdf')).toBe('evil__header.pdf')
    expect(hasPdfMagicBytes(Buffer.from('%PDF-1.7'))).toBe(true)
    expect(hasPdfMagicBytes(Buffer.from('not-a-pdf'))).toBe(false)
  })

  test('Given bridge 成功响应 When 提取远端 ID Then 只接受安全稳定 ID', () => {
    expect(extractRemotePaperId({ paper: { id: 'remote-123' } })).toBe('remote-123')
    expect(extractRemotePaperId({ id: '../outside' })).toBeUndefined()
  })

  test('Given 合法搜索参数 When 规范化 Then 保留 topK 和 mode', () => {
    expect(normalizePaperpipeSearchInput({ query: ' agent ', topK: 8, mode: 'hybrid' })).toEqual({ value: { query: 'agent', topK: 8, mode: 'hybrid' } })
    expect(normalizePaperpipeSearchInput({ query: 'agent', topK: 0 }).error).toBeTruthy()
    expect(normalizePaperpipeSearchInput({ query: 'agent', mode: 'invalid' }).error).toBeTruthy()
  })
})
