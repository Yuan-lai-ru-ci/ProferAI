/**
 * 修复项 3：Pi transcript 只能从当前项目路径恢复。
 *
 * 项目被整体拷贝/移动后，旧元数据里的 `piSessionFile` 指向旧目录。旧文件可能
 * 仍然存在，但那是另一个项目的数据：不能因为「文件存在」就继续读。
 *
 * 锁住：
 * - 只接受位于当前项目 `<dataDir>/pi/` 内、且 header.id 与 sdkSessionId 一致的 transcript；
 * - 旧绝对路径被忽略，改为在当前项目 pi/ 里按 sdkSessionId + header 重新定位；
 * - 找不到就清空 `piSessionFile` 与 `sdkSessionId`（改用应用内消息历史），旧文件不被删除。
 */
import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'
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
  View: {},
  WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-pi-import-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const { getAgentSessionMeta, reconcileProjectSessionIndexesNow } = await import('./agent-session-manager')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')
const oldRoot = join(sandbox, 'old-machine-project')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [indexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
  rmSync(oldRoot, { recursive: true, force: true })
  invalidateWorkspaceLocation()
})

function makeProject(name: string): string {
  const root = join(sandbox, 'projects', name)
  mkdirSync(join(root, '.profer', 'sessions'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# project\n', 'utf-8')
  return realpathSync(root)
}

function writeWorkspaces(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
  invalidateWorkspaceLocation()
}

function writeSessions(sessions: Array<Record<string, unknown>>): void {
  mkdirSync(dirname(sessionsIndexPath), { recursive: true })
  writeFileSync(sessionsIndexPath, JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function transcript(filePath: string, sessionId: string | undefined): string {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify({ type: 'session', ...(sessionId ? { id: sessionId } : {}) })}\n`, 'utf-8')
  return filePath
}

function seedProject(name: string, sessionId: string, sdkSessionId: string, piSessionFile?: string): string {
  const root = makeProject(name)
  writeWorkspaces([{ id: `id-${name}`, name, slug: name, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root }])
  writeSessions([])
  const dataDir = join(root, '.profer', 'sessions', sessionId)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'messages.jsonl'), '{"type":"user"}\n', 'utf-8')
  writeFileSync(join(dataDir, 'session.json'), JSON.stringify({
    id: sessionId,
    title: '拷来的 Pi 会话',
    workspaceId: 'old-workspace-id',
    storageLayout: 'project',
    agentRuntime: 'pi',
    sdkSessionId,
    ...(piSessionFile ? { piSessionFile } : {}),
    createdAt: 1,
    updatedAt: 2,
  }), 'utf-8')
  return root
}

describe('Pi transcript 导入', () => {
  test('Given 旧绝对路径仍存在且当前项目有匹配 transcript Then 选当前项目路径，旧文件不动', () => {
    const sessionId = 'pi-sess-1'
    const sdkId = 'sdk-old-1'
    const oldTranscript = transcript(join(oldRoot, '.profer', 'sessions', sessionId, 'pi', `old_${sdkId}.jsonl`), sdkId)
    const root = seedProject('pi-a', sessionId, sdkId, oldTranscript)
    const currentTranscript = transcript(join(root, '.profer', 'sessions', sessionId, 'pi', `new_${sdkId}.jsonl`), sdkId)

    reconcileProjectSessionIndexesNow()

    const meta = getAgentSessionMeta(sessionId)
    expect(meta?.piSessionFile).toBe(currentTranscript)
    expect(meta?.sdkSessionId).toBe(sdkId)
    // 旧项目目录里的 transcript 不能被动过
    expect(existsSync(oldTranscript)).toBe(true)
  })

  test('Given 只有旧目录 transcript Then 清空 piSessionFile 与 sdkSessionId，不跨项目读取', () => {
    const sessionId = 'pi-sess-2'
    const sdkId = 'sdk-old-2'
    const oldTranscript = transcript(join(oldRoot, '.profer', 'sessions', sessionId, 'pi', `old_${sdkId}.jsonl`), sdkId)
    seedProject('pi-b', sessionId, sdkId, oldTranscript)

    reconcileProjectSessionIndexesNow()

    const meta = getAgentSessionMeta(sessionId)
    expect(meta?.piSessionFile).toBeUndefined()
    expect(meta?.sdkSessionId).toBeUndefined()
    expect(existsSync(oldTranscript)).toBe(true)
  })

  test('Given 当前项目 transcript 的 header ID 不匹配 Then 不采用，清空 SDK 会话', () => {
    const sessionId = 'pi-sess-3'
    const sdkId = 'sdk-old-3'
    const root = makeProject('pi-c')
    const dataDir = join(root, '.profer', 'sessions', sessionId)
    mkdirSync(join(dataDir, 'pi'), { recursive: true })
    const mismatched = transcript(join(dataDir, 'pi', `x_${sdkId}.jsonl`), 'someone-else')
    writeFileSync(join(dataDir, 'session.json'), JSON.stringify({
      id: sessionId,
      title: '错配 transcript',
      workspaceId: 'old',
      storageLayout: 'project',
      agentRuntime: 'pi',
      sdkSessionId: sdkId,
      piSessionFile: mismatched,
      createdAt: 1,
      updatedAt: 2,
    }), 'utf-8')
    writeWorkspaces([{ id: 'id-pi-c', name: 'pi-c', slug: 'pi-c', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root }])

    reconcileProjectSessionIndexesNow()

    const meta = getAgentSessionMeta(sessionId)
    expect(meta?.piSessionFile).toBeUndefined()
    expect(meta?.sdkSessionId).toBeUndefined()
    // 文件本身不删：可能是别的会话的数据
    expect(existsSync(mismatched)).toBe(true)
  })

  test('Given piSessionFile 指向项目内匹配文件 Then 直接沿用', () => {
    const sessionId = 'pi-sess-4'
    const sdkId = 'sdk-4'
    const root = makeProject('pi-d')
    const dataDir = join(root, '.profer', 'sessions', sessionId)
    const known = transcript(join(dataDir, 'pi', `2026-01-01T00-00-00-000Z_${sdkId}.jsonl`), sdkId)
    writeFileSync(join(dataDir, 'session.json'), JSON.stringify({
      id: sessionId,
      title: '正常会话',
      workspaceId: 'id-pi-d',
      storageLayout: 'project',
      agentRuntime: 'pi',
      sdkSessionId: sdkId,
      piSessionFile: known,
      createdAt: 1,
      updatedAt: 2,
    }), 'utf-8')
    writeWorkspaces([{ id: 'id-pi-d', name: 'pi-d', slug: 'pi-d', createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath: root }])

    reconcileProjectSessionIndexesNow()

    const meta = getAgentSessionMeta(sessionId)
    expect(meta?.piSessionFile).toBe(known)
    expect(meta?.sdkSessionId).toBe(sdkId)
    // sidecar 已被对账写回，路径保持在项目内
    const sidecar = JSON.parse(readFileSync(join(dataDir, 'session.json'), 'utf-8')) as { piSessionFile?: string }
    expect(sidecar.piSessionFile).toBe(known)
  })
})
