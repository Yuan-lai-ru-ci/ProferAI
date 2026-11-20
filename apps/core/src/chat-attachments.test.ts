import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createCoreChatAttachments } from './chat-attachments'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() { const root = mkdtempSync(join(tmpdir(), 'core-chat-files-')); roots.push(root); const id = randomUUID(); return { root, id, files: createCoreChatAttachments(root, value => value === id) } }
describe('Core Chat附件安全', () => {
  test('Given 所属对话 When 保存文本 Then 只读回Core相对路径且可显式删除', async () => { const { files, id } = fixture(); const { attachment } = files.save({ conversationId: id, filename: 'hello.txt', mediaType: 'text/plain', data: Buffer.from('你好').toString('base64') }); expect(await files.extractText(attachment.localPath)).toBe('你好'); files.remove(attachment.localPath); expect(() => files.readBase64(attachment.localPath)).toThrow() })
  test('Given 恶意路径或其它对话 When 读附件 Then 拒绝', () => { const { files } = fixture(); for (const path of ['/etc/passwd', '../secret', `${randomUUID()}/${randomUUID()}.txt`]) expect(() => files.readBase64(path)).toThrow() })
  test('Given 对话附件目录为symlink When 保存 Then 不写外部目录', () => { const { root, id, files } = fixture(); mkdirSync(join(root, 'attachments')); const outside = mkdtempSync(join(tmpdir(), 'core-chat-outside-')); roots.push(outside); symlinkSync(outside, join(root, 'attachments', id)); expect(() => files.save({ conversationId: id, filename: 'hello.txt', mediaType: 'text/plain', data: 'aGVsbG8=' })).toThrow('符号链接') })
  test('Given 未装配文档/损坏Base64/超限 When 保存 Then 明确拒绝', () => { const { files, id } = fixture(); const input = { conversationId: id, filename: 'hello.txt', mediaType: 'text/plain', data: 'aGVsbG8=' }; expect(() => files.save({ ...input, mediaType: 'application/pdf' })).toThrow('尚未装配'); expect(() => files.save({ ...input, data: 'bad' })).toThrow(); expect(() => files.save({ ...input, data: 'a'.repeat(14 * 1024 * 1024) })).toThrow() })
  test('Given 文件为symlink When 读取 Then 拒绝', () => { const { root, id, files } = fixture(); mkdirSync(join(root, 'attachments', id), { recursive: true }); const external = join(root, 'private'); writeFileSync(external, 'private'); const name = `${randomUUID()}.txt`; symlinkSync(external, join(root, 'attachments', id, name)); expect(() => files.readBase64(`${id}/${name}`)).toThrow('符号链接') })
})
