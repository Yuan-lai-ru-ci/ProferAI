import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SessionDeletionRequest } from './agent-session-deletion-queue'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function transferLegacySessionDeletions(')
const end = source.indexOf('\nlet remoteExitComplete', start)
if (start < 0 || end < start) throw new Error('旧删除交接启动入口不存在')
const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
function harness(requests: SessionDeletionRequest[], send: (input: Record<string, unknown>) => Promise<unknown>) {
  const ack: SessionDeletionRequest[][] = [], errors: unknown[][] = []
  const run = new Function('listSessionDeletionRequestsForTransfer', 'acknowledgeTransferredSessionDeletions', 'console', `${js}; return transferLegacySessionDeletions`)(
    () => structuredClone(requests), (values: SessionDeletionRequest[]) => ack.push(values), { error: (...args: unknown[]) => errors.push(args) },
  ) as (client: object) => Promise<void>
  return { ack, errors, run: () => run({ importLegacyDeletion: send }) }
}
const request = (id: string): SessionDeletionRequest => ({ id, sessionId: id, sessionIds: [id], requestedAt: 10, reason: 'user', attempts: 1 })

test('启动交接仅ACK持久确认且快照完全一致的请求，失败/范围变化保留源请求', async () => {
  const requests = [request('accepted'), request('failed'), request('mismatched')]
  const sent: unknown[] = []
  const h = harness(requests, async input => {
    sent.push(input)
    if (input.sourceRequestId === 'failed') throw new Error('Core unavailable')
    return { requestId: 'core-id', sessionIds: input.sourceRequestId === 'mismatched' ? ['different'] : input.sessionIds }
  })
  await h.run()
  expect(h.ack).toEqual([[requests[0]!]])
  expect(sent).toHaveLength(3)
  expect(sent[0]).toMatchObject({ sourceRequestId: 'accepted', sessionIds: ['accepted'], reason: 'user', requestedAt: 10 })
  expect(h.errors).toHaveLength(2)
})

test('重复交接无需Core可见列表，已隐藏/完成的请求仍可收到同一ACK', async () => {
  const h = harness([request('completed')], async input => ({ requestId: 'stable', sessionIds: input.sessionIds }))
  await h.run(); await h.run()
  expect(h.ack).toHaveLength(2)
  expect(h.ack[0]).toEqual(h.ack[1])
})
