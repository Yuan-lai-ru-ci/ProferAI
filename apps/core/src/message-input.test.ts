import { describe, expect, test } from 'bun:test'
import { parseCoreMessageOptions } from './message-input'
import { createRuntimeQuery } from './runtime'

const credential = { apiKey: 'test-only-key', provider: 'anthropic' as const, forceBearerAuth: false }

describe('Core 单轮请求白名单', () => {
  test('拒绝匿名凭据/作者声明，允许兼容的 prompt-only 请求', () => {
    expect(parseCoreMessageOptions({ prompt: 'hello' }, false)).toEqual({})
    expect(() => parseCoreMessageOptions({ credentials: credential }, false)).toThrow('authenticated_host_required')
    expect(() => parseCoreMessageOptions({ context: {} }, false)).toThrow('authenticated_host_required')
  })

  test('只接收白名单字段，拒绝无渠道凭据、无效 provider 与畸形 OAuth/身份，不回显敏感值', () => {
    expect(parseCoreMessageOptions({ channelId: 'new', credentials: credential, providerInput: { unsafe: true }, prepared: { tools: ['unsafe'] } }, true)).toEqual({
      channelId: 'new', credentials: { ...credential, baseUrl: undefined },
    })
    expect(() => parseCoreMessageOptions({ credentials: credential }, true)).toThrow('channel_required')
    expect(() => parseCoreMessageOptions({ channelId: 'new', credentials: { ...credential, provider: 'invalid-test-secret' } }, true)).toThrow('invalid credential provider')
    expect(() => parseCoreMessageOptions({ channelId: 'new', credentials: { ...credential, xaiOAuthCredentials: {} } }, true)).toThrow('invalid OAuth credentials')
    expect(() => parseCoreMessageOptions({ context: { trigger: { schemaVersion: 1, id: 't', createdAt: 1, kind: 'user_message', actor: { type: 'forged' } } } }, true)).toThrow('invalid message option type')
  })

  test('本轮覆盖历史渠道/模型，未声明来源的外部输入不能冒充当前用户', () => {
    const session = { id: 's', title: 'old', createdAt: 1, updatedAt: 1, agentRuntime: 'pi' as const, channelId: 'removed', modelId: 'old' }
    const input = parseCoreMessageOptions({ channelId: 'new', modelId: 'new-model', uuid: 'message-1', rawUserMessage: 'display', credentials: credential }, true)
    const query = createRuntimeQuery(session, 'prompt', undefined, input)
    expect(query).toMatchObject({ channelId: 'new', modelId: 'new-model', prepared: { credentials: credential }, persistedUserMessage: { uuid: 'message-1', message: { content: [{ type: 'text', text: 'display' }] } } })
    expect(query.context?.trigger.actor).toEqual({ type: 'external' })
    expect(query.context?.trigger.id).toBe('message:s:message-1')
  })
})
