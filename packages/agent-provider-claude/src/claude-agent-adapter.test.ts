import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackgroundTaskManager } from './background-task-manager'
import type { ClaudeAgentQueryOptions } from './claude-agent-adapter'
import {
  applyClaudePreparedQuery,
  ClaudeAgentAdapter,
  friendlyErrorMessage,
  getWindowsPowerShellPath,
  mapSDKErrorToTypedError,
  SDK_SETTING_SOURCES,
} from './claude-agent-adapter'
import { createClaudeSdkDouble, FakeChildProcess, type ClaudeSdkDouble } from '../test-hosts/claude-sdk-double'
import { createFakeClaudeLifecyclePort } from '../test-hosts/fake-claude-lifecycle-port'

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

interface Harness {
  adapter: ClaudeAgentAdapter
  double: ClaudeSdkDouble
  dispose: () => void
}

/** 每次构造 adapter 都注入独立的 SDK 替身，不依赖全局模块 mock。 */
function createHarness(options: ConstructorParameters<typeof ClaudeAgentAdapter>[0] = {}): Harness {
  const double = createClaudeSdkDouble()
  const adapter = new ClaudeAgentAdapter({
    sdkLoader: async () => double.module,
    spawnProcess: double.spawnProcess,
    ...options,
  })
  return {
    adapter,
    double,
    dispose() {
      adapter.dispose()
      double.dispose()
    },
  }
}

function baseInput(sessionId: string, overrides: Partial<ClaudeAgentQueryOptions> = {}): ClaudeAgentQueryOptions {
  return {
    sessionId,
    prompt: 'fixture',
    sdkCliPath: '/unused/mock-claude',
    env: {},
    sdkPermissionMode: 'auto',
    allowDangerouslySkipPermissions: false,
    systemPrompt: 'test',
    ...overrides,
  }
}

