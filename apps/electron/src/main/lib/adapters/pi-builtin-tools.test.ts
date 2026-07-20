import { describe, expect, mock, test } from 'bun:test'

// automation-scheduler 由 Pi builtin tools 间接导入；Bun 测试环境没有 Electron runtime。
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false },
  clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  safeStorage: {},
  screen: {},
  shell: {},
  systemPreferences: {},
}))

const {
  buildPiKnowledgeBaseTools,
  buildPiTaskGraphTools,
} = await import('./pi-builtin-tools')

interface CapturedTool {
  name: string
  description: string
  execute?: (toolCallId: string, params: unknown) => Promise<unknown>
}

function createPiSdkStub(): {
  sdk: typeof import('@earendil-works/pi-coding-agent')
  tools: CapturedTool[]
} {
  const tools: CapturedTool[] = []
  const sdk = {
    defineTool(tool: CapturedTool): CapturedTool {
      tools.push(tool)
      return tool
    },
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
  return { sdk, tools }
}

describe('Pi Profer in-process tool bridges', () => {
  test('Given Pi runtime When building knowledge tools Then it exposes the session-scoped allowlist tools', () => {
    const { sdk, tools } = createPiSdkStub()

    buildPiKnowledgeBaseTools(sdk, { sessionId: 'pi-knowledge-test' })

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__knowledge-base__list_imported_knowledge',
      'mcp__knowledge-base__read_imported_knowledge',
    ])
  })

  test('Given Pi runtime When building task graph tools Then it exposes Profer structured task tools', () => {
    const { sdk, tools } = createPiSdkStub()

    buildPiTaskGraphTools(sdk, { sessionId: 'pi-task-graph-test' })

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__task-graph__proma_task_create',
      'mcp__task-graph__proma_task_update',
    ])
  })

  test('Given an unknown task ID When Pi requests an update Then it rejects without creating a graph node', async () => {
    const { sdk, tools } = createPiSdkStub()
    buildPiTaskGraphTools(sdk, { sessionId: 'pi-task-graph-unknown-task' })
    const update = tools.find((tool) => tool.name === 'mcp__task-graph__proma_task_update')

    const result = await update?.execute?.('call-1', { taskId: 'not-created', status: 'completed' }) as { details?: { error?: string } }

    expect(result.details?.error).toBe('TASK_NOT_FOUND')
  })
})
