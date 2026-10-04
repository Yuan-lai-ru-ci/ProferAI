import { describe, expect, test } from 'bun:test'
import { isSummaryOnlyPiReasoning, shouldShowAgentThinking } from './reasoning-profile'

describe('Pi 内核思考可见性判定', () => {
  test('Given Claude 内核 When 判定是否展示思考 Then 任意渠道都展示', () => {
    expect(shouldShowAgentThinking({ agentRuntime: 'claude', provider: 'openai-codex', modelId: 'gpt-5.6-sol' })).toBe(true)
    expect(shouldShowAgentThinking({ agentRuntime: 'claude', provider: 'deepseek', modelId: 'deepseek-flash' })).toBe(true)
  })

  test('Given Pi 内核 + 可读思维链渠道 When 判定 Then 展示思考（历史上一刀切被隐藏）', () => {
    // DeepSeek / Kimi / MiniMax 走 Anthropic 兼容端点，返回完整 CoT。
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'deepseek', modelId: 'deepseek-flash' })).toBe(true)
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'kimi-api', modelId: 'kimi-k3' })).toBe(true)
    // Qwen / GLM / 豆包走 Completions，同样是可读 CoT。
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'qwen', modelId: 'qwen3.8' })).toBe(true)
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'zhipu', modelId: 'glm-5.3' })).toBe(true)
  })

  test('Given Pi 内核 + OpenAI Responses 系 When 判定 Then 隐藏只有摘要的 thinking', () => {
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'openai-codex', modelId: 'gpt-5.6-sol' })).toBe(false)
  })

  test('Given Pi 内核 + 官方 GPT 渠道 When 判定 Then 隐藏摘要', () => {
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'openai', modelId: 'gpt-6-astra' })).toBe(false)
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'openai-responses', modelId: 'gpt-5.6-terra' })).toBe(false)
    // xAI Grok 同样不暴露思维链正文，只有摘要。
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'xai', modelId: 'grok-4.6' })).toBe(false)
  })

  test('Given 自建网关承载官方 GPT 模型 When 判定 Then 仍按摘要处理', () => {
    expect(isSummaryOnlyPiReasoning('custom', 'gpt-4o')).toBe(true)
    expect(isSummaryOnlyPiReasoning('custom', 'openai/gpt-5.6-sol')).toBe(true)
    // 未识别渠道按同一模型 ID 兜底。
    expect(isSummaryOnlyPiReasoning(undefined, 'o4-mini')).toBe(true)
  })

  test('Given 自建网关承载国产可读 CoT 模型 When 判定 Then 展示思考', () => {
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'custom', modelId: 'deepseek-v4-pro' })).toBe(true)
    expect(shouldShowAgentThinking({ agentRuntime: 'pi', provider: 'custom', modelId: 'glm-4.7' })).toBe(true)
    expect(isSummaryOnlyPiReasoning(undefined, 'deepseek-flash')).toBe(false)
  })

  test('Given 无内核信息 When 判定 Then 展示思考（非 Pi 语义）', () => {
    expect(shouldShowAgentThinking({ provider: 'deepseek', modelId: 'deepseek-flash' })).toBe(true)
  })
})
