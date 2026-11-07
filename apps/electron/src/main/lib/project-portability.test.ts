/**
 * 可移植项目：把带 `.profer/` 的文件夹拷到另一台电脑（新配置根、新项目路径）后，
 * 不依赖全局索引/全局 blob，也能恢复会话列表、历史、Pi transcript 与预设归属。
 *
 * 这里手工构造一份“拷来的项目”，只给新机器一个空全局索引，验证对账逻辑。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  View: class {},
  WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-portability-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

mkdirSync(join(sandbox, 'copied-project'), { recursive: true })
const root = realpathSync(join(sandbox, 'copied-project'))
const sessionId = '11111111-2222-4333-8444-555555555555'
const piSessionId = 'pi-session-portable'
const oldRoot = '/Users/someone-else/old-project'
const oldSlug = 'old-machine-slug'

let manager: typeof import('./agent-session-manager')
let configPaths: typeof import('./config-paths')
let blobStore: typeof import('./blob-store')
let payload: typeof import('./session-payload-externalize')
let portableBlobHash = ''
let legacyBlobHash = ''
let portableFullText = ''

beforeAll(async () => {
  manager = await import('./agent-session-manager')
  configPaths = await import('./config-paths')
  blobStore = await import('./blob-store')
  payload = await import('./session-payload-externalize')

  // 新机器：项目被放在不同绝对路径下
  const dataDir = join(root, '.profer', 'sessions', sessionId)
  const piDir = join(dataDir, 'pi')
  mkdirSync(piDir, { recursive: true })
  writeFileSync(join(root, '.profer', 'profer.json'), JSON.stringify({
    schema: 'profer.project/1', name: 'copied-project', createdAt: '2026-01-01T00:00:00.000Z', proferVersion: '0.16.19',
  }, null, 2))
  writeFileSync(join(dataDir, 'pi', `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`), `${JSON.stringify({ type: 'session', id: piSessionId })}\n`, 'utf-8')

  // 大载荷：原文在项目 .profer/blobs，消息行只留片段 + 引用
  const fullText = `PORTABLE-BLOB-${'x'.repeat(300_000)}`
  portableFullText = fullText
  const hash = blobStore.hashOfBlobContent(fullText)
  portableBlobHash = hash
  const blobPath = blobStore.blobPathFor(hash, join(root, '.profer', 'blobs'))
  mkdirSync(dirname(blobPath), { recursive: true })
  writeFileSync(blobPath, fullText, 'utf-8')
  const message = {
    type: 'assistant',
    uuid: 'assistant-1',
    message: { content: [{ type: 'text', text: 'PORTABLE-BLOB-preview' }] },
    [payload.BLOB_REFS_FIELD]: [{
      path: 'message.content[0].text', hash, chars: fullText.length, bytes: Buffer.byteLength(fullText),
    }],
  }
  writeFileSync(join(dataDir, 'messages.jsonl'), `${JSON.stringify(message)}\n`, 'utf-8')

  // 旧机器的元数据：旧 workspaceId、旧绝对路径、旧 slug、失效的附件/检查点
  writeFileSync(join(dataDir, 'session.json'), JSON.stringify({
    id: sessionId,
    title: '拷来的会话',
    workspaceId: 'old-workspace-id',
    storageLayout: 'project',
    agentRuntime: 'pi',
    sdkSessionId: piSessionId,
    piSessionFile: join(oldRoot, '.profer', 'sessions', sessionId, 'pi', `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`),
    piEntryBindings: { 'assistant-1': 'entry-1' },
    piFileCheckpoints: { 'entry-1': join('/Users/someone-else/checkpoints', sessionId, 'cp-1') },
    attachedDirectories: ['/Users/someone-else/notes', root],
    attachedFiles: ['/Users/someone-else/file.txt'],
    forkSourceDir: oldRoot,
    presetId: 'standard',
    presetReference: { presetId: 'standard', presetScope: 'workspace', workspaceSlug: oldSlug },
    createdAt: 1,
    updatedAt: 2,
  }, null, 2), 'utf-8')

  // 新机器只有空全局会话索引，项目内故意不放 index.json
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(join(configRoot, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions: [] }), 'utf-8')
  writeFileSync(join(configRoot, 'agent-workspaces.json'), JSON.stringify({
    version: 4,
    workspaces: [{
      id: 'new-workspace-id', name: 'copied-project', slug: 'copied-project',
      createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root,
    }],
  }), 'utf-8')
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('可移植项目', () => {
  test('Given 只拷了项目文件夹 When 新机器打开 Then 从 session.json 恢复会话并修复路径', async () => {
    const { invalidateWorkspaceLocation } = await import('./workspace-locator')
    invalidateWorkspaceLocation()
    manager.reconcileProjectSessionIndexesNow()

    const meta = manager.getAgentSessionMeta(sessionId)
    expect(meta).toBeDefined()
    expect(meta!.workspaceId).toBe('new-workspace-id')
    expect(meta!.storageLayout).toBe('project')
    expect(meta!.title).toBe('拷来的会话')

    // Pi transcript 按 sdkSessionId 在新项目内重新定位
    expect(meta!.piSessionFile).toBe(join(root, '.profer', 'sessions', sessionId, 'pi', `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`))
    expect(existsSync(meta!.piSessionFile!)).toBe(true)

    // 失效的旧机器路径被清掉，项目内仍存在的附件保留
    expect(meta!.piFileCheckpoints).toBeUndefined()
    expect(meta!.attachedDirectories).toEqual([root])
    expect(meta!.attachedFiles).toBeUndefined()
    expect(meta!.forkSourceDir).toBeUndefined()

    // 工作区级预设引用改指新 slug
    expect(meta!.presetReference?.workspaceSlug).toBe('copied-project')

    // 历史消息可读，项目内 blob 可还原
    expect(await blobStore.readBlob(portableBlobHash)).toBe(portableFullText)
    const messages = manager.getAgentSessionSDKMessages(sessionId)
    expect(messages).toHaveLength(1)
    const resolved = await manager.resolveMessageBlobs(messages[0]!)
    const text = (resolved as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
    expect(text?.startsWith('PORTABLE-BLOB-')).toBe(true)
    expect(text?.length).toBeGreaterThan(300_000)
  })

  test('Given 旧消息的 blob 只在全局目录 When 执行可移植性检查 Then 复制进项目', async () => {
    const legacyText = `LEGACY-GLOBAL-BLOB-${'z'.repeat(300_000)}`
    legacyBlobHash = blobStore.hashOfBlobContent(legacyText)
    const globalBlobPath = blobStore.blobPathFor(legacyBlobHash, join(configRoot, 'blobs'))
    mkdirSync(dirname(globalBlobPath), { recursive: true })
    writeFileSync(globalBlobPath, legacyText, 'utf-8')

    const messagesPath = join(root, '.profer', 'sessions', sessionId, 'messages.jsonl')
    const legacyMessage = {
      type: 'assistant',
      uuid: 'assistant-legacy',
      message: { content: [{ type: 'text', text: 'legacy-preview' }] },
      [payload.BLOB_REFS_FIELD]: [{
        path: 'message.content[0].text', hash: legacyBlobHash, chars: legacyText.length, bytes: Buffer.byteLength(legacyText),
      }],
    }
    writeFileSync(messagesPath, `${JSON.stringify(legacyMessage)}\n`, { flag: 'a' })

    const result = await manager.ensureProjectSessionPortability('new-workspace-id')
    expect(result.copiedBlobs).toBeGreaterThan(0)
    expect(existsSync(blobStore.blobPathFor(legacyBlobHash, join(root, '.profer', 'blobs')))).toBe(true)

    const messages = manager.getAgentSessionSDKMessages(sessionId)
    const resolved = await manager.resolveMessageBlobs(messages[messages.length - 1]!)
    const text = (resolved as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text
    expect(text).toBe(legacyText)
  })

  test('Given 项目里没有 index.json When 再对账 Then 不重复、不丢会话', async () => {
    manager.reconcileProjectSessionIndexesNow()
    const sessions = manager.listAgentSessions().filter((session) => session.workspaceId === 'new-workspace-id')
    expect(sessions.map((session) => session.id)).toEqual([sessionId])
    // 对账后应补写项目索引与每会话元数据
    expect(existsSync(join(root, '.profer', 'sessions', 'index.json'))).toBe(true)
    expect(existsSync(join(root, '.profer', 'sessions', sessionId, 'session.json'))).toBe(true)
    expect(readFileSync(join(root, '.profer', 'sessions', sessionId, 'session.json'), 'utf-8')).toContain('copied-project')
  })
})
