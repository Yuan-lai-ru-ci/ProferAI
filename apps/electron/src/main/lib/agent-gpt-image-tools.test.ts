import { describe, expect, mock, test } from 'bun:test'

// Match the broad main-process mock used by Pi bridge tests; Bun shares module mocks
// across concurrently loaded test files.
mock.module('electron', () => ({
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  app: { getPath: () => '', isPackaged: false }, clipboard: { readText: () => '', writeText: () => undefined },
  dialog: {}, nativeImage: {}, nativeTheme: {}, Notification: class {}, powerMonitor: {}, powerSaveBlocker: {},
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  screen: {}, shell: {}, net: {}, protocol: {}, session: {}, systemPreferences: {}, View: class {}, WebContentsView: class {},
}))

mock.module('./chat-tool-config', () => ({
  getToolState: () => ({ enabled: true }), getToolCredentials: () => ({}),
  getGptImageCredentials: () => ({ mode: 'official', apiKey: '', baseUrl: '', model: '' }),
}))
mock.module('./auth-service', () => ({
  getTeamAuth: () => ({ token: 'test' }), getTeamAuthWithRefresh: async () => undefined,
  refreshAuthToken: async () => false, getAccessToken: () => null, getAuthStatus: () => ({ isLoggedIn: false }), recoverCommercialProxyAuth: async () => null,
}))
mock.module('./chat-tools/gpt-image-tool', () => ({ isGptImageAvailable: () => true }))
mock.module('./agent-gpt-image-service', () => ({
  generateAgentGptImage: async () => ({
    ok: true,
    mode: 'official',
    edited: false,
    output: {
      image: { localPath: 'C:/safe/.context/agent-output-images/image.png', filename: 'image.png', mediaType: 'image/png' },
    },
  }),
}))

const { AGENT_GPT_IMAGE_TOOL_NAME, injectAgentGptImageMcpServer, isAgentGptImageAvailable } = await import('./agent-gpt-image-tools')

describe('Agent GPT Image Claude adapter', () => {
  test('registers exactly one shared generate_image tool with the Pi-compatible schema', async () => {
    const captured: { name?: string; version?: string; tools?: Array<{ name: string; parameters: unknown; handler: (args: Record<string, unknown>) => Promise<unknown> }> }[] = []
    const sdk = {
      tool: (name: string, _description: string, parameters: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => ({ name, parameters, handler }),
      createSdkMcpServer: (server: typeof captured[number]) => { captured.push(server); return server },
    } as unknown as typeof import('@anthropic-ai/claude-agent-sdk')
    const servers: Record<string, Record<string, unknown>> = {}

    await injectAgentGptImageMcpServer(sdk, servers, { sessionId: 'claude-session', agentCwd: 'C:/safe', allowedRoots: ['C:/attached'] })

    expect(isAgentGptImageAvailable()).toBe(true)
    expect(Object.keys(servers)).toEqual(['agent-gpt-image'])
    expect(captured).toHaveLength(1)
    const [tool] = captured[0]!.tools!
    expect(tool!.name).toBe(AGENT_GPT_IMAGE_TOOL_NAME)
    expect(JSON.stringify(tool!.parameters)).toContain('referenceImagePaths')
    expect(JSON.stringify(tool!.parameters)).toContain('useLastGeneratedImage')
    expect(JSON.stringify(tool!.parameters)).toContain('1536x1024')
    const result = await tool!.handler({ prompt: 'blue square' }) as { content: Array<{ text: string }>; details?: { image?: { filename?: string } } }
    expect(result.content[0]!.text).not.toContain('IMAGE_ATTACHMENT')
    expect(result.details).toMatchObject({ image: { filename: 'image.png' } })
  })
})
