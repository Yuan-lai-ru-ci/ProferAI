/**
 * 远程发送附件：文件名归一化 + 解析 + 提示块拼装。
 *
 * 重点是**安全边界**：客户端只能给文件名，路径一律由主进程用会话 cwd 拼出来并校验存在。
 * 这几条一旦松动，移动端就能把任意本地文件塞进 `<attached_files>` 让 Agent 去读。
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  REMOTE_ATTACHMENT_LIMIT,
  applyAttachmentsToMessage,
  normalizeRemoteAttachments,
  resolveSessionAttachments,
} from './remote-send-attachments'

const alwaysExists = (): boolean => true

describe('附件描述归一化', () => {
  test('Given 正常文件名 When 归一化 Then 原样保留，label 缺省', () => {
    expect(normalizeRemoteAttachments([{ filename: 'report.pdf' }]))
      .toEqual([{ filename: 'report.pdf' }])
  })

  test('Given 带路径的文件名 When 归一化 Then 只留 basename（路径由会话 cwd 决定）', () => {
    expect(normalizeRemoteAttachments([{ filename: '../../etc/passwd' }])[0]?.filename).toBe('passwd')
    expect(normalizeRemoteAttachments([{ filename: 'C:\\Users\\x\\a.txt' }])[0]?.filename).toBe('a.txt')
    expect(normalizeRemoteAttachments([{ filename: 'a/b/c.png' }])[0]?.filename).toBe('c.png')
  })

  test('Given 纯路径片段 When 归一化 Then 丢弃，不产生「会话 cwd 本身」这种条目', () => {
    expect(normalizeRemoteAttachments([{ filename: '..' }, { filename: './' }, { filename: '' }])).toEqual([])
  })

  test('Given 重复文件名 When 归一化 Then 只留一个（同名会被服务端改名，客户端不该重复提）', () => {
    expect(normalizeRemoteAttachments([{ filename: 'a.png' }, { filename: 'a.png' }]))
      .toEqual([{ filename: 'a.png' }])
  })

  test('Given 超量附件 When 归一化 Then 截到上限，不把一条消息灌成附件包', () => {
    const many = Array.from({ length: REMOTE_ATTACHMENT_LIMIT + 5 }, (_, index) => ({ filename: `f${index}.png` }))
    expect(normalizeRemoteAttachments(many)).toHaveLength(REMOTE_ATTACHMENT_LIMIT)
  })

  test('Given 非数组或脏条目 When 归一化 Then 返回空/跳过，不抛异常', () => {
    expect(normalizeRemoteAttachments(undefined)).toEqual([])
    expect(normalizeRemoteAttachments('a.png')).toEqual([])
    expect(normalizeRemoteAttachments([null, 1, { filename: 42 }])).toEqual([])
  })
})

describe('附件路径解析', () => {
  test('Given 文件存在 When 解析 Then 落到会话 cwd 下', () => {
    const sessionDir = join('/', 'sessions', 's1')
    const resolved = resolveSessionAttachments(sessionDir, [{ filename: 'a.png' }], alwaysExists)
    // 用 join 构造期望值：Windows 上分隔符是反斜杠，写死 '/' 会让用例只在 mac 上过
    expect(resolved).toEqual([{ label: 'a.png', path: join(sessionDir, 'a.png') }])
  })

  test('Given 文件不存在 When 解析 Then 丢弃（不让 Agent 去读空气）', () => {
    expect(resolveSessionAttachments('/sessions/s1', [{ filename: 'ghost.png' }], () => false)).toEqual([])
  })
})

describe('消息拼装', () => {
  test('Given 有附件 When 拼装 Then 提示块在前、用户原文不变形、并给出 rawUserMessage', () => {
    const sessionDir = join('/', 'sessions', 's1')
    const result = applyAttachmentsToMessage({
      userMessage: '帮我看下这个报表',
      sessionDir,
      attachments: [{ filename: 'report.xlsx', label: '三月报表' }],
      exists: alwaysExists,
    })
    expect(result.userMessage).toBe(
      `<attached_files>\n- 三月报表: ${join(sessionDir, 'report.xlsx')}\n</attached_files>\n\n帮我看下这个报表`,
    )
    // 气泡只显示原文：路径块不进 transcript
    expect(result.rawUserMessage).toBe('帮我看下这个报表')
    expect(result.attached).toHaveLength(1)
  })

  test('Given 没有附件 When 拼装 Then 消息原样返回，不产生 rawUserMessage', () => {
    const result = applyAttachmentsToMessage({ userMessage: '你好', sessionDir: '/sessions/s1', attachments: [] })
    expect(result.userMessage).toBe('你好')
    expect(result.rawUserMessage).toBeUndefined()
  })

  test('Given 附件全都不存在 When 拼装 Then 退化成纯文本，不塞一个空块', () => {
    const result = applyAttachmentsToMessage({
      userMessage: '你好',
      sessionDir: '/sessions/s1',
      attachments: [{ filename: 'ghost.png' }],
      exists: () => false,
    })
    expect(result.userMessage).toBe('你好')
    expect(result.userMessage).not.toContain('attached_files')
    expect(result.rawUserMessage).toBeUndefined()
  })

  test('Given 客户端试图用路径穿越 When 拼装 Then 仍然只会在会话 cwd 内解析', () => {
    const sessionDir = join('/', 'sessions', 's1')
    const seen: string[] = []
    const result = applyAttachmentsToMessage({
      userMessage: 'x',
      sessionDir,
      attachments: [{ filename: '../../../root/.ssh/id_rsa' }],
      exists: (path) => { seen.push(path); return true },
    })
    expect(seen).toEqual([join(sessionDir, 'id_rsa')])
    expect(result.userMessage.startsWith('<attached_files>')).toBe(true)
    expect(result.userMessage).not.toContain('..')
  })
})