describe('Claude provider：SDK 查询选项透传', () => {
  test('Given 一次 query When SDK 收到 options Then 关键 SDK 行为保持不变', async () => {
    const harness = createHarness()
    try {
      const stream = harness.adapter.query(baseInput('passthrough', {
        model: 'claude-fixture-model',
        maxTurns: 3,
        cwd: '/fixture/cwd',
        mcpServers: { fixture: { type: 'http', url: 'https://mcp.invalid' } },
        plugins: [{ type: 'local', path: '/fixture/plugin' }],
        skills: ['code-honor'],
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        enableFileCheckpointing: true,
        forkSession: false,
        sdkSessionId: 'sdk-session-fixture',
        additionalDirectories: ['/fixture/extra'],
        resumeSessionId: 'resume-fixture',
        resumeSessionAt: 'msg-fixture',
      }))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const sdkOptions = harness.double.state.options!
      expect(sdkOptions.pathToClaudeCodeExecutable).toBe('/unused/mock-claude')
      expect(sdkOptions.model).toBe('claude-fixture-model')
      expect(sdkOptions.maxTurns).toBe(3)
      expect(sdkOptions.permissionMode).toBe('auto')
      expect(sdkOptions.allowDangerouslySkipPermissions).toBe(false)
      expect(sdkOptions.includePartialMessages).toBe(false)
      expect(sdkOptions.promptSuggestions).toBe(false)
      // SDK 不认识这个选项，传了会被静默忽略；断言不存在，防止再把无效开关当成串行控制。
      expect('toolUseConcurrency' in sdkOptions).toBe(false)
      expect(sdkOptions.settingSources).toEqual(['project'])
      expect(sdkOptions.cwd).toBe('/fixture/cwd')
      expect(sdkOptions.resume).toBe('resume-fixture')
      expect(sdkOptions.resumeSessionAt).toBe('msg-fixture')
      expect(sdkOptions.skills).toEqual(['code-honor'])
      expect(sdkOptions.allowedTools).toEqual(['Read'])
      expect(sdkOptions.disallowedTools).toEqual(['Bash'])
      expect(sdkOptions.enableFileCheckpointing).toBe(true)
      expect(sdkOptions.forkSession).toBe(false)
      expect(sdkOptions.additionalDirectories).toEqual(['/fixture/extra'])
      expect(sdkOptions.plugins).toEqual([{ type: 'local', path: '/fixture/plugin' }])
      expect(sdkOptions.mcpServers).toEqual({ fixture: { type: 'http', url: 'https://mcp.invalid' } })
      expect(typeof sdkOptions.spawnClaudeCodeProcess).toBe('function')
      expect(sdkOptions.abortController).toBeInstanceOf(AbortController)
      harness.double.push({ type: 'result', subtype: 'success', session_id: 'sdk-1', terminal_reason: 'completed' })
      const message = await pending
      expect(message.done).toBe(false)
      expect((message.value as { session_id?: string }).session_id).toBe('sdk-1')
      // result 已 yield 后，adapter 在消费者再次取值时主动结束 SDK iterator。
      const done = await stream.next()
      expect(done.done).toBe(true)
      expect(harness.double.state.returnCalls).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  test('Given SDK init 与 result When 流经 adapter Then session id、模型与上下文窗口回调都被触发', async () => {
    const harness = createHarness()
    const sessionIds: string[] = []
    const models: string[] = []
    const contextWindows: number[] = []
    try {
      const stream = harness.adapter.query(baseInput('callbacks', {
        model: 'claude-fixture-model',
        onSessionId: (id) => sessionIds.push(id),
        onModelResolved: (model) => models.push(model),
        onContextWindow: (size) => contextWindows.push(size),
      }))[Symbol.asyncIterator]()
      const first = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'system', subtype: 'init', session_id: 'native-session-fixture', model: 'resolved-model' })
      await expect(first).resolves.toMatchObject({ done: false })
      const second = stream.next()
      harness.double.push({
        type: 'result',
        subtype: 'success',
        session_id: 'native-session-fixture',
        terminal_reason: 'completed',
        modelUsage: { 'resolved-model': { contextWindow: 200_000 } },
      })
      await expect(second).resolves.toMatchObject({ done: false })
      const done = await stream.next()
      expect(done.done).toBe(true)
      expect(harness.double.state.returnCalls).toBe(1)
      expect(sessionIds).toEqual(['native-session-fixture', 'native-session-fixture'])
      expect(models).toEqual(['resolved-model'])
      expect(contextWindows).toEqual([200_000])
    } finally {
      harness.dispose()
    }
  })
})

describe('Claude provider：Skill 白名单与工具装载', () => {
  for (const { label, skills } of [
    { label: '未指定白名单', skills: undefined },
    { label: '空白名单', skills: [] as string[] },
    { label: '非空白名单', skills: ['code-honor', 'plugin:review'] },
  ]) {
    test(`Given ${label} When 发起查询 Then sdk.query 收到原始白名单状态`, async () => {
      const harness = createHarness()
      try {
        const stream = harness.adapter.query(baseInput(`skills-${label}`, { skills }))[Symbol.asyncIterator]()
        const pending = stream.next()
        await waitUntil(() => harness.double.state.options !== undefined)
        const sdkOptions = harness.double.state.options!
        if (skills === undefined) {
          expect(sdkOptions).not.toHaveProperty('skills')
        } else {
          expect(sdkOptions).toHaveProperty('skills', skills)
          expect(sdkOptions.skills).not.toBe(skills)
        }
        harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
        await pending
      } finally {
        harness.dispose()
      }
    })
  }

  test('Given 纯对话空工具数组 When 后续标准请求 Then 只在本轮显式透传 tools', async () => {
    const harness = createHarness()
    try {
      const first = harness.adapter.query(baseInput('light-tools', { tools: [] }))[Symbol.asyncIterator]()
      const pendingFirst = first.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      expect(harness.double.state.options!.tools).toEqual([])
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pendingFirst

      const second = harness.adapter.query(baseInput('standard-tools', { tools: undefined }))[Symbol.asyncIterator]()
      const pendingSecond = second.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      expect(harness.double.state.options).not.toHaveProperty('tools')
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pendingSecond
    } finally {
      harness.dispose()
    }
  })
})

describe('Claude provider：prepared 上下文与权限回调', () => {
  test('Given prepared runtime context When Claude queries Then prompt、权限回调和 MCP 进入 SDK options', async () => {
    const harness = createHarness()
    const calls: Array<{ toolName: string; toolUseID?: string }> = []
    const canUseTool = async (toolName: string, input: Record<string, unknown>, options: { toolUseID?: string }) => {
      calls.push({ toolName, ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}) })
      return { behavior: 'allow' as const, updatedInput: input, toolUseID: options.toolUseID }
    }
    try {
      const stream = harness.adapter.query(baseInput('prepared', {
        env: { LEGACY: 'keep' },
        systemPrompt: 'legacy',
        prepared: {
          credentials: { apiKey: 'prepared-key', baseUrl: 'https://prepared.invalid', provider: 'anthropic', forceBearerAuth: false },
          resources: { systemPrompt: 'prepared prompt' },
          mcpServers: { fixture: { type: 'http', url: 'https://mcp.invalid' } },
          plugins: [{ type: 'local', path: '/fixture/plugin' }],
          skills: ['prepared-skill'],
          allowedTools: ['Read'],
          disallowedTools: ['Bash'],
          canUseTool,
        },
      }))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const sdkOptions = harness.double.state.options!
      expect(sdkOptions).toMatchObject({
        systemPrompt: 'prepared prompt',
        env: { LEGACY: 'keep', ANTHROPIC_API_KEY: 'prepared-key', ANTHROPIC_BASE_URL: 'https://prepared.invalid' },
        mcpServers: { fixture: { url: 'https://mcp.invalid' } },
        plugins: [{ type: 'local', path: '/fixture/plugin' }],
        skills: ['prepared-skill'],
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
      })
      const sdkCanUseTool = sdkOptions.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID?: string },
      ) => Promise<unknown>
      expect(sdkCanUseTool).toEqual(expect.any(Function))
      const result = await sdkCanUseTool('Write', { file_path: 'fixture' }, { signal: new AbortController().signal, toolUseID: 'call-1' })
      expect(result).toMatchObject({ behavior: 'allow', toolUseID: 'call-1' })
      expect(calls).toEqual([{ toolName: 'Write', toolUseID: 'call-1' }])
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pending
    } finally {
      harness.dispose()
    }
  })

  for (const fixture of [
    { provider: 'anthropic' as const, forceBearerAuth: true, baseUrl: 'https://relay.invalid/v1/proxy', bearer: true },
    { provider: 'kimi-coding' as const, forceBearerAuth: false, baseUrl: 'https://plan.invalid/anthropic', bearer: true },
    { provider: 'anthropic' as const, forceBearerAuth: false, baseUrl: undefined, bearer: false },
    { provider: 'anthropic' as const, forceBearerAuth: false, baseUrl: 'https://api.anthropic.com', bearer: false },
  ]) test(`Given ${fixture.provider} bearer=${fixture.bearer} url=${fixture.baseUrl} When prepared auth applies Then 旧认证被清空且宿主 options 保留`, () => {
    const before = { ...process.env }
    const canUseTool = async (_name: string, input: Record<string, unknown>, options: { toolUseID?: string }) => ({ behavior: 'allow' as const, updatedInput: input, toolUseID: options.toolUseID, decisionClassification: 'user_temporary' as const })
    const prompt = { type: 'preset' as const, preset: 'claude_code' as const, append: 'frozen policy' }
    const query: ClaudeAgentQueryOptions = baseInput('auth', {
      env: { HOST: 'keep', ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_CUSTOM_HEADERS: 'old', ANTHROPIC_MODEL: 'old' },
      systemPrompt: 'legacy',
      prepared: { credentials: { ...fixture, apiKey: 'fresh' }, systemPrompt: prompt, canUseTool, skills: [], plugins: [], mcpServers: {} },
    })
    const output = applyClaudePreparedQuery(query, { appVersion: '9.9.9' })
    expect(output.env!.HOST).toBe('keep')
    expect(output.env![fixture.bearer ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']).toBe('fresh')
    expect(output.env![fixture.bearer ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN']).toBe('')
    expect(output.env!.ANTHROPIC_MODEL).toBe('old')
    expect(output.env!.ANTHROPIC_BASE_URL).toBe(fixture.baseUrl && fixture.baseUrl !== 'https://api.anthropic.com' ? fixture.baseUrl : '')
    if (fixture.provider === 'kimi-coding') expect(output.env!.ANTHROPIC_CUSTOM_HEADERS).toContain('User-Agent: Proma/9.9.9')
    else expect(output.env!.ANTHROPIC_CUSTOM_HEADERS).toBe('')
    expect(output.systemPrompt).toBe(prompt)
    expect(output.skills).toEqual([])
    expect(query.env!.ANTHROPIC_API_KEY).toBe('old')
    expect(process.env).toEqual(before)
  })
})

describe('Claude provider：后台任务 output/stop', () => {
  for (const injection of ['constructor', 'query', 'query-override', 'legacy'] as const) {
    test(`Given ${injection} task authority When SDK events stream Then output、校验与真实 stop 共用同一权威`, async () => {
      const sessionId = `tasks-${injection}`
      const { port, manager } = createFakeClaudeLifecyclePort()
      const { port: constructorPort, manager: constructorManager } = createFakeClaudeLifecyclePort()
      const harness = createHarness(injection === 'constructor' ? { processLifecycle: port }
        : injection === 'query-override' ? { processLifecycle: constructorPort } : {})
      const { adapter, double } = harness
      const dir = mkdtempSync(join(tmpdir(), 'claude-task-fixture-'))
      const outputFile = join(dir, 'output.txt')
      writeFileSync(outputFile, 'real file output')
      try {
        const stream = adapter.query(baseInput(sessionId, injection === 'query' || injection === 'query-override' ? { processLifecycle: port } : {}))[Symbol.asyncIterator]()
        const pendingFirst = stream.next()
        await waitUntil(() => double.state.options !== undefined)
        double.push({ type: 'system', subtype: 'task_started', task_id: 'task', task_type: 'local_bash' })
        await pendingFirst
        const pendingSecond = stream.next()
        double.push({ type: 'system', subtype: 'task_progress', task_id: 'task', summary: 'working' })
        await pendingSecond
        expect(await adapter.getTaskOutput(sessionId, 'task', { block: false })).toMatchObject({ status: 'running', summary: 'working' })
        await expect(adapter.stopTask('foreign', 'task', 'shell')).rejects.toThrow('不属于当前会话')
        await expect(adapter.stopTask(sessionId, 'task', 'agent')).rejects.toThrow('类型不匹配')
        expect(double.state.stopTaskCalls).toEqual([])

        double.state.stopTaskError = new Error('SDK stop failed')
        await expect(adapter.stopTask(sessionId, 'task', 'shell')).rejects.toThrow('SDK stop failed')
        expect(await adapter.getTaskOutput(sessionId, 'task')).toMatchObject({ status: 'running' })

        double.state.stopTaskError = undefined
        await adapter.stopTask(sessionId, 'task', 'shell')
        await adapter.stopTask(sessionId, 'task', 'shell')
        expect(double.state.stopTaskCalls).toEqual(['task', 'task'])
        expect(await adapter.getTaskOutput(sessionId, 'task')).toMatchObject({ status: 'stopped', isComplete: true })

        const pendingThird = stream.next()
        double.push({ type: 'system', subtype: 'task_started', task_id: 'done', task_type: 'subagent' })
        await pendingThird
        const pendingFourth = stream.next()
        double.push({ type: 'system', subtype: 'task_notification', task_id: 'done', status: 'completed', output_file: outputFile, summary: 'finished' })
        await pendingFourth
        const pendingFifth = stream.next()
        double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
        await pendingFifth
        expect(await adapter.getTaskOutput(sessionId, 'done')).toEqual({ output: 'real file output', status: 'completed', isComplete: true, summary: 'finished' })
        await adapter.stopTask(sessionId, 'done', 'agent')
        expect(double.state.stopTaskCalls).toEqual(['task', 'task'])
        if (injection !== 'legacy') {
          expect(manager.get(sessionId, 'task')?.status).toBe('stopped')
          expect(constructorManager.get(sessionId, 'task')).toBeUndefined()
          // 另一个未注入 port 的 adapter 看不到宿主记录，证明没有双写 legacy manager。
          const legacyHarness = createHarness()
          try {
            await expect(legacyHarness.adapter.getTaskOutput(sessionId, 'task')).rejects.toThrow('不属于当前会话')
          } finally {
            legacyHarness.dispose()
          }
        } else {
          // legacy：宿主未注入 port 时，使用 provider 内部 BackgroundTaskManager 兜底。
          expect(await adapter.getTaskOutput(sessionId, 'task')).toMatchObject({ status: 'stopped' })
        }
      } finally {
        harness.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test('Given 未注入宿主 port When 使用内部兜底记录 Then 行为与宿主实现一致', async () => {
    const harness = createHarness()
    const dir = mkdtempSync(join(tmpdir(), 'claude-task-legacy-'))
    const outputFile = join(dir, 'output.txt')
    writeFileSync(outputFile, 'legacy output')
    try {
      const stream = harness.adapter.query(baseInput('legacy-internal'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'system', subtype: 'task_notification', task_id: 't', status: 'completed', output_file: outputFile })
      await pending
      expect(await harness.adapter.getTaskOutput('legacy-internal', 't')).toMatchObject({ output: 'legacy output', status: 'completed' })
      const manager = new BackgroundTaskManager()
      expect(manager.get('legacy-internal', 't')).toBeUndefined()
    } finally {
      harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Claude provider：终态、取消与清理', () => {
  test('Given terminal result When 本轮真正结束 Then 输入通道关闭并在 yield 后终止 iterator', async () => {
    const harness = createHarness()
    try {
      const stream = harness.adapter.query(baseInput('terminal'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await expect(pending).resolves.toMatchObject({ done: false })
      // 通道关闭后 adapter 主动结束 iterator，不会继续等待 SDK 输出。
      const next = await stream.next()
      expect(next.done).toBe(true)
      expect(harness.double.state.returnCalls).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  for (const terminalReason of ['aborted_streaming', 'aborted_tools', 'tool_deferred', 'hook_stopped', 'stop_hook_prevented']) {
    test(`Given terminal_reason=${terminalReason} When result 到达 Then 保留消息通道并等待下一轮`, async () => {
      const harness = createHarness()
      try {
        const stream = harness.adapter.query(baseInput(`continuable-${terminalReason}`))[Symbol.asyncIterator]()
        const pending = stream.next()
        await waitUntil(() => harness.double.state.options !== undefined)
        harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: terminalReason })
        await pending
        expect(harness.double.state.returnCalls).toBe(0)
        const pendingNext = stream.next()
        harness.double.push({ type: 'assistant', session_id: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'next turn' }] } })
        const next = await pendingNext
        expect(next.done).toBe(false)
        expect(harness.double.state.returnCalls).toBe(0)
      } finally {
        harness.dispose()
      }
    })
  }

  test('Given Stop hook 观察到后台任务 When 本轮主体结束 Then 保持通道并标注软空闲', async () => {
    const harness = createHarness()
    try {
      const stream = harness.adapter.query(baseInput('background-pending'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const hooks = harness.double.state.options!.hooks as {
        Stop: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>
      }
      await hooks.Stop[0]!.hooks[0]!({ background_tasks: [{ task_id: 'bg' }], session_crons: [] })
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      const message = await pending
      expect((message.value as Record<string, unknown>)._keepChannelOpenForTasks).toBe(true)
      expect(harness.double.state.returnCalls).toBe(0)

      // 后台任务结束：Stop hook 再次观察为空数组，下一轮 result 才真正关闭通道。
      await hooks.Stop[0]!.hooks[0]!({ background_tasks: [], session_crons: [] })
      const pendingNext = stream.next()
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pendingNext
      const done = await stream.next()
      expect(done.done).toBe(true)
      expect(harness.double.state.returnCalls).toBe(1)
    } finally {
      harness.dispose()
    }
  })

  test('Given PreToolUse hook When Write 父目录不存在 Then 与迁移前一致地拒绝', async () => {
    const harness = createHarness()
    const dir = mkdtempSync(join(tmpdir(), 'claude-hook-'))
    try {
      const stream = harness.adapter.query(baseInput('hook', { cwd: dir }))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const hooks = harness.double.state.options!.hooks as {
        PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<{ continue: boolean; decision?: string }>> }>
      }
      const blocked = await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'Write', tool_input: { file_path: 'missing/new.txt' } })
      expect(blocked).toMatchObject({ continue: false, decision: 'block' })
      const allowed = await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'Write', tool_input: { file_path: join(dir, 'new.txt') } })
      expect(allowed).toEqual({ continue: true })
      const other = await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'Read', tool_input: { file_path: 'missing.txt' } })
      expect(other).toEqual({ continue: true })
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pending
    } finally {
      harness.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 流式追加消息 When 查询已就绪 Then 消息经通道注入且可软中断当前 turn', async () => {
    const harness = createHarness()
    try {
      const stream = harness.adapter.query(baseInput('queued'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const initial = await harness.double.nextPromptInput()
      expect((initial as { message: { content: string } }).message.content).toBe('fixture')

      await harness.adapter.sendQueuedMessage('queued', {
        type: 'user',
        message: { role: 'user', content: 'queued turn' },
        parent_tool_use_id: null,
        session_id: 'queued',
        uuid: 'queued-1',
        priority: 'now',
      })
      const injected = await harness.double.nextPromptInput()
      expect((injected as { message: { content: string } }).message.content).toBe('queued turn')

      await harness.adapter.interruptQuery('queued')
      expect(harness.double.state.interruptCalls).toBe(1)
      await harness.adapter.setPermissionMode('queued', 'bypassPermissions')
      expect(harness.double.state.permissionModeCalls).toEqual(['bypassPermissions'])

      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pending
    } finally {
      harness.dispose()
    }
  })

  test('Given abort When 取消运行中会话 Then 关闭 query、中止信号并清理会话状态', async () => {
    const { port, exits } = createFakeClaudeLifecyclePort()
    const harness = createHarness({ processLifecycle: port })
    try {
      const stream = harness.adapter.query(baseInput('abort'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const controller = harness.double.state.options!.abortController as AbortController
      expect(controller.signal.aborted).toBe(false)
      harness.adapter.abort('abort')
      expect(harness.double.state.closeCalls).toBe(1)
      expect(controller.signal.aborted).toBe(true)
      expect((await pending).done).toBe(true)
      // 会话状态已清理：getTaskOutput 不再命中本进程内兜底记录。
      await expect(harness.adapter.getTaskOutput('abort', 'missing')).rejects.toThrow('后台任务不存在')
      harness.adapter.dispose()
      expect(exits).toContain('abort')
    } finally {
      harness.dispose()
    }
  })

  test('Given SDK 流以错误结束 When 消费 adapter Then 错误透传且会话状态被清理', async () => {
    const harness = createHarness()
    try {
      const stream = harness.adapter.query(baseInput('failure'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'system', subtype: 'init', session_id: 's' })
      await expect(pending).resolves.toMatchObject({ done: false })
      const pendingFailure = stream.next()
      harness.double.fail(new Error('sdk stream boom'))
      await expect(pendingFailure).rejects.toThrow('sdk stream boom')
      // 失败后 adapter 仍可被再次使用（映射已清理）。
      const second = harness.adapter.query(baseInput('failure-2'))[Symbol.asyncIterator]()
      const pendingSecond = second.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await expect(pendingSecond).resolves.toMatchObject({ done: false })
    } finally {
      harness.dispose()
    }
  })

  test('Given dispose When 释放资源 Then 关闭所有 query 并通知宿主 onExit', async () => {
    const { port, exits } = createFakeClaudeLifecyclePort()
    const harness = createHarness({ processLifecycle: port })
    try {
      const stream = harness.adapter.query(baseInput('dispose'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'system', subtype: 'init', session_id: 's' })
      await expect(pending).resolves.toMatchObject({ done: false })
      harness.adapter.dispose()
      expect(harness.double.state.closeCalls).toBe(1)
      expect(exits).toContain('dispose')
      expect((await stream.next()).done).toBe(true)

      // dispose 后 adapter 仍可再次发起 query（证明实例级状态未损坏）。
      const second = harness.adapter.query(baseInput('dispose-2'))[Symbol.asyncIterator]()
      const pendingSecond = second.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await expect(pendingSecond).resolves.toMatchObject({ done: false })
    } finally {
      harness.dispose()
    }
  })
})

describe('Claude provider：spawn 替身与进程生命周期', () => {
  test('Given spawnClaudeCodeProcess When SDK 启动子进程 Then 注入堆上限、记录 PID 并转发 stderr', async () => {
    const { port, spawns } = createFakeClaudeLifecyclePort()
    const harness = createHarness({ processLifecycle: port })
    const stderrChunks: string[] = []
    try {
      const stream = harness.adapter.query(baseInput('spawn', { onStderr: (data) => stderrChunks.push(data) }))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const child = harness.double.spawn({ env: { NODE_OPTIONS: '--expose-gc' } }) as FakeChildProcess
      expect(harness.double.state.spawnCalls).toBe(1)
      expect(harness.double.state.spawnedEnvs[0]!.NODE_OPTIONS).toBe('--expose-gc --max-old-space-size=4096')
      expect(child).toBe(harness.double.state.lastChild!)
      expect(spawns).toEqual([{ sessionId: 'spawn', pid: child.pid }])
      child.stderr.emit('data', Buffer.from('stderr fixture'))
      expect(stderrChunks).toEqual(['stderr fixture'])

      const second = harness.double.spawn({ env: { NODE_OPTIONS: '--max-old-space-size=1024' } }) as FakeChildProcess
      expect(harness.double.state.spawnedEnvs[1]!.NODE_OPTIONS).toBe('--max-old-space-size=1024')
      child.exit()
      second.exit()

      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pending
    } finally {
      harness.dispose()
    }
  })

  test('Given 无 onStderr When 子进程有 stderr 输出 Then 仍然消费流避免缓冲阻塞', async () => {
    const harness = createHarness()
    try {
      const stream = harness.adapter.query(baseInput('spawn-no-stderr'))[Symbol.asyncIterator]()
      const pending = stream.next()
      await waitUntil(() => harness.double.state.options !== undefined)
      const child = harness.double.spawn() as FakeChildProcess
      expect(() => child.stderr.resume()).not.toThrow()
      child.stderr.emit('data', Buffer.from('ignored'))
      child.exit()
      harness.double.push({ type: 'result', subtype: 'success', session_id: 's', terminal_reason: 'completed' })
      await pending
    } finally {
      harness.dispose()
    }
  })
})

describe('Claude provider：错误映射与平台 helper', () => {
  test('Given PowerShell 未加入 PATH 但系统组件存在 When 解析 Then 使用 SystemRoot 下的绝对路径', () => {
    const path = getWindowsPowerShellPath(
      { SystemRoot: 'C:\\Windows' },
      (candidate) => candidate === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(path).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  test('Given 系统组件不可用 When 解析 Then 安全降级为 null', () => {
    expect(getWindowsPowerShellPath({ SystemRoot: 'C:\\Windows' }, () => false)).toBeNull()
    expect(getWindowsPowerShellPath({}, () => true)).toBeNull()
  })

  test('Given Profer Agent SDK 查询 When 配置设置来源 Then 不加载用户级 Claude 设置', () => {
    expect(SDK_SETTING_SOURCES).toEqual(['project'])
    expect(SDK_SETTING_SOURCES).not.toContain('user')
  })

  test('Given Ollama tool-result stream error When mapping Then do not classify as transient network retry', () => {
    const message = 'API Error: 500 no user query found in messages'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('Ollama 工具流兼容性错误')
    expect(error.canRetry).toBe(false)
    expect(friendlyErrorMessage(message)).toContain('Ollama')
  })

  test('Given OpenAI 官方上游请求量较大 When 映射错误 Then 使用统一文案并允许重试', () => {
    const message = 'OpenAI 官方上游服务当前请求量较大，请稍后重试。'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('OpenAI 官方服务繁忙')
    expect(error.message).toContain('与你的账户无关')
    expect(error.canRetry).toBe(true)
  })

  test('Given 独立上游 billing 页面 402 When 映射错误 Then 识别为不可自动重试的额度不足', () => {
    const message = 'API Error: 402 Insufficient credit. Add funds at zyloo.io/dashboard/billing.'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('insufficient_credits')
    expect(error.title).toBe('额度不足')
    expect(error.canRetry).toBe(false)
  })

  test('Given 上游供应通道账户余额不足 When 映射错误 Then 不引导用户充值且可重试', () => {
    const message = 'API Error: 403 {"error":"当前模型供应通道额度不足","code":"upstream_channel_insufficient"}'
    const error = mapSDKErrorToTypedError('unknown', message, message)
    expect(error.code).toBe('provider_error')
    expect(error.title).toBe('模型供应通道暂不可用')
    expect(error.canRetry).toBe(true)
    expect(error.actions.some((action) => action.action === 'open_credits')).toBe(false)
  })

  test('Given provider 实例 When 读取能力快照 Then 原生能力全部保持', () => {
    const harness = createHarness()
    try {
      const capabilities = harness.adapter.getCapabilities()
      expect(capabilities).toEqual({
        supportsTaskOutput: true,
        supportsTaskStop: true,
        supportsRewind: true,
        supportsInterrupt: true,
        supportsQueuedMessage: true,
        supportsBackgroundWakeup: true,
        supportsNativeMcp: true,
        runtimeSupportsSubagents: true,
      })
      expect(typeof harness.adapter.errorHelpers.shouldKeepChannelOpen).toBe('function')
      expect(harness.adapter.isAnthropicProxyProvider('kimi-api')).toBe(true)
      expect(harness.adapter.isAnthropicProxyProvider('openai')).toBe(false)
    } finally {
      harness.dispose()
    }
  })
})
