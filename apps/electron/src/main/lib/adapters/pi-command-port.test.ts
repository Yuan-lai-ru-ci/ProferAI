import { describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundTaskPort, CommandExecutionPort, CommandExecutionResult, ProcessRegistrationPort } from '@profer/agent-runtime'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentRuntimeEnv } from '../agent-runtime-env'

const events: string[] = []
mock.module('../runtime-process-registry', () => ({
  registerPendingPiRuntimeProcess: () => ({ id: 'task-1' }),
  registerPiRuntimeProcessShell: (_id: string, command: string, cwd: string, pid: number) => {
    expect(command).toContain('printf')
    expect(cwd).toBeTruthy()
    expect(pid).toBeGreaterThan(0)
    events.push('spawn')
    return { id: 'task-1', startTime: 1 }
  },
}))
mock.module('../pi-background-task-manager', () => ({ piBackgroundTaskManager: {
  begin() { events.push('begin') },
  append(_session: string, _task: string, data: Buffer) { events.push(`output:${data}`) },
  attachProcess() { events.push('attach') },
  complete(_session: string, _task: string, status: string) { events.push(`complete:${status}`) },
} }))

const { buildBuiltinToolDefinitions, PiAgentAdapter, applyPiPreparedQuery, resolvePiPreparedToolAssembly } = await import('./pi-agent-adapter')
const { createExecutionService } = await import('../execution-service')

function bashDefinition(commands: CommandExecutionPort, cwd: string, observed: Array<{ id: string; result: CommandExecutionResult }>, backgroundTasks?: BackgroundTaskPort, runtimeEnv: AgentRuntimeEnv = { env: {}, shellKind: 'posix', shellPath: '/bin/bash' }, processRegistration: ProcessRegistrationPort = {
  registerPending: () => ({ id: 'task-1' }),
  registerShell: (_input) => { events.push('spawn'); return { id: 'task-1', startTime: 1 } },
}) {
  const fakeSdk = {
    defineTool: (definition: unknown) => definition,
    createBashToolDefinition: (_cwd: string, input: { spawnHook: (request: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { command: string; cwd: string; env: NodeJS.ProcessEnv }; operations: { exec: (command: string, cwd: string, options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; onData: (data: Buffer) => void }) => Promise<{ exitCode: number | null }> } }) => ({
      name: 'bash',
      async execute(_id: string, params: { command: string }, signal: AbortSignal, onUpdate: (data: string) => void) {
        const prepared = input.spawnHook({ command: params.command, cwd, env: {} })
        return input.operations.exec(prepared.command, prepared.cwd, { env: prepared.env, signal, onData: data => onUpdate(data.toString()) })
      },
    }),
    createReadToolDefinition: () => ({ name: 'read' }), createWriteToolDefinition: () => ({ name: 'write' }), createEditToolDefinition: () => ({ name: 'edit' }),
    createGrepToolDefinition: () => ({ name: 'grep' }), createFindToolDefinition: () => ({ name: 'find' }), createLsToolDefinition: () => ({ name: 'ls' }),
  } as unknown as Parameters<typeof buildBuiltinToolDefinitions>[0]
  return buildBuiltinToolDefinitions(fakeSdk, 'fixture-command', cwd, undefined, runtimeEnv, (id, result) => observed.push({ id, result }), commands, backgroundTasks, processRegistration).find(tool => tool.name === 'bash')! as ToolDefinition
}

