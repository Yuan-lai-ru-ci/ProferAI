import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { AGENT_IPC_CHANNELS } from '@profer/shared'

// 只在内存执行目标函数，避免加载 Electron 服务及用户运行资产。
function loadFunctions(file: string, names: string[], bindings: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const selected = ast.statements.filter(s => ts.isFunctionDeclaration(s) && s.name && names.includes(s.name.text))
  expect(selected.length).toBe(names.length)
  const code = ts.transpileModule(selected.map(s => s.getText(ast).replace(/^export /, '')).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(bindings), `${code}\nreturn { ${names.join(',')} }`)(...Object.values(bindings))
}

describe('Given Core未实现的桌面入口 When 判断归属 Then fail closed', () => {
  test.each([
    ['remote', false], ['local', true],
  ])('全局MCP %s owned=%s 拒绝所有入口且不访问本机', (targetId, owned) => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    let accesses = 0
    const fail = () => { accesses++; throw new Error('禁止本机访问') }
    const { registerGlobalMcpIpc } = loadFunctions('./global-mcp-ipc.ts', ['assertDesktopGlobalMcpAvailable', 'registerGlobalMcpIpc'], {
      ipcMain: { handle: (channel: string, fn: (...args: any[]) => unknown) => handlers.set(channel, fn) }, AGENT_IPC_CHANNELS,
      listCoreTargets: () => ({ currentId: targetId }), localCoreOwnsBusinessData: () => owned,
      listAgentWorkspaces: fail, listGlobalMcpServers: fail, listWorkspaceGlobalMcpServers: fail, saveGlobalMcpServer: fail, deleteGlobalMcpServer: fail,
    })
    registerGlobalMcpIpc()
    return Promise.all([...handlers.values()].map(async fn => {
      await expect(Promise.resolve().then(() => fn(null, 'ws'))).rejects.toThrow('当前 Core 尚未实现')
    })).then(() => expect(accesses).toBe(0))
  })

  test('默认desktop 全局MCP成功读写', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const writes: string[] = []
    const { registerGlobalMcpIpc } = loadFunctions('./global-mcp-ipc.ts', ['assertDesktopGlobalMcpAvailable', 'registerGlobalMcpIpc'], {
      ipcMain: { handle: (channel: string, fn: (...args: any[]) => unknown) => handlers.set(channel, fn) }, AGENT_IPC_CHANNELS,
      listCoreTargets: () => ({ currentId: 'local' }), localCoreOwnsBusinessData: () => false,
      listAgentWorkspaces: () => [{ id: 'w' }], listGlobalMcpServers: () => [], listWorkspaceGlobalMcpServers: () => ['shared'], assertSafeSkillSegment: () => {},
      saveGlobalMcpServer: () => writes.push('save'), deleteGlobalMcpServer: () => writes.push('delete'), retireAfterSave: async () => {},
    })
    registerGlobalMcpIpc()
    expect(handlers.get(AGENT_IPC_CHANNELS.LIST_GLOBAL_MCP)!(null)).toEqual([])
    expect(handlers.get(AGENT_IPC_CHANNELS.LIST_WORKSPACE_GLOBAL_MCP)!(null, 'ws')).toEqual(['shared'])
    await handlers.get(AGENT_IPC_CHANNELS.SAVE_GLOBAL_MCP)!(null, { name: 'x', workspaceIds: ['w'] }, 'create')
    await handlers.get(AGENT_IPC_CHANNELS.DELETE_GLOBAL_MCP)!(null, 'x')
    expect(writes).toEqual(['save', 'delete'])
  })

  test.each([['remote', false], ['local', true], ['local', false]])('上下文快照 %s owned=%s 仅desktop读本机', async (targetId, owned) => {
    let reads = 0
    const { getAgentContextUsageSnapshot } = loadFunctions('./agent-service.ts', ['getAgentContextUsageSnapshot'], {
      listCoreTargets: () => ({ currentId: targetId }), localCoreOwnsBusinessData: () => owned,
      getAgentSessionMeta: () => ({ id: 's' }), usageRecorder: { hidesPreCompactReading: () => false },
      readAgentContextUsageSnapshot: async () => { reads++; return { inputTokens: 42 } },
    })
    if (targetId !== 'local' || owned) await expect(getAgentContextUsageSnapshot('s')).rejects.toThrow('不会回退')
    else await expect(getAgentContextUsageSnapshot('s')).resolves.toEqual({ inputTokens: 42 })
    expect(reads).toBe(targetId === 'local' && !owned ? 1 : 0)
  })
})
