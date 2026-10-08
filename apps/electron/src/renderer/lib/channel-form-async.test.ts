import { describe, expect, test } from 'bun:test'
import { buildChannelDraftPatch, createSerialDraftQueue, isCurrentAsyncRequest, usesOAuthCredentials, validateChannelCreation } from './channel-form-async'
import type { ChannelCreateInput } from '@profer/shared'

describe('渠道表单异步控制', () => {
  test('连续输入只串行保存最新草稿，flush 会等待所有写入', async () => {
    const saved: string[] = []
    let release: (() => void) | undefined
    const first = new Promise<void>((resolve) => { release = resolve })
    const queue = createSerialDraftQueue(async (draft: string) => {
      if (draft === 'a') await first
      saved.push(draft)
    })
    queue.replace('a')
    const flushing = queue.flush()
    queue.replace('b')
    expect(saved).toEqual([])
    release?.()
    await flushing
    expect(saved).toEqual(['a', 'b'])
    expect(queue.hasPending()).toBe(false)
  })

  test('写入失败保留草稿，下一次 flush 可以重试', async () => {
    let attempts = 0
    const queue = createSerialDraftQueue(async (draft: string) => {
      attempts += 1
      if (attempts === 1) throw new Error(`failed:${draft}`)
    })
    queue.replace('retry-me')
    await expect(queue.flush()).rejects.toThrow('failed:retry-me')
    expect(queue.hasPending()).toBe(true)
    await queue.flush()
    expect(attempts).toBe(2)
    expect(queue.hasPending()).toBe(false)
  })

  test('明确丢弃只取消排队草稿，不会在 flush 中重新保存', async () => {
    const saved: string[] = []
    const queue = createSerialDraftQueue(async (draft: string) => { saved.push(draft) })
    queue.replace('discarded')
    queue.cancel()
    await queue.flush()
    expect(saved).toEqual([])
  })


  test('两个 flush 共享同一 drain，等待第二份草稿而非提前结束', async () => {
    const releases: Array<() => void> = []
    const saved: string[] = []
    const queue = createSerialDraftQueue(async (draft: string) => {
      saved.push(draft)
      await new Promise<void>((resolve) => releases.push(resolve))
    })
    queue.replace('first')
    const first = queue.flush()
    queue.replace('second')
    const second = queue.flush()
    expect(first).toBe(second)
    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(saved).toEqual(['first', 'second'])
    expect(queue.hasPending()).toBe(true)
    releases.shift()?.()
    await Promise.all([first, second])
    expect(queue.hasPending()).toBe(false)
  })

  test('在途失败后不会复活已丢弃草稿；settle 只等待，不写队列', async () => {
    let reject!: (reason: Error) => void
    const calls: string[] = []
    const queue = createSerialDraftQueue(async (draft: string) => {
      calls.push(draft)
      await new Promise<void>((_resolve, no) => { reject = no })
    })
    queue.replace('sent')
    const sent = queue.flush().catch(() => {})
    queue.replace('discarded')
    queue.cancel()
    const settled = queue.settle()
    reject(new Error('fixture-failure'))
    await Promise.all([sent, settled])
    await queue.flush()
    expect(calls).toEqual(['sent'])
    expect(queue.hasPending()).toBe(false)
  })

  test('失败期间新草稿优先于旧草稿，成功后 flush 不重复写', async () => {
    let reject!: (reason: Error) => void
    let first = true
    const calls: string[] = []
    const queue = createSerialDraftQueue(async (draft: string) => {
      calls.push(draft)
      if (first) {
        first = false
        await new Promise<void>((_resolve, no) => { reject = no })
      }
    })
    queue.replace('old')
    const sent = queue.flush().catch(() => {})
    queue.replace('latest')
    reject(new Error('fixture-failure'))
    await sent
    await queue.flush()
    await queue.flush()
    expect(calls).toEqual(['old', 'latest'])
  })

  test('普通字段增量不会重传已保存 key，包括 OAuth 与其它窗口替换', () => {
    expect(buildChannelDraftPatch({ name: 'old', apiKey: 'fixture-key' }, { name: 'new', apiKey: 'fixture-key' })).toEqual({ name: 'new' })
    expect(buildChannelDraftPatch({ name: 'old' }, { name: 'new', apiKey: undefined })).toEqual({ name: 'new' })
    expect(buildChannelDraftPatch({ apiKey: 'old' }, { apiKey: 'new' })).toEqual({ apiKey: 'new' })
    expect(usesOAuthCredentials('openai-codex', undefined)).toBe(true)
    expect(usesOAuthCredentials('xai', 'oauth')).toBe(true)
    expect(usesOAuthCredentials('xai', 'api-key')).toBe(false)
  })

  test('创建统一校验拒绝无模型、全禁用、空名称/地址/凭据，允许 Ollama 与 OAuth 无普通 Key', () => {
    const input: ChannelCreateInput = { name: 'Fixture', provider: 'openai', baseUrl: 'https://fixture.invalid', apiKey: 'fixture-key', models: [{ id: 'model', name: 'Model', enabled: true }], enabled: true }
    expect(validateChannelCreation(input)).toBeNull()
    expect(validateChannelCreation({ ...input, models: [] })).not.toBeNull()
    expect(validateChannelCreation({ ...input, models: [{ ...input.models[0]!, enabled: false }] })).not.toBeNull()
    expect(validateChannelCreation({ ...input, name: ' ' })).not.toBeNull()
    expect(validateChannelCreation({ ...input, baseUrl: ' ' })).not.toBeNull()
    expect(validateChannelCreation({ ...input, apiKey: ' ' })).not.toBeNull()
    expect(validateChannelCreation({ ...input, provider: 'ollama', apiKey: '' })).toBeNull()
    expect(validateChannelCreation({ ...input, provider: 'xai', credentialMode: 'oauth', apiKey: '' })).toBeNull()
    expect(validateChannelCreation({ ...input, provider: 'openai-codex', baseUrl: '', apiKey: '' })).toBeNull()
  })
  test('旧请求返回时必须同时满足 request id 和配置 key', () => {
    expect(isCurrentAsyncRequest(2, 2, 'provider=b', 'provider=b')).toBe(true)
    expect(isCurrentAsyncRequest(1, 2, 'provider=a', 'provider=b')).toBe(false)
    expect(isCurrentAsyncRequest(2, 2, 'provider=a', 'provider=b')).toBe(false)
  })
})