describe('Pi builtin Bash injected execution', () => {
  test('Given the actual execution service When a builtin Bash tool runs Then streams output, binds its process and reports tool-call evidence', async () => {
    if (process.platform === 'win32') return
    const cwd = mkdtempSync(join(tmpdir(), 'profer-command-port-'))
    try {
      events.length = 0
      const service = createExecutionService()
      const requests: string[] = []
      const commands: CommandExecutionPort = { execute: request => { requests.push(request.command); return service.execute(request) }, cancel: id => service.cancel(id), get: id => service.get(id) }
      const evidence: Array<{ id: string; result: CommandExecutionResult }> = []
      const background: BackgroundTaskPort = {
        begin() { events.push('begin') }, append() {}, attachProcess() {},
        complete(_session, _task, status) { events.push(`complete:${status}`) },
        getOutput: async () => ({ output: '', isComplete: true, status: 'completed' }), stop: async () => {},
      }
      const tool = bashDefinition(commands, cwd, evidence, background)
      const output: string[] = []
      const execution = await tool.execute('call-1', { command: 'printf out; printf err >&2; exit 7' }, new AbortController().signal, (data: unknown) => output.push(String(data)), {} as never)
      expect(execution).toMatchObject({ exitCode: 7 })
      expect(requests).toHaveLength(1)
      expect(output.join('')).toContain('out')
      expect(output.join('')).toContain('err')
      expect(evidence[0]).toMatchObject({ id: 'call-1', result: { exitCode: 7, stdout: 'out', stderr: 'err' } })
      expect(events).toContain('spawn')
      expect(events).toContain('begin')
      expect(events).toContain('complete:failed')
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  test('Given a prepared runtime query When Pi adapter input is normalized Then credentials/resources/permission are applied without replacing legacy fields', () => {
    const canUseTool = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    const input = {
      sessionId: 'prepared-session',
      agentRuntime: 'pi' as const,
      prompt: 'fixture',
      apiKey: 'legacy-key',
      baseUrl: 'https://legacy.invalid',
      provider: 'custom' as const,
      permissionMode: 'auto' as const,
      systemPrompt: 'legacy prompt',
      piAgentDir: '/tmp/pi',
      piSessionDir: '/tmp/pi-session',
      prepared: {
        credentials: { apiKey: 'prepared-key', baseUrl: 'https://prepared.invalid', provider: 'openai' as const, forceBearerAuth: true },
        resources: { systemPrompt: 'prepared prompt', skills: ['skill-a'] },
        tools: [{ name: 'prepared-tool' }],
        collaborationAvailable: true,
        canUseTool,
      },
    } as never
    const normalized = applyPiPreparedQuery(input)
    expect(normalized).toMatchObject({ apiKey: 'prepared-key', baseUrl: 'https://prepared.invalid', provider: 'openai', systemPrompt: 'prepared prompt', prepared: expect.any(Object), customTools: [{ name: 'prepared-tool' }], metadata: { collaborationAvailable: true } })
    expect(normalized.canUseTool).toEqual(expect.any(Function))
  })
  test('Given deferred prepared tools When the Pi SDK is available Then host assembly runs once before provider options are applied', async () => {
    let builds = 0
    const sdk = { defineTool: 'sdk' } as never
    const input = {
      sessionId: 'deferred-tools',
      prepared: {
        deferredToolAssembly: { build: async (actual: unknown) => {
          builds += 1
          expect(actual).toBe(sdk)
          return { tools: [{ name: 'assembled-tool' } as never], collaborationAvailable: true }
        } },
      },
    } as never
    const resolved = await resolvePiPreparedToolAssembly(input, sdk)
    expect(builds).toBe(1)
    expect((resolved.prepared?.tools as readonly unknown[])).toEqual([{ name: 'assembled-tool' }])
    expect((applyPiPreparedQuery(resolved).customTools as readonly unknown[])).toEqual([{ name: 'assembled-tool' }])
    await resolvePiPreparedToolAssembly(resolved, sdk)
    expect(builds).toBe(1)
  })
  test('Given the actual Pi SDK Bash factory When injected commands execute Then the public hook and result contract preserve streaming and evidence', async () => {
    if (process.platform === 'win32') return
    const sdk = await import('@earendil-works/pi-coding-agent')
    const cwd = mkdtempSync(join(tmpdir(), 'profer-sdk-command-port-'))
    try {
      const service = createExecutionService()
      const evidence: Array<{ id: string; result: CommandExecutionResult }> = []
      const tools = buildBuiltinToolDefinitions(sdk, 'fixture-sdk', cwd, undefined, { env: {}, shellKind: 'posix', shellPath: '/bin/bash' }, (id, result) => evidence.push({ id, result }), service)
      const tool = tools.find(value => value.name === 'bash')!
      const output = await tool.execute('sdk-call', { command: 'printf sdk-output', timeout: 2 }, new AbortController().signal, undefined, { cwd, sessionManager: { getSessionId: () => 'fixture-session', getSessionFile: () => undefined } } as never)
      expect(output.content).toEqual([{ type: 'text', text: 'sdk-output' }])
      expect(evidence[0]).toMatchObject({ id: 'sdk-call', result: { stdout: 'sdk-output', exitCode: 0 } })
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })

  test('Given an injected process registration host When WSL Bash starts Then pending and shell registration preserve the wsl launcher', async () => {
    const launchers: string[] = []
    const processRegistration: ProcessRegistrationPort = {
      registerPending: input => { launchers.push(`pending:${input.launcher}`); return { id: 'task-wsl' } },
      registerShell: input => { launchers.push(`shell:${input.launcher}`); return { id: 'task-wsl', startTime: 1 } },
    }
    const commands: CommandExecutionPort = {
      execute: async request => { request.callbacks?.onSpawn?.(123); return { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 0, shell: request.shell, cwd: request.cwd, truncated: false } },
      cancel: async () => {}, get: () => undefined,
    }
    const tool = bashDefinition(commands, '/tmp', [], undefined, { env: {}, shellKind: 'wsl', wslCommand: '/bin/wsl' }, processRegistration)
    await tool.execute('call-wsl', { command: 'printf wsl' }, new AbortController().signal, undefined, {} as never)
    expect(launchers).toEqual(['pending:wsl', 'shell:wsl'])
  })
  test('Given injected background tasks When Bash settles and TaskOutput/Stop are called Then the injected host receives lifecycle and type checks', async () => {
    const calls: string[] = []
    const background: BackgroundTaskPort = {
      begin() { calls.push('begin') }, append() {}, attachProcess() {},
      complete(_session, _task, status) { calls.push(`complete:${status}`) },
      getOutput: async (session, task) => { calls.push(`output:${session}:${task}`); return { output: 'fixture', isComplete: true, status: 'completed' } },
      stop: async (session, task) => { calls.push(`stop:${session}:${task}`) },
    }
    const commands: CommandExecutionPort = { execute: async request => ({ stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 0, shell: request.shell, cwd: request.cwd, truncated: false }), cancel: async () => {}, get: () => undefined }
    const tool = bashDefinition(commands, tmpdir(), [], background)
    await tool.execute('call-background', { command: 'printf fixture' }, new AbortController().signal, undefined, {} as never)
    const adapter = new PiAgentAdapter({ backgroundTasks: background })
    await expect(adapter.getTaskOutput('session', 'task')).resolves.toMatchObject({ output: 'fixture' })
    await expect(adapter.stopTask('session', 'task', 'agent')).rejects.toThrow('只支持停止 shell')
    await adapter.stopTask('session', 'task', 'shell')
    expect(calls).toEqual(['begin', 'complete:completed', 'output:session:task', 'stop:session:task'])
  })

  test('Given a fake command port When cancellation completes Then the builtin tool uses injected evidence and preserves the tool-call identity', async () => {
    const evidence: Array<{ id: string; result: CommandExecutionResult }> = []
    const commands: CommandExecutionPort = { execute: async request => ({ stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, aborted: true, durationMs: 0, shell: request.shell, cwd: request.cwd, truncated: false }), cancel: async () => {}, get: () => undefined }
    const tool = bashDefinition(commands, tmpdir(), evidence)
    await expect(tool.execute('call-abort', { command: 'printf fixture' }, new AbortController().signal, undefined, {} as never)).rejects.toThrow('aborted')
    expect(evidence[0]).toMatchObject({ id: 'call-abort', result: { aborted: true } })
  })
})
