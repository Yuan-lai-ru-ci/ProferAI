import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from './conversation-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conversation-store-'))
  roots.push(root)
  const dir = join(root, 'conversations'); mkdirSync(dir)
  const ports = {
    getConversationsIndexPath: () => join(root, 'conversations.json'),
    getConversationsDir: () => dir,
    getConversationMessagesPath: (id: string) => join(dir, `${id}.jsonl`),
    getConversationDiscardedPath: (id: string) => join(dir, `${id}.discarded.jsonl`),
    deleteConversationAttachments: (_id: string) => {},
    deleteAttachment: (_path: string) => {},
  }
  return { ports, store: createConversationStore(ports) }
}
describe('Chat 存储宿主隔离与数据保护', () => {
  test('Given 两个宿主 When 创建和追加 Then 消息缓存与索引互不串用', () => {
    const a = fixture(); const b = fixture()
    const meta = a.store.createConversation('测试')
    a.store.appendBranchTail(meta.id, { role: 'user', content: '独立消息' })
    expect(a.store.getConversationBranch(meta.id)).toHaveLength(1)
    expect(b.store.listConversations()).toEqual([])
    expect(b.store.getConversationMessages(meta.id)).toEqual([])
  })
  test('Given 非法路径 ID When 读写 Then 在调用宿主路径前拒绝', () => {
    const { store } = fixture()
    expect(() => store.getConversationMessages('../outside')).toThrow()
    expect(() => store.deleteConversation('../outside')).toThrow()
  })
  test('Given 损坏索引 When 创建 Then 拒绝且保留原始文件', () => {
    const { store, ports } = fixture()
    writeFileSync(ports.getConversationsIndexPath(), '{broken')
    expect(() => store.createConversation()).toThrow()
    expect(readFileSync(ports.getConversationsIndexPath(), 'utf8')).toBe('{broken')
  })
  test('Given 旧线性消息中混有损坏行 When 自动迁移 Then 拒绝而不丢行重写', () => {
    const { store, ports } = fixture(); const meta = store.createConversation()
    const raw = JSON.stringify({ id: 'old-message', role: 'user', content: '旧消息', createdAt: 1 }) + '\n{broken\n'
    writeFileSync(ports.getConversationMessagesPath(meta.id), raw)
    expect(() => store.getConversationMessages(meta.id)).toThrow()
    expect(readFileSync(ports.getConversationMessagesPath(meta.id), 'utf8')).toBe(raw)
  })
  test('Given 非 v4 旧 UUID 和线性历史 When 读取 Then 完整迁移并初始化 activePath', () => {
    const { store, ports } = fixture()
    const id = '12345678-1234-1234-1234-123456789abc'
    writeFileSync(ports.getConversationsIndexPath(), JSON.stringify({ version: 1, conversations: [{ id, title: '旧对话', createdAt: 1, updatedAt: 1 }] }))
    writeFileSync(ports.getConversationMessagesPath(id), [{ id: 'first', role: 'user', content: '旧问题', createdAt: 1 }, { id: 'second', role: 'assistant', content: '旧回答', createdAt: 2 }].map(m => JSON.stringify(m)).join('\n'))
    expect(store.getConversationBranch(id).map(m => m.parentId)).toEqual([null, 'first'])
    expect(store.getConversationMeta(id)?.activePath).toEqual(['first', 'second'])
  })
  test('Given 旧 discarded 段 When 搜索和删除 Then 兼容结果与附件清理', async () => {
    const { ports } = fixture(); const deleted: string[] = []
    const store = createConversationStore({ ...ports, deleteAttachment: path => { deleted.push(path) }, deleteConversationAttachments: id => { deleted.push(id) } })
    const meta = store.createConversation('旧历史')
    const message = store.appendBranchTail(meta.id, { role: 'user', content: '匹配关键词' })
    writeFileSync(ports.getConversationDiscardedPath(meta.id), JSON.stringify({ entryId: 'segment', discardedAt: 2, reason: 'resend', segment: [{ ...message, content: '历史关键词' }] }) + '\n')
    expect(store.listDiscardedSegments(meta.id)).toHaveLength(1)
    expect((await store.searchConversationMessages('关键词')).map(hit => hit.version?.source)).toEqual(['current', 'discarded'])
    store.deleteConversation(meta.id)
    expect(deleted).toContain(meta.id)
    expect(store.listDiscardedSegments(meta.id)).toEqual([])
  })
  test('Given 已缓存消息之后文件损坏 When 再追加 Then 不使用旧缓存覆盖损坏文件', () => {
    const { store, ports } = fixture(); const meta = store.createConversation()
    store.appendBranchTail(meta.id, { role: 'user', content: '原消息' })
    writeFileSync(ports.getConversationMessagesPath(meta.id), '{broken')
    expect(() => store.appendBranchTail(meta.id, { role: 'user', content: '新消息' })).toThrow()
    expect(readFileSync(ports.getConversationMessagesPath(meta.id), 'utf8')).toBe('{broken')
  })

  test('Given 写权已交接 When 调用所有公开写入口 Then 拒绝且消息索引附件不变', () => {
    const { ports } = fixture(); const removed: string[] = []; let writable = true
    const store = createConversationStore({ ...ports, assertWritable: () => { if (!writable) throw new Error('Core 已接管') }, deleteAttachment: path => { removed.push(path) }, deleteConversationAttachments: id => { removed.push(id) } })
    const meta = store.createConversation()
    const message = store.appendBranchTail(meta.id, { role: 'user', content: '保留消息' })
    writeFileSync(ports.getConversationDiscardedPath(meta.id), '历史附件段')
    const paths = [ports.getConversationsIndexPath(), ports.getConversationMessagesPath(meta.id), ports.getConversationDiscardedPath(meta.id)]
    const before = paths.map(path => readFileSync(path, 'utf8'))
    writable = false
    const mutations = [
      () => store.createConversation(), () => store.appendMessage(meta.id, message),
      () => store.saveConversationMessages(meta.id, []), () => store.updateConversationMeta(meta.id, { title: '修改' }),
      () => store.deleteConversation(meta.id), () => store.deleteMessage(meta.id, message.id),
      () => store.truncateMessagesFrom(meta.id, message.id), () => store.updateContextDividers(meta.id, []),
      () => store.autoArchiveConversations(0), () => store.setActivePath(meta.id, [message.id]),
      () => store.ensureActivePath(meta.id, []), () => store.forkBranchAt(meta.id, message.id, { role: 'user', content: '分叉' }),
      () => store.appendBranchTail(meta.id, { role: 'user', content: '新增' }),
      () => store.deleteMessageFromTree(meta.id, message.id), () => store.deleteDiscardedSegments(meta.id),
    ]
    for (const mutate of mutations) expect(mutate).toThrow('Core 已接管')
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before)
    expect(removed).toEqual([])
    expect(store.getConversationBranch(meta.id)).toHaveLength(1)
  })
  test('Given 只读宿主与旧线性数据 When 读取需要迁移 Then 拒绝暗写并保留原始字节', () => {
    const { ports, store } = fixture(); const meta = store.createConversation()
    const raw = JSON.stringify({ id: 'old', role: 'user', content: '旧消息', createdAt: 1 }) + '\n'
    writeFileSync(ports.getConversationMessagesPath(meta.id), raw)
    const before = readFileSync(ports.getConversationsIndexPath(), 'utf8')
    const readonly = createConversationStore({ ...ports, assertWritable: () => { throw new Error('Core 已接管') } })
    expect(readonly.listConversations()).toHaveLength(1)
    expect(() => readonly.getConversationMessages(meta.id)).toThrow('Core 已接管')
    expect(readFileSync(ports.getConversationMessagesPath(meta.id), 'utf8')).toBe(raw)
    expect(readFileSync(ports.getConversationsIndexPath(), 'utf8')).toBe(before)
    writeFileSync(ports.getConversationsIndexPath(), '{broken')
    expect(() => readonly.listConversations()).toThrow()
    expect(readFileSync(ports.getConversationsIndexPath(), 'utf8')).toBe('{broken')
  })

  test('Given 任一可读候选索引版本未知 When 创建 Then 不回退覆盖并保留所有候选字节', () => {
    for (const suffix of ['', '.tmp', '.bak']) {
      for (const version of [2, 0, '1', null]) {
        const { store, ports } = fixture()
        const indexPath = ports.getConversationsIndexPath()
        const valid = JSON.stringify({ version: 1, conversations: [] })
        for (const candidate of ['', '.tmp', '.bak']) writeFileSync(indexPath + candidate, candidate === suffix ? JSON.stringify({ version, conversations: [] }) : valid)
        const paths = ['', '.tmp', '.bak'].map(candidate => indexPath + candidate)
        const before = paths.map(path => readFileSync(path, 'utf8'))
        expect(() => store.createConversation()).toThrow('索引版本')
        expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(before)
      }
    }
  })
  test('Given 非字符串元数据 ID When 读取 Then 明确拒绝而不隐式转换', () => {
    const { store, ports } = fixture()
    writeFileSync(ports.getConversationsIndexPath(), JSON.stringify({ version: 1, conversations: [{ id: 123, title: '无效', createdAt: 1, updatedAt: 1 }] }))
    expect(() => store.listConversations()).toThrow('非法对话 ID')
  })

})
