import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type AgentSessionManager = typeof import('./agent-session-manager')

let manager: AgentSessionManager
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV
const originalProferConfigDir = process.env.PROFER_CONFIG_DIR
const appendedCustomMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> = []

// agent-session-manager loads Pi lazily for fork, so this focused fake isolates
// entry-tree semantics without requiring a real Pi session JSONL fixture.
mock.module('@earendil-works/pi-coding-agent', () => ({
  SessionManager: {
    open: (sessionFile: string) => ({
      createBranchedSession: (entryId: string) => {
        const branchFile = join(tempHome, `.pi-branch-${entryId}.jsonl`)
        writeFileSync(branchFile, '', 'utf-8')
        return branchFile
      },
      getSessionFile: () => sessionFile,
      getSessionId: () => 'pi-test-session',
      getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
    }),
    forkFrom: (_branchFile: string) => {
      const forkFile = join(tempHome, '.pi-fork.jsonl')
      writeFileSync(forkFile, '', 'utf-8')
      return {
        getSessionFile: () => forkFile,
        getSessionId: () => 'pi-fork-session',
        getEntry: (entryId: string) => entryId === 'entry-keep' ? { id: entryId } : undefined,
        appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
          appendedCustomMessages.push({ customType, content, display, details })
          return 'interrupted-context'
        },
      }
    },
  },
}))

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeAgentSessionsIndex(sessions: Array<{
  id: string
  title: string
  workspaceId: string
  createdAt: number
  updatedAt: number
  agentRuntime?: string
  sdkSessionId?: string
  piSessionFile?: string
  piEntryBindings?: Record<string, string>
}>): void {
  const dir = join(tempHome, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-sessions.json'), JSON.stringify({ version: 1, sessions }), 'utf-8')
}

function writeAgentWorkspacesIndex(workspaces: Array<{
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
}>): void {
  const dir = join(tempHome, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-workspaces.json'), JSON.stringify({ version: 3, workspaces: workspaces.map((w) => ({ ...w, type: 'personal' })) }), 'utf-8')
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'profer-pi-fork-test-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  process.env.PROFER_CONFIG_DIR = join(tempHome, 'config')
  manager = await import('./agent-session-manager')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  if (originalProferConfigDir === undefined) {
    delete process.env.PROFER_CONFIG_DIR
  } else {
    process.env.PROFER_CONFIG_DIR = originalProferConfigDir
  }
  rmSync(tempHome, { recursive: true, force: true })
})

beforeEach(() => {
  appendedCustomMessages.length = 0
})

describe('Pi 会话分叉', () => {
  test('Given Pi 会话有 entry bindings 和 artifact When 分叉 Then 创建新会话并持久化 branch 元数据', async () => {
    writeAgentWorkspacesIndex([
      { id: 'workspace-a', name: '工作区 A', slug: 'workspace-a', createdAt: 1, updatedAt: 1 },
    ])
    writeAgentSessionsIndex([{
      id: 'pi-source-session',
      title: 'Pi 源会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-session.jsonl'),
      piEntryBindings: {
        'assistant-1': 'entry-keep',
        'assistant-2': 'entry-removed',
      },
    }])
    mkdirSync(join(tempHome, '.profer', 'agent-workspaces', 'workspace-a', 'pi-source-session'), { recursive: true })
    // 源 Pi session artifact 必须真实存在，forkPiAgentSession 会 existsSync 校验。
    writeFileSync(join(tempHome, 'pi-session.jsonl'), '', 'utf-8')

    const forked = await manager.forkAgentSession({
      sessionId: 'pi-source-session',
      upToMessageUuid: 'assistant-1',
    })

    expect(forked.id).not.toBe('pi-source-session')
    expect(forked.agentRuntime).toBe('pi')
    expect(forked.sdkSessionId).toBe('pi-fork-session')
    expect(forked.piSessionFile).toBe(join(tempHome, '.pi-fork.jsonl'))
    // 新 branch 只保留分叉点之前的 entry 映射。
    expect(forked.piEntryBindings).toEqual({ 'assistant-1': 'entry-keep' })
    expect(existsSync(forked.piSessionFile!)).toBe(true)

    const persisted = manager.getAgentSessionMeta(forked.id)
    expect(persisted).toMatchObject({
      sdkSessionId: 'pi-fork-session',
      piEntryBindings: { 'assistant-1': 'entry-keep' },
      forkSourceDir: join(tempHome, 'config', 'agent-workspaces', 'workspace-a', 'pi-source-session'),
    })
  })

  test('Given Pi 会话缺 piEntryBindings When 分叉 Then 拒绝并提示先继续一次对话', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-no-bindings',
      title: 'Pi 无映射会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-session.jsonl'),
    }])

    await expect(manager.forkAgentSession({
      sessionId: 'pi-no-bindings',
      upToMessageUuid: 'assistant-1',
    })).rejects.toThrow('尚无可用的 entry ID 映射')
  })

  test('Given Pi 会话缺 piSessionFile When 分叉 Then 拒绝', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-no-artifact',
      title: 'Pi 无 artifact 会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piEntryBindings: { 'assistant-1': 'entry-keep' },
    }])

    await expect(manager.forkAgentSession({
      sessionId: 'pi-no-artifact',
      upToMessageUuid: 'assistant-1',
    })).rejects.toThrow('未找到 Pi session artifact')
  })

  test('Given Pi 分叉未指定目标消息 When 分叉 Then 拒绝', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-no-target',
      title: 'Pi 无目标会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-session.jsonl'),
      piEntryBindings: { 'assistant-1': 'entry-keep' },
    }])

    await expect(manager.forkAgentSession({
      sessionId: 'pi-no-target',
    })).rejects.toThrow('需要指定一条已完成的 assistant 消息')
  })

  test('Given Pi 中断消息没有 entry binding When 分叉 Then 从上一个完整 entry 建分支并保留中断文本上下文', async () => {
    writeAgentSessionsIndex([{
      id: 'pi-interrupted-session',
      title: 'Pi 中断会话',
      workspaceId: 'workspace-a',
      createdAt: 1,
      updatedAt: 1,
      agentRuntime: 'pi',
      sdkSessionId: 'pi-session-id',
      piSessionFile: join(tempHome, 'pi-interrupted-session.jsonl'),
      piEntryBindings: { 'assistant-complete': 'entry-keep' },
    }])
    mkdirSync(join(tempHome, 'config', 'agent-workspaces', 'workspace-a', 'pi-interrupted-session'), { recursive: true })
    writeFileSync(join(tempHome, 'pi-interrupted-session.jsonl'), '', 'utf-8')
    mkdirSync(join(tempHome, 'config', 'agent-sessions'), { recursive: true })
    writeFileSync(join(tempHome, 'config', 'agent-sessions', 'pi-interrupted-session.jsonl'), [
      JSON.stringify({ type: 'assistant', uuid: 'assistant-complete', message: { content: [{ type: 'text', text: '完整回复' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-interrupted', message: { content: [{ type: 'text', text: '暂停前的部分回复' }] } }),
    ].join('\n') + '\n', 'utf-8')

    const forked = await manager.forkAgentSession({
      sessionId: 'pi-interrupted-session',
      upToMessageUuid: 'assistant-interrupted',
    })

    expect(forked.agentRuntime).toBe('pi')
    expect(appendedCustomMessages).toEqual([{
      customType: 'profer-interrupted-assistant-context',
      content: expect.stringContaining('暂停前的部分回复'),
      display: false,
      details: { sourceAssistantUuid: 'assistant-interrupted' },
    }])
  })
})
