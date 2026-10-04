import { describe, expect, test } from 'bun:test'
import { createVisualizationIpcHandlers } from './visualization-ipc'

const sender = { isDestroyed: () => false, mainFrame: {} }
const mainWindow = { isDestroyed: () => false, webContents: sender }
const event = { sender, senderFrame: sender.mainFrame } as any

async function expectRejected(action: () => unknown): Promise<void> {
  let rejected = false
  try { await action() } catch { rejected = true }
  expect(rejected).toBe(true)
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ kind: string; value: unknown }> = []
  const handlers = createVisualizationIpcHandlers({
    getMainWindow: () => mainWindow,
    getSession: (id: string) => id === 'session-a' ? { id, workspaceId: 'workspace-a' } as any : undefined,
    getWorkspace: (id: string) => id === 'workspace-a' ? { slug: 'workspace-a' } as any : undefined,
    getSessionWorkspacePath: (_slug: string, id: string) => `/controlled/${id}`,
    getVisualizationStorePath: (id: string) => `/controlled-visualizations/${id}`,
    list: async (ctx: any) => { calls.push({ kind: 'list', value: ctx }); return [] },
    read: async (ctx: any, id: string, revision?: string) => { calls.push({ kind: 'read', value: { ctx, id, revision } }); return { record: { title: 'A' }, html: '<html></html>' } as any },
    readViewState: async () => ({}),
    saveViewState: async (_ctx: any, id: string, revision: string, state: unknown) => { calls.push({ kind: 'save', value: { id, revision, state } }) },
    ...overrides,
  })
  return { handlers, calls }
}

describe('visualization IPC', () => {
  test('rebuilds a session-scoped context with no ambient roots', async () => {
    const { handlers, calls } = fixture()
    await handlers.list(event, 'session-a')
    expect(calls[0]?.value).toEqual({ sessionId: 'session-a', agentCwd: '/controlled/session-a', storageDir: '/controlled-visualizations/session-a', allowedRoots: [] })
  })

  test('rejects unknown sessions, missing workspace and malformed identifiers', async () => {
    const { handlers } = fixture()
    await expectRejected(() => handlers.list(event, 'session-b'))
    const missingWorkspace = fixture({ getWorkspace: () => undefined })
    await expectRejected(() => missingWorkspace.handlers.list(event, 'session-a'))
    await expectRejected(() => handlers.read(event, { sessionId: '../session-a', id: 'x' }))
    await expectRejected(() => handlers.read(event, { sessionId: 'session-a', id: '../secret' }))
  })

  test('rejects iframe and non-host senders', async () => {
    const { handlers } = fixture()
    await expectRejected(() => handlers.list({ ...event, senderFrame: {} } as any, 'session-a'))
    await expectRejected(() => handlers.list({ ...event, sender: { isDestroyed: () => false, mainFrame: event.sender.mainFrame } } as any, 'session-a'))
  })

  test('exports stored HTML with an offline state API after user-selected save path', async () => {
    let written: { path: string; content: string } | undefined
    let options: any
    const { handlers } = fixture({
      saveDialog: async (_options: any) => {
        options = _options
        return { canceled: false, filePath: '/tmp/unsafe-title.html' }
      },
      writeFile: async (path: string, content: string) => { written = { path, content } },
    })
    expect(await handlers.export(event, { sessionId: 'session-a', id: 'viz', revision: 'rev' })).toBe('unsafe-title.html')
    expect(written?.path).toBe('/tmp/unsafe-title.html')
    expect(written?.content).toContain('<html></html>')
    expect(written?.content).toContain('window.proferVisualization')
    expect(written?.content).toContain('[data-profer-panel]')
    expect(written?.content).toContain('overflow:visible!important')
    expect(written?.content).not.toContain('/controlled/')
    expect(options.defaultPath).toBe('A.html')
  })
  test('passes only validated view state and revision to the backend', async () => {
    const { handlers, calls } = fixture()
    await handlers.saveViewState(event, { sessionId: 'session-a', id: 'viz', revision: 'rev', state: { selected: 'a' } })
    expect(calls[0]?.value).toEqual({ id: 'viz', revision: 'rev', state: { selected: 'a' } })
    await expectRejected(() => handlers.saveViewState(event, { sessionId: 'session-a', id: 'viz', revision: 'rev', state: [] }))
  })
})
