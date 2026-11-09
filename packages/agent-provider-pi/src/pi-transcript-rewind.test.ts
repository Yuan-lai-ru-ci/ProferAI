import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findPiSessionFile, rewindPiTranscript } from './pi-transcript-rewind'
import { openPiSessionFile } from './pi/session-file-store'

interface Entry {
  type: string
  id: string
  parentId: string | null
  [key: string]: unknown
}

const SESSION_ID = 'session-01a1bc8c'

function entry(id: string, parentId: string | null, extra: Record<string, unknown> = {}): Entry {
  return { type: 'message', id, parentId, ...extra }
}

/** 建一个临时 Pi 目录：header + 分支树（含未激活分支）。 */
function createFixture(lines: string[] = [], options: { sessionId?: string; subdir?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-rewind-'))
  const dir = options.subdir ? join(root, options.subdir) : root
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `2026-11-08T19-04-28-249Z_${options.sessionId ?? SESSION_ID}.jsonl`)
  const header = JSON.stringify({ type: 'session', version: 3, id: options.sessionId ?? SESSION_ID, cwd: '/tmp/cwd' })
  writeFileSync(file, `${[header, ...lines].join('\n')}\n`, 'utf8')
  return { root, dir, file }
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
}

describe('findPiSessionFile', () => {
  test('按 header id 递归定位（不依赖文件名与 id 猜测）', () => {
    const fixture = createFixture([JSON.stringify(entry('a1', null))], { subdir: 'nested/deep' })
    expect(findPiSessionFile(fixture.root, SESSION_ID)).toBe(fixture.file)
    expect(findPiSessionFile(fixture.root, 'another-session')).toBeUndefined()
    expect(findPiSessionFile(join(fixture.root, 'missing'), SESSION_ID)).toBeUndefined()
  })
})

describe('rewindPiTranscript', () => {
  test('保留 header + 目标 entry 的祖先链，丢弃未激活分支与后续 entry', () => {
    const lines = [
      JSON.stringify(entry('m0', null)),
      JSON.stringify(entry('u1', 'm0')),
      JSON.stringify(entry('a1', 'u1')),
      JSON.stringify(entry('u2', 'a1')),
      JSON.stringify(entry('a2', 'u2')),
      // 分支：在 a1 之后另开一条（用户改写后重发）
      JSON.stringify(entry('u2b', 'a1')),
      JSON.stringify(entry('a2b', 'u2b')),
    ]
    const fixture = createFixture(lines)
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: 'a1' })
    expect(result.ok).toBe(true)
    expect(result.kept).toBe(3)
    expect(result.removed).toBe(4)
    const keptLines = readLines(fixture.file)
    expect(keptLines).toHaveLength(4)
    expect(JSON.parse(keptLines[0]!).type).toBe('session')
    expect(keptLines.slice(1).map((line) => JSON.parse(line).id)).toEqual(['m0', 'u1', 'a1'])
    // Profer 是唯一写入者：回退不再整份备份（备份只会制造第二份真相）
    expect(readdirSync(fixture.root).filter((name) => name.includes('.rewind-backup-'))).toHaveLength(0)
    expect(readdirSync(fixture.root).filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })

  test('entryId=null 只保留 header（回到会话开始）', () => {
    const fixture = createFixture([JSON.stringify(entry('m0', null)), JSON.stringify(entry('u1', 'm0'))])
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: null })
    expect(result.ok).toBe(true)
    expect(result.kept).toBe(0)
    const keptLines = readLines(fixture.file)
    expect(keptLines).toHaveLength(1)
    expect(JSON.parse(keptLines[0]!).id).toBe(SESSION_ID)
  })

  test('entry 不存在时失败且不改文件', () => {
    const fixture = createFixture([JSON.stringify(entry('m0', null))])
    const before = readFileSync(fixture.file, 'utf8')
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('找不到 entry')
    expect(readFileSync(fixture.file, 'utf8')).toBe(before)
    expect(readdirSync(fixture.root).some((name) => name.includes('.rewind-backup-'))).toBe(false)
  })

  test('祖先链断裂时失败且不改文件', () => {
    const fixture = createFixture([JSON.stringify(entry('m0', null)), JSON.stringify(entry('u1', 'missing-parent'))])
    const before = readFileSync(fixture.file, 'utf8')
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('祖先链断裂')
    expect(readFileSync(fixture.file, 'utf8')).toBe(before)
  })

  test('祖先链成环时失败', () => {
    const fixture = createFixture([JSON.stringify(entry('x', 'y')), JSON.stringify(entry('y', 'x'))])
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: 'x' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('环')
  })

  test('坏行被跳过并计入 removed，不会毁掉整个文件', () => {
    const fixture = createFixture([
      JSON.stringify(entry('m0', null)),
      '{ 这不是 JSON',
      JSON.stringify(entry('u1', 'm0')),
    ])
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: 'u1' })
    expect(result.ok).toBe(true)
    expect(result.kept).toBe(2)
    expect(result.removed).toBe(1)
    expect(readLines(fixture.file).slice(1).map((line) => JSON.parse(line).id)).toEqual(['m0', 'u1'])
  })

  test('首行不是 session header 的文件不会被当成 Pi session（拒绝截断）', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-rewind-'))
    const file = join(root, `x_${SESSION_ID}.jsonl`)
    const before = `${JSON.stringify(entry('m0', null))}\n`
    writeFileSync(file, before, 'utf8')
    const result = rewindPiTranscript({ piSessionDir: root, sdkSessionId: SESSION_ID, entryId: null })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('未找到')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  test('已经是目标状态时不写文件、不产生备份', () => {
    const fixture = createFixture([JSON.stringify(entry('m0', null))])
    const before = readFileSync(fixture.file, 'utf8')
    const result = rewindPiTranscript({ piSessionDir: fixture.root, sdkSessionId: SESSION_ID, entryId: 'm0' })
    expect(result.ok).toBe(true)
    expect(result.removed).toBe(0)
    expect(readFileSync(fixture.file, 'utf8')).toBe(before)
    expect(readdirSync(fixture.root).some((name) => name.includes('.rewind-backup-'))).toBe(false)
    expect(existsSync(fixture.file)).toBe(true)
  })

  test('找不到 session 文件时返回失败', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-rewind-'))
    const result = rewindPiTranscript({ piSessionDir: root, sdkSessionId: SESSION_ID, entryId: null })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('未找到')
  })
})

