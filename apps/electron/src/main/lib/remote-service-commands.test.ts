import { describe, expect, test } from 'bun:test'
import { handleRemoteCommand } from './remote-service'

/**
 * 远程 WS 命令的功能级验证（不替代真机验收）。
 *
 * 覆盖本包新增/改动且**不依赖真实会话数据**的分支：参数校验、命令可达性、
 * 以及旧端兼容（未知指令仍返回原错误文案）。
 */
describe('remote-service 新增 WS 命令', () => {
  test('get_pi_reasoning_capability：缺少 provider 时报错', async () => {
    const result = await handleRemoteCommand(JSON.stringify({ type: 'get_pi_reasoning_capability' }), 1)
    expect(result).toEqual({ ok: false, error: '缺少 provider' })
  })

  test('get_pi_reasoning_capability：返回已 await 的能力对象（而非 Promise）', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'get_pi_reasoning_capability', provider: 'zhipu', modelId: 'glm-5.3' }),
      1,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { source?: unknown; levels?: unknown; defaultLevel?: unknown } | undefined
    // 关键回归：resolvePiReasoningCapability 是异步的，未 await 时 data 会是 Promise 并被序列化成 {}。
    expect(data === undefined || typeof (data as { then?: unknown }).then !== 'function').toBe(true)
    expect(Array.isArray(data?.levels)).toBe(true)
    expect(data?.levels as string[]).toContain('off')
    expect(data?.levels as string[]).toContain('high')
    expect(typeof data?.defaultLevel).toBe('string')
  })

  test('get_pi_reasoning_capability：无档位能力的 provider 返回 undefined 而非报错', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({ type: 'get_pi_reasoning_capability', provider: 'google', modelId: 'gemini-3-pro' }),
      1,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toBeUndefined()
  })

  test('search_workspace_files：缺少 sessionId 时报错，且不接受客户端 roots', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({
        type: 'search_workspace_files',
        rootPath: 'C:/',
        candidateBasePaths: ['C:/'],
        query: '',
      }),
      1,
    )
    expect(result).toEqual({ ok: false, error: '缺少 sessionId' })
  })

  test('search_workspace_files：未知会话返回错误（客户端 roots 不参与授权）', async () => {
    const result = await handleRemoteCommand(
      JSON.stringify({
        type: 'search_workspace_files',
        sessionId: '__profer_nonexistent_session_for_test__',
        rootPath: 'C:/',
        query: 'a',
      }),
      1,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('会话不存在或未绑定工作区')
  })

  test('send_message：缺少必填参数时仍按原语义报错（未启动 run）', async () => {
    const result = await handleRemoteCommand(JSON.stringify({ type: 'send_message', sessionId: 'x', userMessage: 'y' }), 1)
    expect(result).toEqual({ ok: false, error: '缺少 channelId（无法确定 API Key）' })
  })

  test('旧端兼容：未知指令仍返回 {ok:false,error:"未知指令: ..."}', async () => {
    const result = await handleRemoteCommand(JSON.stringify({ type: '__profer_unknown_command__' }), 1)
    expect(result).toEqual({ ok: false, error: '未知指令: __profer_unknown_command__' })
  })
})
