import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime, defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { PiAgentAdapter } from '../pi-agent-adapter'
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage } from '@profer/shared'

interface RequestBody {
  prompt_cache_key?: string
  input: unknown[]
  tools?: unknown[]
}

function textEvents(turn: number): unknown[] {
  return [
    { type: 'response.output_item.done', output_index: 0, item: {
      type: 'message', id: `msg-${turn}`, role: 'assistant',
      content: [{ type: 'output_text', text: `完成 ${turn}`, annotations: [] }],
    } },
    { type: 'response.completed', response: { id: `resp-${turn}`, status: 'completed', usage: {
      input_tokens: 10_000, output_tokens: 20, total_tokens: 10_020, input_tokens_details: { cached_tokens: 9_000 },
    } } },
  ]
}

/** 只替换 HTTP 响应：保留真实 adapter、SessionManager、工具执行、模型注册及 SSE 解析。 */
describe('Pi 缓存修复的真实请求集成', () => {
  test('Given 三组真实工具调用 When 跨query恢复 Then 请求前缀、缓存键、工具定义和usage保持正确', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-cache-request-'))
    const requests: RequestBody[] = []
    let toolExecutions = 0
    const fixtureFetch = (async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as RequestBody
      requests.push(request)
      const turn = requests.length
      const events = turn <= 3 ? [
        { type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', id: `fc-${turn}`, call_id: `call-${turn}`, name: 'fixture_read', arguments: '{}',
        } },
        { type: 'response.completed', response: { id: `resp-${turn}`, status: 'completed', usage: {
          input_tokens: 10_000, output_tokens: 20, total_tokens: 10_020, input_tokens_details: { cached_tokens: 9_000 },
        } } },
      ] : textEvents(turn)
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const originalStream = ModelRuntime.prototype.streamSimple
    const streamSpy = spyOn(ModelRuntime.prototype, 'streamSimple').mockImplementation(function (this: ModelRuntime, model, context, options) {
      return originalStream.call(this, model, context, { ...options, fetch: fixtureFetch })
    })
    const fixtureTool = defineTool({
      name: 'fixture_read', label: '读取测试内容', description: '返回固定的长文本，检查历史缓存前缀。',
      parameters: Type.Object({}),
      async execute() {
        toolExecutions += 1
        return { content: [{ type: 'text', text: `result-${toolExecutions}:${'A'.repeat(20_000)}` }], details: {} }
      },
    })
    const adapter = new PiAgentAdapter()
    let sdkSessionId: string | undefined
    const query = async (prompt: string, resumeSessionId?: string): Promise<SDKMessage[]> => {
      const messages: SDKMessage[] = []
      for await (const message of adapter.query({
        sessionId: 'host-cache-fixture', provider: 'openai-responses', model: 'gpt-5.1',
        apiKey: 'fixture-key', baseUrl: 'https://cache-fixture.invalid/v1',
        prompt, systemPrompt: '稳定执行规则。', cwd: root,
        piAgentDir: join(root, 'agent'), piSessionDir: join(root, 'sessions'),
        customTools: [fixtureTool], permissionMode: 'auto', canUseTool: async () => ({ behavior: 'allow' }),
        runtimeEnv: { env: {} }, ...(resumeSessionId ? { resumeSessionId } : {}),
        onSessionId: (id) => { sdkSessionId = id },
      })) messages.push(message)
      return messages
    }
    try {
      const firstMessages = await query('读取三组文本，然后完成。')
      expect(requests).toHaveLength(4)
      expect(toolExecutions).toBe(3)
      const firstKey = requests[0]!.prompt_cache_key
      expect(firstKey).toBe(sdkSessionId)
      expect(firstKey).toBeTruthy()
      for (let index = 1; index < requests.length; index += 1) {
        const before = requests[index - 1]!
        const after = requests[index]!
        expect(after.prompt_cache_key).toBe(firstKey)
        expect(after.tools).toEqual(before.tools)
        expect(after.input.slice(0, before.input.length)).toEqual(before.input)
      }
      const assistants = firstMessages.filter((message): message is SDKAssistantMessage => message.type === 'assistant' && !(message as { _partial?: boolean })._partial)
      expect(assistants).toHaveLength(4)
      expect(assistants.every(message => message.message.usage?.cache_read_input_tokens === 9_000)).toBe(true)
      const result = firstMessages.find((message): message is SDKResultMessage => message.type === 'result')
      expect(result?.usage).toEqual({ input_tokens: 4_000, cache_read_input_tokens: 36_000, cache_creation_input_tokens: 0, output_tokens: 80 })

      const previousRequest = requests.at(-1)!
      await query('打开网页。\n\n<turn_guidance>## Profer 受管浏览器</turn_guidance>', sdkSessionId)
      expect(requests).toHaveLength(5)
      const resumed = requests.at(-1)!
      expect(resumed.prompt_cache_key).toBe(firstKey)
      expect(resumed.tools).toEqual(previousRequest.tools)
      expect(resumed.input.slice(0, previousRequest.input.length)).toEqual(previousRequest.input)
      expect(JSON.stringify(resumed.input.at(-1))).toContain('## Profer 受管浏览器')
      // 原始 Pi JSONL 保存完整结果，请求投影不能反向破坏磁盘历史。
      const sessionPath = join(root, 'sessions', readdirSync(join(root, 'sessions')).find(name => name.endsWith('.jsonl'))!)
      const entries = readFileSync(sessionPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const results = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'toolResult')
      expect(results).toHaveLength(3)
      expect(results.every(entry => entry.message.content[0].text.length > 20_000)).toBe(true)
    } finally {
      adapter.dispose()
      streamSpy.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  test('Given query taskPrompt When CompactContext completes Then the real continuation request retains guidance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-cache-compaction-guidance-'))
    const requests: RequestBody[] = []
    const taskPrompt = '## Profer 受管浏览器\n浏览器任务必须使用受管工具。'
    const fixtureFetch = (async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as RequestBody
      requests.push(request)
      const events = requests.length === 1 ? [
        { type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', id: 'fc-compact', call_id: 'call-compact', name: 'CompactContext', arguments: '{}',
        } },
        { type: 'response.completed', response: { id: 'resp-compact', status: 'completed', usage: {
          input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 },
        } } },
      ] : textEvents(requests.length)
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch
    const originalStream = ModelRuntime.prototype.streamSimple
    const streamSpy = spyOn(ModelRuntime.prototype, 'streamSimple').mockImplementation(function (this: ModelRuntime, model, context, options) {
      return originalStream.call(this, model, context, { ...options, fetch: fixtureFetch })
    })
    const adapter = new PiAgentAdapter()
    try {
      const messages: SDKMessage[] = []
      for await (const message of adapter.query({
        sessionId: 'compact-guidance-fixture', provider: 'openai-responses', model: 'gpt-5.1',
        apiKey: 'fixture-key', baseUrl: 'https://cache-fixture.invalid/v1',
        prompt: '打开网页并完成任务。', systemPrompt: '稳定执行规则。', taskPrompt,
        cwd: root, piAgentDir: join(root, 'agent'), piSessionDir: join(root, 'sessions'),
        permissionMode: 'auto', canUseTool: async () => ({ behavior: 'allow' }),
        runtimeEnv: { env: {} },
      })) messages.push(message)
      expect(messages.some(message => message.type === 'result')).toBe(true)
      expect(requests.length).toBeGreaterThanOrEqual(2)
      expect(requests.some(request => {
        const content = JSON.stringify(request.input)
        return content.includes('浏览器任务必须使用受管工具。') && content.includes('<profer_compaction_continuation>')
      })).toBe(true)
    } finally {
      adapter.dispose()
      streamSpy.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