/* ------------------------------------------------------------------------------------------------
 * 回退 = 按保留历史重建文件（Profer 独占写入后不再有「条数校验 + 整份还原」）
 *
 * fixture 一律用 SDK 自己的 SessionManager append 出来，不手搓 entry 结构——否则测的是想象。
 * ------------------------------------------------------------------------------------------------ */

const REBUILD_SESSION_ID = 'session-p6rebuild'

type PiStep = 'user' | 'assistant' | 'toolResult'

/** 用 Pi SDK 真实落盘一个 session：header 由 SDK 写，随后按步骤 append 真实 message entry。 */
async function createSdkSession(steps: PiStep[]) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const dir = mkdtempSync(join(tmpdir(), 'pi-rebuild-'))
  const manager = sdk.SessionManager.create('/tmp/pi-rebuild-cwd', dir, { id: REBUILD_SESSION_ID })
  const ids: string[] = []
  steps.forEach((step, index) => {
    const timestamp = Date.now()
    const id = step === 'user'
      ? manager.appendMessage({ role: 'user', content: [{ type: 'text', text: `u${index}` }], timestamp } as never)
      : step === 'assistant'
        ? manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `a${index}` }],
          provider: 'deepseek',
          model: 'deepseek-flash',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          stopReason: 'stop',
          timestamp,
        } as never)
        : manager.appendMessage({
          role: 'toolResult',
          toolCallId: `call-${index}`,
          content: [{ type: 'text', text: `t${index}` }],
          isError: false,
          timestamp,
        } as never)
    ids.push(id)
  })
  const file = manager.getSessionFile()
  if (!file) throw new Error('fixture 没有生成 session 文件')
  return { dir, file, ids: ids as string[] }
}

/** 用 SDK 的口径读截断后文件的上下文角色（= 真正参与 LLM 上下文的对话条目）。 */
async function sdkContextRoles(file: string): Promise<string[]> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const manager = sdk.SessionManager.open(file, dirname(file))
  return manager.buildContextEntries().flatMap((entry) => entry.type === 'message'
    ? [String((entry as { message: { role: string } }).message.role)]
    : [])
}

