export class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`请求体超过 ${maxBytes} 字节限制`)
    this.name = 'BodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

export function isBodyTooLargeError(error) {
  return error instanceof BodyTooLargeError
}

/**
 * 用实际流量包装 Request body，避免仅依赖可伪造/缺失的 Content-Length。
 * 不读取或解析 body；下游仍可正常调用 request.json()/text()。
 */
export function limitRequestBody(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes 必须为非负安全整数')
  }
  if (!request.body) return request

  const reader = request.body.getReader()
  let received = 0
  const limitedBody = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        const size = value?.byteLength ?? 0
        received += size
        if (received > maxBytes) {
          const error = new BodyTooLargeError(maxBytes)
          await reader.cancel(error).catch(() => {})
          controller.error(error)
          return
        }
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {})
    },
  })

  return new Request(request, { body: limitedBody, duplex: 'half' })
}

/** 只把可信的、超限的 Content-Length 用作快速拒绝。 */
export function contentLengthExceedsLimit(value, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return false
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return false
  const length = Number(value)
  return Number.isSafeInteger(length) && length > maxBytes
}
