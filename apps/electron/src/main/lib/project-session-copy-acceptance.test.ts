/**
 * 跨路径复制验收：把带 `.profer/` 的项目文件夹整体拷到另一个绝对路径，
 * 旧目录仍然存在，只在新机器配置根里注册新路径。
 *
 * 验收点（对应修复方案第 7 步）：
 * - 会话列表从新项目恢复，归属新工作区；
 * - 消息、任务图、Harness、Pi transcript、blob 都从新路径读取；
 * - 旧路径的文件仍在，且不会被新会话读到（不串读）。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: {},
  WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-copy-acceptance-'))
const configRoot = join(sandbox, 'machine-b-config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const sdkSessionId = 'pi-copy-session'
const sourceRoot = join(sandbox, 'machine-a', 'project')
const copiedRoot = join(sandbox, 'machine-b', 'project')
const sourceDataDir = join(sourceRoot, '.profer', 'sessions', sessionId)
/** 项目根由 locator realpath 归一化（macOS /var → /private/var），断言也走真实路径。 */
const copiedDataDir = (): string => join(realpathSync(copiedRoot), '.profer', 'sessions', sessionId)
const piFileName = `2026-11-05T00-00-00-000Z_${sdkSessionId}.jsonl`
const fullText = `COPIED-BLOB-${'q'.repeat(300_000)}`
let blobHash = ''

let manager: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')
let blobStore: typeof import('./blob-store')
let payload: typeof import('./session-payload-externalize')
let projectIndex: typeof import('./project-session-index')

function seedProject(root: string, dataDir: string, marker: string, blobRoot: string): void {
  mkdirSync(join(dataDir, 'pi'), { recursive: true })
  writeFileSync(join(root, '.profer', 'profer.json'), JSON.stringify({
    schema: 'profer.project/1', name: 'copied', createdAt: '2026-01-01T00:00:00.000Z', proferVersion: '0.16.19',
  }), 'utf-8')
  writeFileSync(join(dataDir, 'pi', piFileName), `${JSON.stringify({ type: 'session', id: sdkSessionId })}\n${JSON.stringify({ type: 'message', content: marker })}\n`, 'utf-8')
  const message = {
    type: 'assistant',
    uuid: `assistant-${marker}`,
    message: { content: [{ type: 'text', text: `${marker}-preview` }] },
    [payload.BLOB_REFS_FIELD]: [{
      path: 'message.content[0].text', hash: blobHash, chars: fullText.length, bytes: Buffer.byteLength(fullText),
    }],
  }
  writeFileSync(join(dataDir, 'messages.jsonl'), `${JSON.stringify(message)}\n`, 'utf-8')
  writeFileSync(join(dataDir, `${sessionId}-graph.jsonl`), `{"type":"task_created","marker":"${marker}"}\n`, 'utf-8')
  writeFileSync(join(dataDir, `${sessionId}-pi-harness.jsonl`), `{"type":"run","marker":"${marker}"}\n`, 'utf-8')
  writeFileSync(join(dataDir, 'session.json'), JSON.stringify({
    id: sessionId,
    title: '拷走的会话',
    workspaceId: 'old-workspace-id',
    storageLayout: 'project',
    agentRuntime: 'pi',
    sdkSessionId,
    piSessionFile: join(root, '.profer', 'sessions', sessionId, 'pi', piFileName),
    createdAt: 1,
    updatedAt: 2,
  }), 'utf-8')
  const blobPath = blobStore.blobPathFor(blobHash, join(blobRoot, '.profer', 'blobs'))
  mkdirSync(dirname(blobPath), { recursive: true })
  writeFileSync(blobPath, fullText, 'utf-8')
}

