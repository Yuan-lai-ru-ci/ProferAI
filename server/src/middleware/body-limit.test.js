import { describe, expect, test } from 'bun:test'
import { BodyTooLargeError, contentLengthExceedsLimit, isBodyTooLargeError, limitRequestBody } from './body-limit.js'

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

describe('流式请求体限额', () => {
  test('Given 分块 body 未超过限制 When 下游读取 Then 原始内容完整通过', async () => {
    const request = new Request('http://test.local/', { method: 'POST', body: streamFromChunks(['ab', 'cd']), duplex: 'half' })
    expect(await limitRequestBody(request, 4).text()).toBe('abcd')
  })

  test('Given 无 Content-Length 的分块 body 超限 When 下游读取 Then 抛出可识别错误', async () => {
    const request = new Request('http://test.local/', { method: 'POST', body: streamFromChunks(['ab', 'cde']), duplex: 'half' })
    await expect(limitRequestBody(request, 4).text()).rejects.toBeInstanceOf(BodyTooLargeError)
  })

  test('Given 空 body 或非法 limit When 包装 Then 空 body 保持且非法配置被拒绝', () => {
    const request = new Request('http://test.local/', { method: 'GET' })
    expect(limitRequestBody(request, 1)).toBe(request)
    expect(() => limitRequestBody(request, -1)).toThrow(TypeError)
  })

  test('Given Content-Length When 判断快速拒绝 Then 仅可信整数超限才拒绝', () => {
    expect(contentLengthExceedsLimit('5', 4)).toBe(true)
    expect(contentLengthExceedsLimit('4', 4)).toBe(false)
    expect(contentLengthExceedsLimit('4.5', 4)).toBe(false)
    expect(contentLengthExceedsLimit('-1', 4)).toBe(false)
    expect(isBodyTooLargeError(new BodyTooLargeError(1))).toBe(true)
  })
})
