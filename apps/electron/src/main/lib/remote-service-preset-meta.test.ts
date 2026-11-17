/**
 * `session_detail` 必须把会话绑定的预设与工作区 slug 下发给移动端。
 *
 * 预设是工作区级配置：缺 slug 时客户端只能拿到内置默认配置，用户自建的岗位会凭空消失；
 * 缺 presetId/presetReference 时网页连「当前是哪个岗位」都显示不出来。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-preset-ws-'))
process.env.PROFER_CONFIG_DIR = sandbox

const { handleRemoteCommand } = await import('./remote-service')
const { createAgentSession, updateAgentSessionMeta } = await import('./agent-session-manager')
const { createAgentWorkspace } = await import('./agent-workspace-manager')

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

describe('session_detail 下发预设上下文', () => {
  test('Given 会话绑定了预设与工作区 When 取详情 Then 三个字段都在 meta 里', async () => {
    const workspace = createAgentWorkspace('预设详情工作区')
    const session = createAgentSession('预设详情', 'ch-preset')
    updateAgentSessionMeta(session.id, {
      workspaceId: workspace.id,
      presetId: 'preset-a',
      presetReference: {
        presetId: 'preset-a',
        presetScope: 'user-global',
        workspaceSlug: workspace.slug,
      } as never,
    })

    const result = await handleRemoteCommand(JSON.stringify({ type: 'session_detail', sessionId: session.id }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const meta = (result.data as { meta?: Record<string, unknown> }).meta
    expect(meta?.workspaceSlug).toBe(workspace.slug)
    expect(meta?.presetId).toBe('preset-a')
    expect((meta?.presetReference as { presetId?: string })?.presetId).toBe('preset-a')
  })

  test('Given 新会话没有显式绑定预设 When 取详情 Then 仍下发内置默认预设引用（不是缺字段）', async () => {
    const session = createAgentSession('无预设', 'ch-preset')
    const result = await handleRemoteCommand(JSON.stringify({ type: 'session_detail', sessionId: session.id }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const meta = (result.data as { meta?: Record<string, unknown> }).meta
    const reference = meta?.presetReference as { presetId?: string; presetScope?: string } | null
    expect(reference?.presetId).toBe('standard')
    expect(reference?.presetScope).toBe('builtin-meta')
  })
})
