import { describe, expect, test } from 'bun:test'

// 只验证 Pi 侧 AskUserQuestion 工具注册契约与权限包装闭环，不启动真实 Pi SDK。
const { buildPromaProductToolDefinitions, shouldBlockToolForAskUserQuestion } = await import('./pi-agent-adapter')

interface CapturedTool {
  name: string
  label?: string
  description: string
  promptSnippet?: string
  parameters?: unknown
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

interface AskUserToolResult {
  content: Array<{ text: string }>
  details?: { answers?: Record<string, string> }
}

describe('Pi AskUserQuestion 提问闭环（工具注册契约）', () => {
  test('Given a mixed tool batch containing AskUserQuestion When checking a later tool Then blocks it until the user responds', () => {
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion', 'Bash'], 'Bash')).toBe(true)
    expect(shouldBlockToolForAskUserQuestion(['AskUserQuestion', 'Bash'], 'AskUserQuestion')).toBe(false)
    expect(shouldBlockToolForAskUserQuestion(['Bash'], 'Bash')).toBe(false)
  })

  test('Given Pi runtime When building Proma product tools Then AskUserQuestion is registered with the interactive question schema', () => {
    const { sdk } = createPiSdkStub()

    const definitions = buildPromaProductToolDefinitions(sdk, async () => ({ behavior: 'allow' }))

    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    expect(askUser).toBeDefined()
    expect(askUser?.label).toBe('询问用户')
    expect(askUser?.description).toContain('问答横幅')
  })

  test('Given 用户回答注入 answers When AskUserQuestion executes Then 统一 canUseTool 被调用且答案返回给模型', async () => {
    const { sdk } = createPiSdkStub()
    const calls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID: string; displayName: string }> = []

    const definitions = buildPromaProductToolDefinitions(sdk, async (toolName, input, options) => {
      calls.push({
        toolName,
        input,
        toolUseID: options.toolUseID ?? '',
        displayName: options.displayName ?? '',
      })
      // 模拟 agent-ask-user-service 在用户回答后注入 answers 的 updatedInput
      return { behavior: 'allow', updatedInput: { ...input, answers: { q1: '选项 A' } } }
    })

    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    const result = await askUser?.execute?.('call-1', {
      questions: [{ question: '选择哪个方向？' }],
    }) as AskUserToolResult

    // 权限分派走统一 canUseTool，工具名保持 AskUserQuestion 以便编排器拦截
    expect(calls).toHaveLength(1)
    expect(calls[0]?.toolName).toBe('AskUserQuestion')
    expect(calls[0]?.toolUseID).toBe('call-1')
    expect(calls[0]?.displayName).toBe('询问用户')

    // 注入的 answers 经 restorePiInput 合并进参数，工具结果把答案交还模型
    const payload = JSON.parse(result.content[0]!.text) as { answers: Record<string, string> }
    expect(payload.answers.q1).toBe('选项 A')
    expect(result.details?.answers?.q1).toBe('选项 A')
  })

  test('Given 用户未回答即拒绝 When AskUserQuestion executes Then 抛出拒绝消息并中断工具执行', async () => {
    const { sdk } = createPiSdkStub()

    const definitions = buildPromaProductToolDefinitions(sdk, async () => ({
      behavior: 'deny',
      message: '用户取消回答',
    }))

    const askUser = (definitions as unknown as CapturedTool[]).find((tool) => tool.name === 'AskUserQuestion')
    await expect(
      askUser?.execute?.('call-2', { questions: [{ question: '继续吗？' }] }),
    ).rejects.toThrow('用户取消回答')
  })
})
