import { randomUUID } from 'node:crypto'

/** 仅管理渠道测试/发现；按窗口和请求隔离，不持有凭据或 URL。 */
interface RequestSender {
  id: number
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

function assertRequestId(requestId: string): void {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('渠道请求标识无效')
}

export class ChannelNetworkRequests {
  private readonly requests = new Map<number, Map<string, AbortController>>()

  async run<T>(sender: RequestSender, requestId: string | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (requestId !== undefined) assertRequestId(requestId)
    if (sender.isDestroyed()) throw new Error('渠道请求窗口已关闭')
    const id = requestId ?? randomUUID()
    let active = this.requests.get(sender.id)
    if (!active) { active = new Map(); this.requests.set(sender.id, active) }
    if (active.has(id)) throw new Error('渠道请求标识已在使用')
    const controller = new AbortController()
    active.set(id, controller)
    const onDestroyed = () => controller.abort()
    sender.once('destroyed', onDestroyed)
    try {
      return await operation(controller.signal)
    } finally {
      sender.removeListener('destroyed', onDestroyed)
      active.delete(id)
      if (active.size === 0) this.requests.delete(sender.id)
    }
  }

  cancel(senderId: number, requestId: string): void {
    assertRequestId(requestId)
    this.requests.get(senderId)?.get(requestId)?.abort()
  }
}