function rewindResidue(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.rewind-backup-') || name.endsWith('.tmp'))
}

describe('回退后文件由 Profer 重建', () => {
  test('截断到目标 entry 的祖先链：上下文只剩保留部分，且不留备份/临时文件', async () => {
    const fixture = await createSdkSession(['user', 'assistant', 'toolResult', 'user', 'assistant'])
    const result = rewindPiTranscript({
      piSessionDir: fixture.dir,
      sdkSessionId: REBUILD_SESSION_ID,
      entryId: fixture.ids[1]!,
    })
    expect(result.ok).toBe(true)
    expect(result.keptMessages).toBe(2)
    expect(await sdkContextRoles(fixture.file)).toEqual(['user', 'assistant'])
    expect(rewindResidue(fixture.dir)).toEqual([])
  })

  test('回到会话开始：只留 header，SDK 读出的上下文为空', async () => {
    const fixture = await createSdkSession(['user', 'assistant', 'user', 'assistant'])
    const result = rewindPiTranscript({
      piSessionDir: fixture.dir,
      sdkSessionId: REBUILD_SESSION_ID,
      entryId: null,
    })
    expect(result.ok).toBe(true)
    expect(await sdkContextRoles(fixture.file)).toEqual([])
    expect(readFileSync(fixture.file, 'utf8').split('\n').filter((line) => line.length > 0)).toHaveLength(1)
    expect(rewindResidue(fixture.dir)).toEqual([])
  })

  test('回退后继续一轮：Profer 从重建结果 resume，上下文与 Profer 保留历史一致', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const fixture = await createSdkSession(['user', 'assistant', 'user', 'assistant'])
    const rewound = rewindPiTranscript({
      piSessionDir: fixture.dir,
      sdkSessionId: REBUILD_SESSION_ID,
      entryId: fixture.ids[1]!,
    })
    expect(rewound.ok).toBe(true)
    const rewoundText = readFileSync(fixture.file, 'utf8')

    // Profer 侧接手：内存态会话 + 自己在 turn 边界追加
    const store = openPiSessionFile({
      sdk: sdk as unknown as Parameters<typeof openPiSessionFile>[0]['sdk'],
      sessionDir: fixture.dir,
      cwd: '/tmp/pi-rebuild-cwd',
      existingFile: fixture.file,
    })
    expect(store.sessionId).toBe(REBUILD_SESSION_ID)
    expect(store.sessionManager.buildContextEntries().length).toBe(2)
    store.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'next' }], timestamp: Date.now() } as never)
    store.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'next-reply' }],
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as never)
    expect(store.flush()).toBe(2)
    // 回退结果作为前缀逐字节保留 → 续聊不会破坏 prompt cache 依赖的前缀。
    expect(readFileSync(fixture.file, 'utf8').startsWith(rewoundText)).toBe(true)
    expect(await sdkContextRoles(fixture.file)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('结构异常（entry 不存在 / 祖先链断裂）失败且主文件保持原样', async () => {
    const fixture = await createSdkSession(['user', 'assistant'])
    const before = readFileSync(fixture.file)
    const missing = rewindPiTranscript({
      piSessionDir: fixture.dir,
      sdkSessionId: REBUILD_SESSION_ID,
      entryId: 'missing-entry',
    })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toContain('找不到 entry')
    expect(readFileSync(fixture.file).equals(before)).toBe(true)

    writeFileSync(fixture.file, `${readFileSync(fixture.file, 'utf8')}${JSON.stringify({ type: 'message', id: 'orphan', parentId: 'gone', message: { role: 'user' } })}\n`, 'utf8')
    const broken = readFileSync(fixture.file)
    const result = rewindPiTranscript({
      piSessionDir: fixture.dir,
      sdkSessionId: REBUILD_SESSION_ID,
      entryId: 'orphan',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('祖先链断裂')
    expect(readFileSync(fixture.file).equals(broken)).toBe(true)
    expect(rewindResidue(fixture.dir)).toEqual([])
  })

  test('session 文件不存在：失败且不创建任何文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-rebuild-'))
    const result = rewindPiTranscript({ piSessionDir: dir, sdkSessionId: 'session-not-there', entryId: null })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('未找到')
    expect(readdirSync(dir)).toEqual([])
  })
})
