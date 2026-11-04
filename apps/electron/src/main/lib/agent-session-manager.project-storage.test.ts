/**
 * P0：会话消息/任务图/Harness 按会话布局落盘
 *
 * 锁住三条不变量：
 * - project 会话的消息写进 `<root>/.profer/sessions/<sid>/messages.jsonl`；
 * - managed 会话保持 `~/.profer/agent-sessions/<sid>.jsonl` 不变；
 * - 跨工作区迁移时消息文件跟着会话走，迁移后仍能读回。
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
  View: class {},
  WebContentsView: class {},
}))

const sandbox = mkdtempSync(join(tmpdir(), 'profer-project-session-storage-'))
const configRoot = join(sandbox, 'config')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  appendAgentMessage,
  appendSDKMessages,
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  moveSessionToWorkspace,
} = await import('./agent-session-manager')
const { getAgentSessionGraphPath, getAgentSessionMessagesPath, getPiHarnessEventsPath, getPiTranscriptDirForSession } = await import('./config-paths')
const { resolvePiTranscriptPath } = await import('./pi-session-files')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

const indexPath = join(configRoot, 'agent-workspaces.json')
const sessionsIndexPath = join(configRoot, 'agent-sessions.json')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

beforeEach(() => {
  for (const file of [indexPath, sessionsIndexPath]) {
    rmSync(file, { force: true })
    rmSync(`${file}.bak`, { force: true })
    rmSync(`${file}.tmp`, { force: true })
  }
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
  rmSync(join(sandbox, 'projects'), { recursive: true, force: true })
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

function projectEntry(slug: string, rootPath: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'project', rootPath }
}

function managedEntry(slug: string): Record<string, unknown> {
  return { id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1, type: 'personal', storageMode: 'managed' }
}

function appendUserMessage(sessionId: string, text: string): void {
  appendAgentMessage(sessionId, { id: `m-${text}`, role: 'user', content: text, createdAt: Date.now() })
}

describe('会话存储布局', () => {
  test('Given project 工作区 When 新建会话并写消息 Then 落在项目 .profer/sessions/<sid>/messages.jsonl', () => {
    const root = makeProject('p1')
    writeWorkspaces([projectEntry('p1', root), managedEntry('default')])

    const session = createAgentSession('project session', undefined, 'id-p1', undefined, 'pi', false, 'standard')
    appendUserMessage(session.id, 'hello-project')

    const messagesPath = join(root, '.profer', 'sessions', session.id, 'messages.jsonl')
    expect(getAgentSessionMeta(session.id)?.storageLayout).toBe('project')
    expect(getAgentSessionMessagesPath(session.id)).toBe(messagesPath)
    expect(existsSync(messagesPath)).toBe(true)
    expect(readFileSync(messagesPath, 'utf-8')).toContain('hello-project')

    // 全局目录不应出现该会话的消息文件
    expect(existsSync(join(configRoot, 'agent-sessions', `${session.id}.jsonl`))).toBe(false)
    expect(getAgentSessionSDKMessages(session.id).length).toBe(1)

    // 任务图与 Harness 账本同布局
    expect(dirname(getAgentSessionGraphPath(session.id))).toBe(dirname(messagesPath))
    expect(dirname(getPiHarnessEventsPath(session.id))).toBe(dirname(messagesPath))
  })

  test('Given project 会话 When 运行时追加 SDKMessage Then 也落在项目消息文件', () => {
    const root = makeProject('p-runtime')
    writeWorkspaces([projectEntry('p-runtime', root), managedEntry('default')])

    const session = createAgentSession('runtime messages', undefined, 'id-p-runtime', undefined, 'pi', false, 'standard')
    appendSDKMessages(session.id, [{
      type: 'assistant',
      uuid: 'a-runtime',
      message: { content: [{ type: 'text', text: 'runtime-write' }] },
    }] as never)

    const projectPath = join(root, '.profer', 'sessions', session.id, 'messages.jsonl')
    expect(existsSync(projectPath)).toBe(true)
    expect(readFileSync(projectPath, 'utf-8')).toContain('runtime-write')
    // 运行时写入也不能在中央目录留下影子文件
    expect(existsSync(join(configRoot, 'agent-sessions', `${session.id}.jsonl`))).toBe(false)
    expect(getAgentSessionSDKMessages(session.id).length).toBe(1)
  })

  test('Given managed 工作区 When 新建会话并写消息 Then 保持全局 agent-sessions 布局', () => {
    writeWorkspaces([managedEntry('default')])

    const session = createAgentSession('managed session', undefined, 'id-default', undefined, 'pi', false, 'standard')
    appendUserMessage(session.id, 'hello-managed')

    const messagesPath = join(configRoot, 'agent-sessions', `${session.id}.jsonl`)
    expect(getAgentSessionMeta(session.id)?.storageLayout).toBe('managed')
    expect(getAgentSessionMessagesPath(session.id)).toBe(messagesPath)
    expect(existsSync(messagesPath)).toBe(true)
    expect(readFileSync(messagesPath, 'utf-8')).toContain('hello-managed')
  })

  test('Given managed 会话 When 迁移到 project 工作区 Then 消息文件跟着搬，历史仍可读', () => {
    const root = makeProject('p2')
    writeWorkspaces([projectEntry('p2', root), managedEntry('default')])

    const session = createAgentSession('move me', undefined, 'id-default', undefined, 'pi', false, 'standard')
    appendUserMessage(session.id, 'before-move')

    const oldPath = join(configRoot, 'agent-sessions', `${session.id}.jsonl`)
    expect(existsSync(oldPath)).toBe(true)

    const moved = moveSessionToWorkspace(session.id, 'id-p2')
    const newPath = join(root, '.profer', 'sessions', session.id, 'messages.jsonl')

    expect(moved.storageLayout).toBe('project')
    expect(getAgentSessionMessagesPath(session.id)).toBe(newPath)
    expect(existsSync(newPath)).toBe(true)
    expect(existsSync(oldPath)).toBe(false)
    expect(getAgentSessionSDKMessages(session.id).map((message) => message.type)).toContain('user')

    appendUserMessage(session.id, 'after-move')
    expect(readFileSync(newPath, 'utf-8')).toContain('after-move')
  })

  test('Given project 会话 When 解析 Pi transcript Then 落在会话数据目录的 pi/ 下', () => {
    const root = makeProject('p3')
    writeWorkspaces([projectEntry('p3', root), managedEntry('default')])

    const projectSession = createAgentSession('project pi', undefined, 'id-p3', undefined, 'pi', false, 'standard')
    const managedSession = createAgentSession('managed pi', undefined, 'id-default', undefined, 'pi', false, 'standard')

    const projectPiDir = getPiTranscriptDirForSession(projectSession.id)
    expect(projectPiDir).toBe(join(root, '.profer', 'sessions', projectSession.id, 'pi'))
    expect(getPiTranscriptDirForSession(managedSession.id)).toBe(join(configRoot, 'sdk-config', 'sessions', 'pi'))

    // 模拟 Pi SDK 在该目录写入 transcript：resolvePiTranscriptPath 应能按 header 找到
    mkdirSync(projectPiDir, { recursive: true })
    const transcript = join(projectPiDir, '2026-11-04T00-00-00-000Z_sdk-1.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'session', id: 'sdk-1' })}\n`, 'utf-8')
    expect(resolvePiTranscriptPath('sdk-1', undefined, { rootDir: projectPiDir, force: true })).toBe(transcript)
  })

  test('Given project 会话 When 迁移回 managed Then 消息搬回全局 agent-sessions', () => {
    const root = makeProject('p4')
    writeWorkspaces([projectEntry('p4', root), managedEntry('default')])

    const session = createAgentSession('move back', undefined, 'id-p4', undefined, 'pi', false, 'standard')
    appendUserMessage(session.id, 'in-project')
    const projectMessages = join(root, '.profer', 'sessions', session.id, 'messages.jsonl')
    expect(existsSync(projectMessages)).toBe(true)

    const moved = moveSessionToWorkspace(session.id, 'id-default')
    const globalMessages = join(configRoot, 'agent-sessions', `${session.id}.jsonl`)

    expect(moved.storageLayout).toBe('managed')
    expect(existsSync(globalMessages)).toBe(true)
    expect(readFileSync(globalMessages, 'utf-8')).toContain('in-project')
    expect(existsSync(projectMessages)).toBe(false)
    expect(getAgentSessionSDKMessages(session.id).length).toBe(1)
  })

  test('Given 历史 project 会话只有全局消息 When 读取 Then 继续读全局，不因升级丢历史', () => {
    const root = makeProject('legacy')
    writeWorkspaces([projectEntry('legacy', root), managedEntry('default')])

    // 手工种一条没有 storageLayout 标记的历史会话（升级前状态）
    mkdirSync(dirname(sessionsIndexPath), { recursive: true })
    writeFileSync(sessionsIndexPath, JSON.stringify({
      version: 1,
      sessions: [{ id: 'legacy-session', title: 'legacy', workspaceId: 'id-legacy', createdAt: 1, updatedAt: 1 }],
    }), 'utf-8')
    const legacyPath = join(configRoot, 'agent-sessions', 'legacy-session.jsonl')
    mkdirSync(dirname(legacyPath), { recursive: true })
    writeFileSync(legacyPath, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"old"}]}}\n', 'utf-8')

    expect(getAgentSessionMessagesPath('legacy-session')).toBe(legacyPath)
    expect(getAgentSessionSDKMessages('legacy-session').length).toBe(1)
  })
})
