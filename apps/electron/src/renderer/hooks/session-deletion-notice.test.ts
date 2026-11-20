import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// 执行真实handler片段，覆盖toast重试/去重与跨Core保护；不启动UI或真实删除。
const source = readFileSync(new URL('./useGlobalAgentListeners.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const start = source.indexOf("        if (payload.kind === 'session_deletion') {")
const end = source.indexOf("        if (payload.kind === 'session_projection')", start)
if (start < 0 || end < start) throw new Error('删除状态handler不存在')
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(`function receive(payload) { ${source.slice(start, end)} }; return receive`)

test('删除失败显示一次可重试提示，切Core后旧按钮不发送删除', async () => {
  let generation = 1
  const errors: Array<{ message: string; options?: { action?: { onClick(): void }; duration?: number } }> = []
  const dismissed: string[] = [], deleted: string[] = []
  const receive = new Function('store', 'coreTargetsAtom', 'deletionRevisions', 'toast', 'window', script)(
    { get: () => ({ generation }) }, {}, new Map(),
    { error: (message: string, options?: object) => errors.push({ message, options }), dismiss: (id: string) => dismissed.push(id) },
    { electronAPI: { deleteAgentSession: async (id: string) => { deleted.push(id) } } },
  ) as (payload: object) => void
  const failure = { kind: 'session_deletion', requestId: 'request', sessionId: 'core:owner:raw', title: 'fixture', status: 'failed', revision: 2, error: 'stop did not drain' }
  receive(failure); receive(failure)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.options?.duration).toBe(Infinity)
  errors[0]?.options?.action?.onClick()
  expect(deleted).toEqual(['core:owner:raw'])
  generation++
  errors[0]?.options?.action?.onClick()
  expect(deleted).toHaveLength(1)
  expect(errors[1]?.message).toContain('已切换Core')
  receive({ ...failure, status: 'pending', revision: 3 })
  expect(dismissed).toEqual(['session-deletion:request'])
})
