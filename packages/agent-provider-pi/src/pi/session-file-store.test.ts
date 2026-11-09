import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as piSdk from '@earendil-works/pi-coding-agent'
import { openPiSessionFile } from './session-file-store'

const sdk = piSdk as unknown as Parameters<typeof openPiSessionFile>[0]['sdk']
/** 参照实现用 SDK 自己的 open()：本文件只让 store 看到最小表面，避免把测试绑死。 */
const referenceSessionManager = piSdk.SessionManager

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'pi-session-store-'))
}

function userMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }
}

function assistantMessage(text: string) {
  return { role: 'assistant' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
}

describe('Profer 独占写 Pi session 文件', () => {
  test('新会话立即可写 header，SDK 自己的 append 不会落盘', () => {
    const dir = scratch()
    const store = openPiSessionFile({ sdk, sessionDir: dir, cwd: '/tmp/cwd' })
    expect(existsSync(store.file)).toBe(true)
    expect(store.file.startsWith(dir)).toBe(true)
    const lines = readLines(store.file)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'session', id: store.sessionId, cwd: '/tmp/cwd' })
    // 文件就在 header 之后被彻底交给 Profer：SessionManager 是内存态。
    expect(store.sessionManager.isPersisted()).toBe(false)
    expect(store.sessionManager.getSessionFile()).toBeUndefined()

    store.sessionManager.appendMessage(userMessage('hello') as never)
    const before = statSync(store.file)
    expect(readLines(store.file)).toHaveLength(1)
    expect(statSync(store.file).size).toBe(before.size)
  })

  test('没有 assistant 的轮次不落盘；有 assistant 后按顺序增量写入且幂等', () => {
    const dir = scratch()
    const store = openPiSessionFile({ sdk, sessionDir: dir, cwd: '/tmp/cwd' })

    store.sessionManager.appendMessage(userMessage('first') as never)
    expect(store.flush()).toBe(0)
    expect(readLines(store.file)).toHaveLength(1)

    store.sessionManager.appendMessage(assistantMessage('reply') as never)
    expect(store.flush()).toBe(2)
    expect(readLines(store.file)).toHaveLength(3)
    expect(store.flush()).toBe(0)

    store.sessionManager.appendMessage(userMessage('second') as never)
    store.sessionManager.appendMessage(assistantMessage('reply2') as never)
    expect(store.flush()).toBe(2)
    const lines = readLines(store.file)
    expect(lines).toHaveLength(5)
    // 落盘内容 = SDK 内存里的 entry 逐字序列化，祖先链完整。
    const entries = store.sessionManager.getEntries()
    expect(lines.slice(1)).toEqual(entries.map((entry) => JSON.stringify(entry)))
    expect(entries[1]!.parentId).toBe(entries[0]!.id)
  })

  test('resume：内存态上下文与 SDK open() 逐字节一致，且新增 entry 只追加不重写前缀', () => {
    const dir = scratch()
    const first = openPiSessionFile({ sdk, sessionDir: dir, cwd: '/tmp/cwd' })
    first.sessionManager.appendMessage(userMessage('q1') as never)
    first.sessionManager.appendMessage(assistantMessage('a1') as never)
    first.flush()
    const originalText = readFileSync(first.file, 'utf8')

    // SDK 自己的 open() 是「参照实现」
    const reference = referenceSessionManager.open(first.file, dir)
    const resumed = openPiSessionFile({ sdk, sessionDir: dir, cwd: '/tmp/cwd', existingFile: first.file })
    expect(resumed.sessionId).toBe(first.sessionId)
    expect(JSON.stringify(resumed.sessionManager.buildContextEntries()))
      .toBe(JSON.stringify(reference.buildContextEntries()))
    expect(resumed.sessionManager.getLeafId()).toBe(reference.getLeafId())

    resumed.sessionManager.appendMessage(userMessage('q2') as never)
    resumed.sessionManager.appendMessage(assistantMessage('a2') as never)
    expect(resumed.flush()).toBe(2)
    const after = readFileSync(resumed.file, 'utf8')
    // prompt cache 依赖前缀稳定：旧内容必须逐字节不变。
    expect(after.startsWith(originalText)).toBe(true)
    // 重新用 SDK 打开：上下文条数与内存态一致（下一轮 resume 的前提）。
    const reopened = referenceSessionManager.open(resumed.file, dir)
    expect(reopened.buildContextEntries().length).toBe(resumed.sessionManager.buildContextEntries().length)
  })

  test('旧版本文件的迁移结果会被回写，避免下一轮生成另一套随机 id', () => {
    const dir = scratch()
    const file = join(dir, 'legacy.jsonl')
    const legacy = [
      JSON.stringify({ type: 'session', version: 1, id: 'legacy-session', timestamp: new Date(0).toISOString(), cwd: '/tmp/cwd' }),
      JSON.stringify({ type: 'message', message: userMessage('old') }),
      JSON.stringify({ type: 'message', message: assistantMessage('old-reply') }),
    ].join('\n')
    writeFileSync(file, `${legacy}\n`, 'utf8')

    const store = openPiSessionFile({ sdk, sessionDir: dir, cwd: '/tmp/cwd', existingFile: file })
    const written = readLines(file)
    expect(JSON.parse(written[0]!)).toMatchObject({ type: 'session', id: 'legacy-session', version: sdk.CURRENT_SESSION_VERSION })
    // 迁移后每行都带 id/parentId，且与内存态一致。
    expect(written.slice(1)).toEqual(store.sessionManager.getEntries().map((entry) => JSON.stringify(entry)))
    expect(JSON.parse(written[1]!).parentId).toBeNull()
    expect(JSON.parse(written[2]!).parentId).toBe(JSON.parse(written[1]!).id)
  })

  test('非 Pi session 文件拒绝接管，不猜测内容', () => {
    const dir = scratch()
    const file = join(dir, 'not-a-session.jsonl')
    writeFileSync(file, `${JSON.stringify({ foo: 'bar' })}\n`, 'utf8')
    expect(() => openPiSessionFile({ sdk, sessionDir: dir, cwd: '/tmp/cwd', existingFile: file }))
      .toThrow(/session header/)
  })
})