beforeAll(async () => {
  manager = await import('./agent-session-manager')
  configPaths = await import('./config-paths')
  blobStore = await import('./blob-store')
  payload = await import('./session-payload-externalize')
  projectIndex = await import('./project-session-index')

  blobHash = blobStore.hashOfBlobContent(fullText)
  // 源项目：模拟另一台机器上的完整项目文件夹
  seedProject(sourceRoot, sourceDataDir, 'OLD', sourceRoot)
  // 整体拷贝到新路径（旧目录保留）
  mkdirSync(dirname(copiedRoot), { recursive: true })
  cpSync(sourceRoot, copiedRoot, { recursive: true })
  // 把新路径的数据改成可区分的内容，证明读取的是新路径
  writeFileSync(join(copiedDataDir(), 'pi', piFileName), `${JSON.stringify({ type: 'session', id: sdkSessionId })}\n${JSON.stringify({ type: 'message', content: 'NEW' })}\n`, 'utf-8')
  writeFileSync(join(copiedDataDir(), `${sessionId}-graph.jsonl`), '{"type":"task_created","marker":"NEW"}\n', 'utf-8')
  writeFileSync(join(copiedDataDir(), `${sessionId}-pi-harness.jsonl`), '{"type":"run","marker":"NEW"}\n', 'utf-8')

  // 新机器：只有空全局索引 + 指向新路径的项目注册
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(join(configRoot, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions: [] }), 'utf-8')
  writeFileSync(join(configRoot, 'agent-workspaces.json'), JSON.stringify({
    version: 4,
    workspaces: [{
      id: 'new-workspace-id', name: 'copied', slug: 'copied',
      createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: realpathSync(copiedRoot),
    }],
  }), 'utf-8')

  manager.reconcileProjectSessionIndexesNow()
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('项目整体复制验收', () => {
  test('Given 项目被拷到新路径 When 新机器打开 Then 会话归属与各组件都指向新路径', () => {
    const meta = manager.getAgentSessionMeta(sessionId)
    expect(meta).toBeDefined()
    expect(meta!.workspaceId).toBe('new-workspace-id')
    expect(meta!.storageLayout).toBe('project')

    expect(configPaths.getAgentSessionMessagesPath(sessionId)).toBe(join(copiedDataDir(), 'messages.jsonl'))
    expect(configPaths.getAgentSessionGraphPath(sessionId)).toBe(join(copiedDataDir(), `${sessionId}-graph.jsonl`))
    expect(configPaths.getPiHarnessEventsPath(sessionId)).toBe(join(copiedDataDir(), `${sessionId}-pi-harness.jsonl`))
    expect(configPaths.getPiTranscriptDirForSession(sessionId)).toBe(join(copiedDataDir(), 'pi'))
    expect(meta!.piSessionFile).toBe(join(copiedDataDir(), 'pi', piFileName))

    // 内容确实来自新路径
    expect(readFileSync(configPaths.getAgentSessionGraphPath(sessionId), 'utf-8')).toContain('"marker":"NEW"')
    expect(readFileSync(configPaths.getPiHarnessEventsPath(sessionId), 'utf-8')).toContain('"marker":"NEW"')
    expect(readFileSync(meta!.piSessionFile!, 'utf-8')).toContain('"content":"NEW"')

    // 旧路径文件仍在，且没有被读取/改写
    expect(existsSync(join(sourceDataDir, 'messages.jsonl'))).toBe(true)
    expect(readFileSync(join(sourceDataDir, `${sessionId}-graph.jsonl`), 'utf-8')).toContain('"marker":"OLD"')
    expect(readFileSync(join(sourceDataDir, 'pi', piFileName), 'utf-8')).toContain('"content":"OLD"')

    // 项目索引归属新工作区
    const sessions = projectIndex.readProjectSessionIndex(copiedRoot) ?? []
    expect(sessions.map((session) => session.id)).toEqual([sessionId])
    expect(sessions[0]?.workspaceId).toBe('new-workspace-id')
  })

  test('Given 复制后的项目 When 读取历史消息 Then blob 从新项目还原', async () => {
    const messages = manager.getAgentSessionSDKMessages(sessionId)
    expect(messages).toHaveLength(1)
    const resolved = await manager.resolveMessageBlobs(messages[0]!)
    const text = (resolved as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
    expect(text).toBe(fullText)
    expect(existsSync(blobStore.blobPathFor(blobHash, join(realpathSync(copiedRoot), '.profer', 'blobs')))).toBe(true)
  })
})
