/**
 * Pi 的延迟提示词：工具装配完成后才定型。
 *
 * 背景：提示词里的工具指南必须描述**真实注册**的工具，而 Pi 的 custom tools 是在 adapter 内
 * 由 `resolvePiPreparedToolAssembly` 构建的。宿主在构造 query 时拿不到名单，只能给一个
 * `resolvePromptForTools`，等工具就位后再算。
 */
import { describe, expect, test } from 'bun:test'
import { applyPiPreparedQuery, resolvePiPreparedToolAssembly } from './pi-agent-adapter'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

function options(overrides: Partial<PiAgentQueryOptions> = {}): PiAgentQueryOptions {
  return {
    sessionId: 'session-delayed-prompt',
    prompt: 'hi',
    agentRuntime: 'pi',
    systemPrompt: '占位提示词',
    ...overrides,
  } as PiAgentQueryOptions
}

describe('Pi 延迟提示词', () => {
  test('工具尚未装配时不调用 resolvePromptForTools，保留占位提示词', () => {
    let called = 0
    const input = options({
      resolvePromptForTools: () => {
        called += 1
        return { systemPrompt: '不该出现' }
      },
    })
    const applied = applyPiPreparedQuery(input)
    expect(called).toBe(0)
    expect(applied.systemPrompt).toBe('占位提示词')
  })

  test('工具装配完成后用真实工具名重算 system 与 taskPrompt', async () => {
    const seen: string[][] = []
    const input = options({
      prepared: {
        deferredToolAssembly: {
          build: async () => ({ tools: [{ name: 'TaskCreate' }, { name: 'mcp__collaboration__delegate_agent' }] }),
        },
      },
      resolvePromptForTools: (toolNames) => {
        seen.push(toolNames)
        return { systemPrompt: `工具: ${toolNames.join(',')}`, taskPrompt: '本轮 SOP' }
      },
    })

    const assembled = await resolvePiPreparedToolAssembly(input, {} as never)
    const applied = applyPiPreparedQuery(assembled)

    expect(seen).toEqual([['TaskCreate', 'mcp__collaboration__delegate_agent']])
    expect(applied.systemPrompt).toBe('工具: TaskCreate,mcp__collaboration__delegate_agent')
    expect(applied.taskPrompt).toBe('本轮 SOP')
  })

  test('没有 resolvePromptForTools 时行为不变（沿用 prepared.systemPrompt）', async () => {
    const input = options({
      prepared: {
        systemPrompt: '来自 prepared 的提示词',
        deferredToolAssembly: { build: async () => ({ tools: [{ name: 'Read' }] }) },
      },
    })
    const assembled = await resolvePiPreparedToolAssembly(input, {} as never)
    const applied = applyPiPreparedQuery(assembled)
    expect(applied.systemPrompt).toBe('来自 prepared 的提示词')
  })
})
