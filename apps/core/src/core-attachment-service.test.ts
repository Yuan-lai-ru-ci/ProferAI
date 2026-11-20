import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveCoreAttachment, CORE_ATTACHMENT_MAX_BYTES } from './core-attachment-service'

test('Core附件保存使用唯一私有目录，拒绝文件名/大小/非法base64并可读回', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profer-core-attachment-'))
  try {
    const base64 = Buffer.from('fixture attachment').toString('base64')
    const first = saveCoreAttachment(root, 'session-1', 'photo.png', base64)
    const second = saveCoreAttachment(root, 'session-1', 'photo.png', base64)
    expect(first.filename).toBe('photo.png')
    expect(first.path).not.toBe(second.path)
    expect(await readFile(first.path, 'utf8')).toBe('fixture attachment')
    expect(second.size).toBe(Buffer.byteLength('fixture attachment'))
    for (const filename of ['../escape.txt', 'a/b.txt', 'a\\b.txt', 'a.txt.', 'CON', 'a\u0000.txt', '']) {
      expect(() => saveCoreAttachment(root, 'session-1', filename, base64)).toThrow('文件名无效')
    }
    expect(() => saveCoreAttachment(root, '../outside', 'a.txt', base64)).toThrow('身份无效')
    expect(() => saveCoreAttachment(root, 'session-1', 'a.txt', 'not base64')).toThrow('Base64')
    expect(() => saveCoreAttachment(root, 'session-1', 'a.txt', Buffer.alloc(CORE_ATTACHMENT_MAX_BYTES + 1).toString('base64'))).toThrow('超过10MB')
  } finally { await rm(root, { recursive: true, force: true }) }
})
