import type { WebContents } from 'electron'

/** 每个目标窗口独立托管，不广播；remote 投影在 commit 前保持原始到达顺序。 */
const buffers = new Map<number, { sessionId: string; events: Array<{ channel: string; payload: unknown }> }>()
export function beginWindowHandoff(id: number, sessionId: string): void { buffers.set(id, { sessionId, events: [] }) }
export function isSessionWindowHandoff(id: number, sessionId: string): boolean { return buffers.get(id)?.sessionId === sessionId }
export function hasWindowHandoff(id: number): boolean { return buffers.has(id) }
export function sendCoreWindowEvent(target: WebContents, channel: string, payload?: unknown): void {
  const buffer = buffers.get(target.id)
  if (buffer && payload && typeof payload === 'object' && 'sessionId' in payload && payload.sessionId === buffer.sessionId) buffer.events.push({ channel, payload })
  else if (!target.isDestroyed()) target.send(channel, payload)
}
export function finishWindowHandoff(target: WebContents, commit: boolean): void {
  const buffer = buffers.get(target.id)
  buffers.delete(target.id)
  if (commit && !target.isDestroyed()) for (const event of buffer?.events ?? []) target.send(event.channel, event.payload)
}
