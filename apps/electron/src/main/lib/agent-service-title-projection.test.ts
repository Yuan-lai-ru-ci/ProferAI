import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * 自动标题「UI 投影」调用点守卫。
 *
 * 标题生成在终态之后的后台任务里完成（`setImmediate` + 标题模型请求），此时
 * `finishActiveStreamBacklog` 已删除 `sessionWebContents` 里的会话绑定。只按绑定表直发
 * `TITLE_UPDATED` 会被静默丢弃，UI 只能等下一次全量列表刷新，于是左侧列表（读会话 meta）
 * 与顶栏 Tab（读打开时的快照）长期不一致。
 *
 * 判据在调用点而不在纯策略层，因此用源码结构断言钉住：三处 `onTitleUpdated` 都必须补发一次
 * 不依赖绑定的 `session_projection`。
 */

async function readAgentService(): Promise<string> {
  return (await Bun.file(join(import.meta.dir, 'agent-service.ts')).text()).replace(/\r\n/g, '\n')
}

describe('自动标题更新的 UI 投影', () => {
  test('Given 标题更新晚于 run 结束 When 检查投影 helper Then 它按广播通道发布 session_projection', async () => {
    const source = await readAgentService()
    const helperFrom = source.indexOf('function publishTitleUpdateProjection(sessionId: string): void {')
    expect(helperFrom).toBeGreaterThan(-1)
    const helper = source.slice(helperFrom, source.indexOf('\n}\n', helperFrom))

    // 未接线（单测 / 非 Electron 宿主）时静默跳过，不能因为投影抛错影响标题落盘。
    expect(helper).toContain('hasAgentSessionProjectionPublisher()')
    expect(helper).toContain('publishAgentSessionProjection(meta)')
    // 会话已被删除（meta 缺失）时不得凭空造事件。
    expect(helper).toContain('if (meta)')
  })

  test('Given 三条桌面链 When 标题写回 Then 都要补发投影（不依赖 sessionWebContents 绑定）', async () => {
    const source = await readAgentService()
    const callSites = source.match(/publishTitleUpdateProjection\((?:sessionId|input\.sessionId|runInput\.sessionId)\)/g) ?? []
    // runtime 桌面链 + 旧编排链 + headless 链
    expect(callSites).toHaveLength(3)
    expect(source).toContain('publishTitleUpdateProjection(sessionId)')
    expect(source).toContain('publishTitleUpdateProjection(input.sessionId)')
    expect(source).toContain('publishTitleUpdateProjection(runInput.sessionId)')
  })

  test('Given 标题事件仍要发给浏览器与 Pocket When 检查调用顺序 Then 先发事件再补投影', async () => {
    const source = await readAgentService()
    const runtimeNamingFrom = source.indexOf('function buildRuntimeTitleNaming(')
    const runtimeNaming = source.slice(runtimeNamingFrom, source.indexOf('\n}\n', runtimeNamingFrom) + 3)
    const emitAt = runtimeNaming.indexOf("event: { type: 'title_updated', title }")
    const projectionAt = runtimeNaming.indexOf('publishTitleUpdateProjection(sessionId)')
    expect(emitAt).toBeGreaterThan(-1)
    expect(projectionAt).toBeGreaterThan(emitAt)
  })
})
