import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root = ''
let service: typeof import('./knowledge-item-service')

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'profer-knowledge-test-'))
  process.env.PROFER_CONFIG_DIR = root
  service = await import(`./knowledge-item-service?test=${Date.now()}-${Math.random()}`)
})

afterEach(() => {
  delete process.env.PROFER_CONFIG_DIR
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('个人资料受控存储', () => {
  test('Given 十一份资料 When 导入 Then 拒绝并且不创建索引', async () => {
    await expect(service.importKnowledgeItems(Array.from({ length: 11 }, (_, index) => join(root, `${index}.md`)))).rejects.toThrow('一次最多导入 10 份资料')
    expect(service.listKnowledgeItems()).toEqual([])
  })

  test('Given 本地 Markdown When 导入 Then 索引不记录原始绝对路径且正文可受控读取', async () => {
    const source = join(root, 'private-note.md')
    writeFileSync(source, '# 私有标题\n这里是受控正文。')
    const result = await service.importKnowledgeItems([source])
    const item = result.results[0]?.item
    expect(item).toBeDefined()
    const index = readFileSync(join(root, 'knowledge-base', 'items-index.json'), 'utf-8')
    expect(index).not.toContain(source)
    expect(index).toContain('private-note.md')
    expect(service.getKnowledgeItem(item!.id)?.text).toContain('受控正文')
  })

  test('Given 已删除资料 When 读取或 allowlist 搜索 Then 不返回正文', async () => {
    const source = join(root, 'delete-me.md')
    writeFileSync(source, '删除后的内容不能继续读取')
    const item = (await service.importKnowledgeItems([source])).results[0]?.item!
    service.deleteKnowledgeItem(item.id)
    expect(service.getKnowledgeItem(item.id)).toBeNull()
    expect(await service.searchKnowledgeItemsForChat('删除内容', [item.id])).toEqual([])
  })

  test('Given 两份资料 When allowlist 只含一份 Then 搜索不会越权读取另一份', async () => {
    const allowed = join(root, 'allowed.md')
    const denied = join(root, 'denied.md')
    writeFileSync(allowed, '许可资料中包含独特关键词 alpaca')
    writeFileSync(denied, '未许可资料中包含独特关键词 forbidden-token')
    const imported = await service.importKnowledgeItems([allowed, denied])
    const [first, second] = imported.results.map((result) => result.item!)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    const results = await service.searchKnowledgeItemsForChat('forbidden-token', [first!.id])
    expect(results.map((result) => result.item.id)).toEqual([first!.id])
    expect(results.map((result) => result.content).join('\n')).not.toContain('forbidden-token')
    expect(service.getKnowledgeItem(second!.id)?.text).toContain('forbidden-token')
  })
})
